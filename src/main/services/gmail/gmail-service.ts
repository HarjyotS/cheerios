/**
 * Gmail service.
 *
 * Spec §13. Builds a draft message in the user's Gmail account based on a
 * meeting and a follow-up template kind. We always create a *draft* —
 * never a sent message. The user opens it in Gmail, reads it, edits it,
 * and clicks send themselves.
 *
 * If the AI engine has already generated note.follow_up_email we use that
 * verbatim. Otherwise we synthesize a reasonable default from the
 * summary + action items so the feature still works without the AI being
 * fully wired.
 */

import { google } from 'googleapis';
import type { ID } from '@shared/types/entities';
import type { GoogleAuthManager } from '../google/auth';
import { Meetings, GeneratedNotes, People } from '@main/db/repositories';
import { services } from '@main/lib/service-registry';
import { log } from '@main/lib/logger';

const logger = log('gmail');

export type FollowUpKind = 'thank_you' | 'sales' | 'investor' | 'research' | 'recruiting' | 'recap' | 'intro';

export class GmailService {
  constructor(private auth: GoogleAuthManager) {}

  status(): { connected: boolean; account?: string } {
    return { connected: this.auth.isConnected(), account: this.auth.account() };
  }

  async connect(): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    return this.auth.authorize('gmail');
  }

  async draftFollowUp(meetingId: ID, kind: FollowUpKind): Promise<{ draftId: string; url: string }> {
    const meeting = Meetings.get(meetingId);
    if (!meeting) throw new Error('Meeting not found: ' + meetingId);

    const auth = await this.auth.getOAuth2Client();
    if (!auth) throw new Error('Gmail not connected');
    const gmail = google.gmail({ version: 'v1', auth });

    // Try to use the note's existing follow_up_email; if missing, ask the
    // AI engine to produce one. If even that fails, synthesize a basic
    // template from the summary + action items.
    let note = GeneratedNotes.get(meetingId);
    if (!note?.follow_up_email && services.ai) {
      try {
        const transformed = await services.ai.transformNote(meetingId, 'follow_up_email');
        if (transformed) note = transformed;
      } catch (e) {
        logger.warn('AI transform failed, falling back to template', { error: String(e) });
      }
    }
    note = GeneratedNotes.get(meetingId) ?? note;

    const body = note?.follow_up_email?.trim() || synthesizeFollowUp(kind, meeting.title, note);
    const subject = subjectFor(kind, meeting.title);
    const recipients = meeting.attendees
      .map((id) => People.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p && p.email))
      .map((p) => `"${escapeName(p.name)}" <${p.email}>`);

    const raw = buildRfc2822({
      to: recipients,
      subject,
      bodyText: body,
    });

    const created = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw: encodeBase64Url(raw) },
      },
    });

    const draftId = created.data.id ?? '';
    if (!draftId) throw new Error('Gmail did not return a draft id');

    // Gmail web's deep-link format for drafts uses the message id, not the
    // draft id. Their #drafts/<id> hash works with either in practice;
    // we hand back the draft id which is what the user typically sees.
    const url = `https://mail.google.com/mail/u/0/#drafts/${draftId}`;
    logger.info('draft created', { meetingId, kind, draftId, recipients: recipients.length });
    return { draftId, url };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subjectFor(kind: FollowUpKind, title: string): string {
  const stem = title.trim() || 'our conversation';
  switch (kind) {
    case 'thank_you': return `Thanks for the time today — ${stem}`;
    case 'sales': return `Following up on ${stem}`;
    case 'investor': return `Recap and next steps — ${stem}`;
    case 'research': return `Quick recap from ${stem}`;
    case 'recruiting': return `Following up — ${stem}`;
    case 'intro': return `Intro and recap — ${stem}`;
    case 'recap':
    default:
      return `Re: ${stem}`;
  }
}

function synthesizeFollowUp(kind: FollowUpKind, title: string, note?: { summary?: string; action_items?: Array<{ task: string; owner: string }> } | null): string {
  const lines: string[] = [];
  const opener = ({
    thank_you: 'Thanks again for taking the time today',
    sales: 'Great chatting today',
    investor: 'Thanks for the time today',
    research: 'Thanks for the conversation',
    recruiting: 'Thanks for the chat',
    recap: 'Quick recap from our conversation',
    intro: 'Great to meet you',
  } as const)[kind] ?? 'Thanks for the time today';

  lines.push(`Hi,`);
  lines.push('');
  lines.push(`${opener}${title ? ` re: ${title}` : ''}.`);
  lines.push('');

  if (note?.summary) {
    lines.push('Summary:');
    lines.push(note.summary.trim());
    lines.push('');
  }

  const actionItems = (note?.action_items ?? []).filter((a) => a.task);
  if (actionItems.length) {
    lines.push('Next steps:');
    for (const a of actionItems) {
      lines.push(`- ${a.task}${a.owner && a.owner !== 'me' ? ` (${a.owner})` : ''}`);
    }
    lines.push('');
  }

  lines.push('Let me know if anything looks off.');
  lines.push('');
  lines.push('Thanks,');
  return lines.join('\n');
}

function buildRfc2822(args: { to: string[]; subject: string; bodyText: string }): string {
  // RFC 2822 message. Gmail accepts plain text bodies just fine; we declare
  // the charset so non-ASCII characters survive round trips.
  const headers: string[] = [];
  if (args.to.length) headers.push(`To: ${args.to.join(', ')}`);
  headers.push(`Subject: ${encodeHeader(args.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 8bit');
  return headers.join('\r\n') + '\r\n\r\n' + args.bodyText;
}

function encodeHeader(s: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

function encodeBase64Url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeName(s: string): string {
  return s.replace(/"/g, '\\"');
}

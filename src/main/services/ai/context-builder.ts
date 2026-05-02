/**
 * Assembles all the inputs the note-generation prompt needs:
 *  - the meeting itself
 *  - final, non-deleted transcript chunks
 *  - raw notes
 *  - the resolved template (auto-pick or fallback to "General Meeting")
 *  - attendee names
 *  - optional digests of the most recent prior meetings sharing attendees
 *
 * Keeping this here means note-engine.ts stays focused on orchestration and
 * prompts.ts stays focused on text construction.
 */
import {
  Meetings,
  TranscriptChunks,
  GeneratedNotes,
  ActionItems,
  Templates,
  People,
} from '@main/db/repositories';
import { TemplatesService } from '@main/services/templates/templates-service';
import type { Meeting, Template, TranscriptChunk, ID, Settings } from '@shared/types/entities';
import type { NotePromptInput, PreviousMeetingDigest } from './prompts';

// --------------------------------------------------------------------------
// Defaults — fallback template when none matches.
// --------------------------------------------------------------------------

function fallbackTemplate(): Template {
  return (
    Templates.byName('General Meeting') ??
    // Hard-coded last-resort if the seed template is missing.
    ({
      id: 'tpl_default',
      name: 'General Meeting',
      description: 'Generic meeting template',
      when_to_use: 'Default for any meeting',
      required_sections: ['Summary', 'Discussion', 'Decisions', 'Action Items'],
      optional_sections: ['Open Questions', 'Risks', 'Quotes'],
      formatting_rules: '',
      action_item_format: '',
      follow_up_style: '',
      auto_apply_rules: [],
      builtin: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as Template)
  );
}

// --------------------------------------------------------------------------
// Public helper used by note-engine.
// --------------------------------------------------------------------------

export interface BuildContextOpts {
  meetingId: ID;
  templateId?: ID;
  tone?: string;
  length?: 'short' | 'medium' | 'detailed';
  settings: Settings;
}

export function buildNoteContext(opts: BuildContextOpts): NotePromptInput {
  const meeting = Meetings.get(opts.meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${opts.meetingId}`);

  // Pick template: explicit id wins, then auto-rules via TemplatesService,
  // then "General Meeting" fallback.
  let template: Template | null = null;
  if (opts.templateId) template = Templates.get(opts.templateId);
  if (!template) template = new TemplatesService().pickForMeeting(meeting.id);
  if (!template) template = fallbackTemplate();

  // Only final, non-deleted chunks count for note generation.
  const chunks = TranscriptChunks.listByMeeting(meeting.id).filter(
    (c: TranscriptChunk) => c.is_final && !c.is_deleted,
  );

  const attendeeNames = meeting.attendees
    .map((id) => People.get(id)?.name)
    .filter((x): x is string => Boolean(x));

  const previousMeetings: PreviousMeetingDigest[] = opts.settings.include_previous_meeting_context
    ? collectPreviousMeetings(meeting)
    : [];

  return {
    meeting,
    template,
    chunks,
    rawNotes: meeting.raw_notes ?? '',
    settings: opts.settings,
    attendeeNames,
    previousMeetings,
    tone: opts.tone,
    length: opts.length,
  };
}

/**
 * Collect up to 3 prior meetings sharing at least one attendee with this
 * meeting. Returns lightweight digests — we only need a sentence or two of
 * recall, not the full transcript.
 */
function collectPreviousMeetings(meeting: Meeting): PreviousMeetingDigest[] {
  if (!meeting.attendees.length) return [];

  const seen = new Set<string>();
  const candidates: Meeting[] = [];
  for (const personId of meeting.attendees) {
    for (const m of Meetings.list({ person_id: personId })) {
      if (m.id === meeting.id) continue;
      if (seen.has(m.id)) continue;
      // Must be earlier than the current meeting.
      if (m.started_at >= meeting.started_at) continue;
      seen.add(m.id);
      candidates.push(m);
    }
  }
  candidates.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

  const top = candidates.slice(0, 3);

  return top.map((m): PreviousMeetingDigest => {
    const note = GeneratedNotes.get(m.id);
    const openItems = ActionItems.list({})
      .filter((a) => a.meeting_id === m.id && a.status !== 'done' && a.status !== 'cancelled')
      .map((a) => a.task);
    return {
      title: m.title,
      started_at: m.started_at,
      summary: note?.summary?.slice(0, 600) ?? '',
      open_action_items: openItems.slice(0, 5),
    };
  });
}

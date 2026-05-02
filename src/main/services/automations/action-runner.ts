/**
 * Action runner — dispatches each AutomationAction type to the right service.
 *
 * Action order matters: the engine iterates rule.actions sequentially so that
 * e.g. apply_template runs before generate_summary, and sync_to_drive runs
 * before post_to_slack (so the Slack message can include the Drive link).
 *
 * Defensive by design: if a target service isn't registered (e.g. drive is
 * undefined because the user hasn't connected Google Drive), we log a warning
 * and skip the action rather than throwing.
 */
import type { ActionItem, AutomationAction, GeneratedNote, ID, Meeting } from '@shared/types/entities';
import {
  ActionItems,
  Companies,
  Folders,
  GeneratedNotes,
  Meetings,
  People,
  Templates,
} from '@main/db/repositories';
import { services } from '@main/lib/service-registry';
import { log } from '@main/lib/logger';
import type { ActionItemTarget } from '@main/services/action-items/sync';
import type { FollowUpKind } from '@main/services/gmail/gmail-service';
import type { DriveExportFormat } from '@shared/types/entities';
import { postToSlack } from './slack-poster';
import { post as postWebhook } from './webhook';

const logger = log('automations:runner');

export interface ActionRunContext {
  meeting: Meeting;
  payload?: Record<string, unknown>;
}

export async function runAction(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  switch (action.type) {
    case 'apply_template':
      return applyTemplate(action, ctx);
    case 'move_to_folder':
      return moveToFolder(action, ctx);
    case 'sync_to_drive':
      return syncToDrive(action, ctx);
    case 'create_gmail_draft':
      return createGmailDraft(action, ctx);
    case 'create_google_task':
      return syncActionItems(ctx, 'google_tasks');
    case 'create_notion_page':
      return syncActionItems(ctx, 'notion');
    case 'create_linear_issue':
      return syncActionItems(ctx, 'linear');
    case 'post_to_slack':
      return postSlack(action, ctx);
    case 'send_webhook':
      return sendWebhook(action, ctx);
    case 'tag_person':
      return tagPerson(action, ctx);
    case 'tag_company':
      return tagCompany(action, ctx);
    case 'generate_summary':
      return generateSummary(action, ctx);
    default: {
      // Exhaustiveness guard.
      const t: string = (action as AutomationAction).type;
      logger.warn('unknown action type', { type: t });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// apply_template
// ---------------------------------------------------------------------------
async function applyTemplate(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  if (!action.template_id) {
    logger.warn('apply_template missing template_id; skipping');
    return;
  }
  const tpl = Templates.get(action.template_id);
  if (!tpl) {
    logger.warn('apply_template: template not found', { template_id: action.template_id });
    return;
  }
  Meetings.update(ctx.meeting.id, { template_id: tpl.id });
  logger.info('applied template', { meetingId: ctx.meeting.id, templateId: tpl.id });
}

// ---------------------------------------------------------------------------
// move_to_folder
//
// We don't have a meeting↔folder join table in v1. We treat the folder string
// as a Drive folder path, ensure the folder entity exists, and stash the path
// onto the meeting's drive_file_ids object under `folder_path`. Drive sync
// will read this when uploading.
// ---------------------------------------------------------------------------
async function moveToFolder(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  const folderPath = (action.folder ?? '').trim();
  if (!folderPath) {
    logger.warn('move_to_folder missing folder; skipping');
    return;
  }
  const name = folderPath.split('/').filter(Boolean).pop() ?? folderPath;
  Folders.upsert({ name });

  const existing = Meetings.get(ctx.meeting.id);
  if (!existing) return;
  const drive_file_ids = {
    ...(existing.drive_file_ids ?? {}),
    folder_path: folderPath,
  } as Meeting['drive_file_ids'] & { folder_path?: string };
  Meetings.update(ctx.meeting.id, { drive_file_ids });
  logger.info('moved meeting to folder path', { meetingId: ctx.meeting.id, folderPath });
}

// ---------------------------------------------------------------------------
// sync_to_drive
// ---------------------------------------------------------------------------
async function syncToDrive(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  if (!services.drive) {
    logger.warn('sync_to_drive skipped — drive service not registered');
    return;
  }
  const formats = readFormats(action.payload?.formats) ?? (['google_doc'] as DriveExportFormat[]);
  try {
    await services.drive.syncMeeting(ctx.meeting.id, formats);
  } catch (err) {
    logger.error('sync_to_drive failed', { meetingId: ctx.meeting.id, err: String(err) });
  }
}

function readFormats(raw: unknown): DriveExportFormat[] | null {
  if (!Array.isArray(raw)) return null;
  const allowed = new Set<DriveExportFormat>(['google_doc', 'markdown', 'pdf', 'txt', 'json']);
  const out: DriveExportFormat[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && allowed.has(v as DriveExportFormat)) {
      out.push(v as DriveExportFormat);
    }
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// create_gmail_draft
// ---------------------------------------------------------------------------
async function createGmailDraft(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  if (!services.gmail) {
    logger.warn('create_gmail_draft skipped — gmail service not registered');
    return;
  }
  const kind = (action.template ?? 'recap') as FollowUpKind;
  try {
    await services.gmail.draftFollowUp(ctx.meeting.id, kind);
  } catch (err) {
    logger.error('create_gmail_draft failed', { meetingId: ctx.meeting.id, err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// create_google_task / create_notion_page / create_linear_issue
// All three iterate the meeting's action items and dispatch each to the
// configured target via ActionItemSyncService.syncOne.
// ---------------------------------------------------------------------------
async function syncActionItems(ctx: ActionRunContext, target: ActionItemTarget): Promise<void> {
  if (!services.actionItemSync) {
    logger.warn('action item sync skipped — service not registered', { target });
    return;
  }
  const items = ActionItems.list().filter((a) => a.meeting_id === ctx.meeting.id);
  if (items.length === 0) {
    logger.debug('no action items to sync', { meetingId: ctx.meeting.id, target });
    return;
  }
  for (const item of items) {
    try {
      await services.actionItemSync.syncOne(item.id, target);
    } catch (err) {
      logger.warn('action item sync failed', {
        actionItemId: item.id,
        target,
        err: String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// post_to_slack
// ---------------------------------------------------------------------------
async function postSlack(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  const text = buildSlackText(ctx.meeting);
  const channel = typeof action.payload?.channel === 'string' ? (action.payload.channel as string) : undefined;
  const result = await postToSlack({ text, channel });
  if (!result.ok) {
    logger.warn('post_to_slack failed', { error: result.error });
  }
}

function buildSlackText(meeting: Meeting): string {
  const note = GeneratedNotes.get(meeting.id);
  const items = ActionItems.list().filter((a) => a.meeting_id === meeting.id);
  const lines: string[] = [];
  lines.push(`*${meeting.title || 'Untitled meeting'}*`);

  if (note?.decisions?.length) {
    lines.push('');
    lines.push('*Decisions*');
    for (const d of note.decisions.slice(0, 5)) lines.push(`• ${d.text}`);
  }

  lines.push('');
  lines.push(`Action items: ${items.length}`);

  const driveDocId = meeting.drive_file_ids?.google_doc;
  if (driveDocId) {
    lines.push(`<https://docs.google.com/document/d/${driveDocId}|Open in Drive>`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// send_webhook
// ---------------------------------------------------------------------------
async function sendWebhook(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  if (!action.url) {
    logger.warn('send_webhook missing url; skipping');
    return;
  }
  const meeting = Meetings.get(ctx.meeting.id) ?? ctx.meeting;
  const note: GeneratedNote | null = GeneratedNotes.get(meeting.id);
  const actionItems: ActionItem[] = ActionItems.list().filter((a) => a.meeting_id === meeting.id);
  await postWebhook(action.url, {
    meetingId: meeting.id,
    meeting,
    note,
    actionItems,
    payload: action.payload ?? null,
    triggeredAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// tag_person / tag_company
// ---------------------------------------------------------------------------
async function tagPerson(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  const payload = (action.payload ?? {}) as { person_id?: ID; name?: string; email?: string };
  let personId: ID | undefined = payload.person_id;
  if (!personId) {
    if (!payload.name && !payload.email) {
      logger.warn('tag_person missing person_id/name/email; skipping');
      return;
    }
    const person = People.upsert({
      name: payload.name ?? payload.email ?? 'Unknown',
      email: payload.email,
    });
    personId = person.id;
  }
  const meeting = Meetings.get(ctx.meeting.id);
  if (!meeting) return;
  const next = Array.from(new Set([...(meeting.attendees ?? []), personId]));
  Meetings.update(meeting.id, { attendees: next });
  logger.info('tagged person on meeting', { meetingId: meeting.id, personId });
}

async function tagCompany(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  const payload = (action.payload ?? {}) as { company_id?: ID; name?: string; domain?: string };
  let companyId: ID | undefined = payload.company_id;
  if (!companyId) {
    if (!payload.name && !payload.domain) {
      logger.warn('tag_company missing company_id/name/domain; skipping');
      return;
    }
    const company = Companies.upsert({
      name: payload.name ?? payload.domain ?? 'Unknown',
      domain: payload.domain,
    });
    companyId = company.id;
  }
  const meeting = Meetings.get(ctx.meeting.id);
  if (!meeting) return;
  const next = Array.from(new Set([...(meeting.company_ids ?? []), companyId]));
  Meetings.update(meeting.id, { company_ids: next });
  logger.info('tagged company on meeting', { meetingId: meeting.id, companyId });
}

// ---------------------------------------------------------------------------
// generate_summary
// ---------------------------------------------------------------------------
async function generateSummary(action: AutomationAction, ctx: ActionRunContext): Promise<void> {
  if (!services.ai) {
    logger.warn('generate_summary skipped — ai service not registered');
    return;
  }
  try {
    await services.ai.generateNote(ctx.meeting.id, action.payload ?? {});
  } catch (err) {
    logger.error('generate_summary failed', { meetingId: ctx.meeting.id, err: String(err) });
  }
}

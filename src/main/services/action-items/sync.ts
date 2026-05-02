/**
 * Action item sync service. One-way push from local store -> external task
 * managers (Google Tasks / Todoist / Linear / Notion / Asana / Apple Reminders).
 *
 * Each target module returns an external id which we persist on the action
 * item under `external_ids[target]` so the UI can render badges and avoid
 * duplicate pushes.
 */
import type { ID, ActionItem, Meeting } from '@shared/types/entities';
import { ActionItems, Meetings, CalendarEvents, GeneratedNotes } from '@main/db/repositories';
import { log } from '@main/lib/logger';
import { pushToGoogleTasks } from './google-tasks';
import { pushToTodoist } from './todoist';
import { pushToLinear } from './linear';
import { pushToNotion } from './notion';
import { pushToAsana } from './asana';
import { pushToAppleReminders } from './apple-reminders';

export type ActionItemTarget =
  | 'google_tasks'
  | 'todoist'
  | 'linear'
  | 'notion'
  | 'asana'
  | 'apple_reminders';

export interface PushContext {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

const logger = log('action-sync');

function getActionItem(id: ID): ActionItem | null {
  // Repositories don't expose a `get(id)` helper for action items, so derive
  // it from list(). For typical personal-scale data this is fine.
  const all = ActionItems.list();
  return all.find((a) => a.id === id) ?? null;
}

function buildContext(actionItem: ActionItem, meeting: Meeting | null): PushContext {
  const ctx: PushContext = {};
  if (meeting) {
    ctx.meetingTitle = meeting.title;

    // Try to pull a meeting link from the linked calendar event.
    if (meeting.calendar_event_id) {
      // calendar_event_id may be either an internal id or an external id;
      // we look it up by internal id field on calendar_events.
      try {
        // Best-effort: scan upcoming + recent. CalendarEvents has no get(id)
        // helper, so we attempt a direct query via the upsert table semantics.
        const ev = CalendarEvents.upcoming(500).find((e) => e.id === meeting.calendar_event_id);
        if (ev?.meeting_link) ctx.meetingLink = ev.meeting_link;
      } catch {
        // ignore
      }
    }

    // Use the AI summary as descriptive context if present.
    const note = GeneratedNotes.get(meeting.id);
    if (note?.summary) {
      ctx.context = note.summary.slice(0, 1000);
    }
  }
  return ctx;
}

async function dispatch(
  target: ActionItemTarget,
  actionItem: ActionItem,
  meeting: Meeting | null,
  ctx: PushContext,
): Promise<string> {
  switch (target) {
    case 'google_tasks':
      return pushToGoogleTasks(actionItem, meeting, ctx);
    case 'todoist':
      return pushToTodoist(actionItem, meeting, ctx);
    case 'linear':
      return pushToLinear(actionItem, meeting, ctx);
    case 'notion':
      return pushToNotion(actionItem, meeting, ctx);
    case 'asana':
      return pushToAsana(actionItem, meeting, ctx);
    case 'apple_reminders':
      return pushToAppleReminders(actionItem, meeting, ctx);
    default: {
      const exhaustive: never = target;
      throw new Error(`Unsupported sync target: ${String(exhaustive)}`);
    }
  }
}

export class ActionItemSyncService {
  async syncOne(id: ID, target: ActionItemTarget): Promise<void> {
    const actionItem = getActionItem(id);
    if (!actionItem) throw new Error(`Action item not found: ${id}`);

    const meeting = actionItem.meeting_id ? Meetings.get(actionItem.meeting_id) : null;
    const ctx = buildContext(actionItem, meeting);

    try {
      const externalId = await dispatch(target, actionItem, meeting, ctx);
      const merged = {
        ...(actionItem.external_ids ?? {}),
        [target]: externalId,
      };
      ActionItems.update(id, { external_ids: merged });
      logger.info('sync.success', { id, target, externalId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('sync.failure', { id, target, error: message });
      throw err;
    }
  }
}

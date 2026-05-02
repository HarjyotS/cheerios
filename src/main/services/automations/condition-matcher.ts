/**
 * Condition matcher — evaluates a list of AutomationCondition entries against a
 * synthesized context object. Used by the automations engine to gate rules.
 *
 * All conditions are AND-ed: every condition must pass for the rule to fire.
 *
 * Field/operator mapping (per spec §19):
 *   calendar_title         contains | equals | matches  → meeting.title or calendar.title
 *   attendee_email         in | contains                 → attendees[].email
 *   attendee_domain        in | contains                 → email-after-@
 *   meeting_app            equals                        → meeting.source_app
 *   template               equals                        → template?.name | template?.id
 *   project                in                            → meeting.project_ids
 *   folder                 in                            → no folder membership table; treated as false
 *   keyword                contains                      → transcript text + raw notes
 *   meeting_length_minutes gt | lt                       → context.durationMinutes
 *   action_item_count      gt | lt                       → context.actionItemCount
 */
import type {
  AutomationCondition,
  CalendarEvent,
  Company,
  Meeting,
  Person,
  Project,
  Template,
} from '@shared/types/entities';
import { TranscriptChunks } from '@main/db/repositories';
import { log } from '@main/lib/logger';

const logger = log('automations:matcher');

export interface ConditionContext {
  meeting: Meeting;
  calendar?: CalendarEvent | null;
  attendees: Person[];
  companies: Company[];
  projects: Project[];
  template?: Template | null;
  payload?: Record<string, unknown>;
  durationMinutes?: number;
  actionItemCount?: number;
}

export function evaluateConditions(
  conditions: AutomationCondition[],
  ctx: ConditionContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    if (!evaluateOne(c, ctx)) {
      logger.debug('condition failed', { field: c.field, operator: c.operator });
      return false;
    }
  }
  return true;
}

function evaluateOne(c: AutomationCondition, ctx: ConditionContext): boolean {
  switch (c.field) {
    case 'calendar_title':
      return matchString(titleText(ctx), c.operator, c.value);

    case 'attendee_email': {
      const emails = ctx.attendees.map((p) => (p.email ?? '').toLowerCase()).filter(Boolean);
      return matchList(emails, c.operator, c.value);
    }

    case 'attendee_domain': {
      const domains = ctx.attendees
        .map((p) => (p.email ?? '').toLowerCase().split('@')[1])
        .filter((d): d is string => Boolean(d));
      return matchList(domains, c.operator, c.value);
    }

    case 'meeting_app':
      return matchString(ctx.meeting.source_app ?? '', c.operator, c.value);

    case 'template': {
      const t = ctx.template;
      if (!t) return false;
      return (
        matchString(t.name, c.operator, c.value) || matchString(t.id, c.operator, c.value)
      );
    }

    case 'project':
      return matchList(ctx.meeting.project_ids ?? [], c.operator, c.value);

    case 'folder':
      // No meeting↔folder join table in schema; treat as not-matched.
      logger.debug('folder condition not supported in v1; returning false');
      return false;

    case 'keyword':
      return matchString(keywordHaystack(ctx), c.operator, c.value);

    case 'meeting_length_minutes':
      return matchNumber(ctx.durationMinutes ?? meetingDurationMinutes(ctx.meeting), c.operator, c.value);

    case 'action_item_count':
      return matchNumber(ctx.actionItemCount ?? 0, c.operator, c.value);

    default:
      logger.warn('unknown condition field', { field: (c as AutomationCondition).field });
      return false;
  }
}

// ---------------------------------------------------------------------------
// Operator implementations
// ---------------------------------------------------------------------------

function matchString(
  haystack: string,
  operator: AutomationCondition['operator'],
  value: AutomationCondition['value'],
): boolean {
  const hay = (haystack ?? '').toLowerCase();
  switch (operator) {
    case 'contains': {
      const needle = String(value ?? '').toLowerCase();
      return needle.length > 0 && hay.includes(needle);
    }
    case 'equals':
      return hay === String(value ?? '').toLowerCase();
    case 'matches':
      try {
        return new RegExp(String(value), 'i').test(haystack ?? '');
      } catch (err) {
        logger.warn('invalid regex in condition', { value, err: String(err) });
        return false;
      }
    case 'in': {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => String(v).toLowerCase()).includes(hay);
    }
    default:
      return false;
  }
}

function matchList(
  values: string[],
  operator: AutomationCondition['operator'],
  needle: AutomationCondition['value'],
): boolean {
  const lower = values.map((v) => v.toLowerCase());
  switch (operator) {
    case 'in': {
      const arr = (Array.isArray(needle) ? needle : [needle]).map((v) => String(v).toLowerCase());
      return lower.some((v) => arr.includes(v));
    }
    case 'contains': {
      const n = String(needle ?? '').toLowerCase();
      if (!n) return false;
      return lower.some((v) => v.includes(n));
    }
    case 'equals': {
      const n = String(needle ?? '').toLowerCase();
      return lower.includes(n);
    }
    default:
      return false;
  }
}

function matchNumber(
  n: number,
  operator: AutomationCondition['operator'],
  value: AutomationCondition['value'],
): boolean {
  const v = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(v)) return false;
  switch (operator) {
    case 'gt': return n > v;
    case 'lt': return n < v;
    case 'equals': return n === v;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleText(ctx: ConditionContext): string {
  return ctx.calendar?.title || ctx.meeting.title || '';
}

function meetingDurationMinutes(m: Meeting): number {
  if (!m.started_at) return 0;
  const start = Date.parse(m.started_at);
  const end = m.ended_at ? Date.parse(m.ended_at) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

/**
 * Build the haystack for keyword search: raw notes + final transcript text.
 * Lazy: only loads transcript when called (the matcher is hot in the loop).
 */
function keywordHaystack(ctx: ConditionContext): string {
  const parts: string[] = [];
  if (ctx.meeting.raw_notes) parts.push(ctx.meeting.raw_notes);
  try {
    const chunks = TranscriptChunks.listByMeeting(ctx.meeting.id);
    for (const c of chunks) if (c.is_final) parts.push(c.text);
  } catch (err) {
    logger.warn('failed to load transcript for keyword match', { err: String(err) });
  }
  return parts.join('\n');
}

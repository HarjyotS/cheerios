/**
 * Templates service — picks the right template for a meeting based on rules.
 */
import { Templates, Meetings, CalendarEvents, People, Companies } from '../../db/repositories';
import type { Template, ID, TemplateAutoApplyRule } from '@shared/types/entities';

export class TemplatesService {
  /**
   * Pick the best-matching template for a meeting using each template's
   * auto_apply_rules. Returns null if no template matches; caller can default
   * to "General Meeting".
   */
  pickForMeeting(meetingId: ID): Template | null {
    const meeting = Meetings.get(meetingId);
    if (!meeting) return null;
    const calendar = meeting.calendar_event_id
      ? this.findCalendarEvent(meeting.calendar_event_id)
      : null;
    const attendees = meeting.attendees.map((id) => People.get(id)).filter(Boolean);
    const companies = meeting.company_ids.map((id) => Companies.get(id)).filter(Boolean);

    const candidates = Templates.list();
    let best: { tpl: Template; score: number } | null = null;
    for (const t of candidates) {
      if (!t.auto_apply_rules?.length) continue;
      let score = 0;
      let matched = true;
      for (const rule of t.auto_apply_rules) {
        if (this.matchesRule(rule, { meeting, calendar, attendees, companies })) {
          score++;
        } else {
          matched = false;
          break;
        }
      }
      if (matched && score > 0 && (!best || score > best.score)) {
        best = { tpl: t, score };
      }
    }
    return best?.tpl ?? Templates.byName('General Meeting');
  }

  private findCalendarEvent(externalId: string) {
    return CalendarEvents.byExternalId('google', externalId)
      ?? CalendarEvents.byExternalId('outlook', externalId)
      ?? CalendarEvents.byExternalId('apple', externalId)
      ?? null;
  }

  private matchesRule(rule: TemplateAutoApplyRule, ctx: any): boolean {
    const v = rule.value;
    switch (rule.field) {
      case 'calendar_title': {
        const t = (ctx.calendar?.title ?? ctx.meeting.title ?? '').toLowerCase();
        return rule.operator === 'contains' && typeof v === 'string' && t.includes(v.toLowerCase());
      }
      case 'attendee_email': {
        const emails = (ctx.attendees ?? []).map((p: any) => p?.email).filter(Boolean);
        return rule.operator === 'in' ? Array.isArray(v) && emails.some((e: string) => v.includes(e)) : false;
      }
      case 'attendee_domain': {
        const domains = (ctx.attendees ?? []).map((p: any) => p?.email?.split('@')[1]).filter(Boolean);
        if (rule.operator === 'in' && Array.isArray(v)) return domains.some((d: string) => v.includes(d));
        if (rule.operator === 'contains' && typeof v === 'string') return domains.some((d: string) => d.includes(v));
        return false;
      }
      case 'meeting_app': {
        return rule.operator === 'equals' && ctx.meeting.source_app === v;
      }
      case 'recurring': {
        return rule.operator === 'is_true' && Boolean(ctx.calendar?.recurring_id);
      }
      case 'company_id': {
        return rule.operator === 'in' && Array.isArray(v) && (ctx.companies ?? []).some((c: any) => v.includes(c.id));
      }
      case 'project_id': {
        return rule.operator === 'in' && Array.isArray(v) && ctx.meeting.project_ids.some((id: string) => v.includes(id));
      }
      case 'folder_id':
        return false;
      case 'keyword_in_first_5_minutes':
        return false;
      default:
        return false;
    }
  }
}

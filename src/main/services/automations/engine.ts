/**
 * Automations engine — listens on the in-process bus for `automation_trigger`
 * events, fans out to all enabled rules registered for that trigger,
 * evaluates each rule's conditions, and runs its actions sequentially.
 *
 * Action ordering matters and is preserved as authored — e.g. a user can rely
 * on `apply_template` running before `generate_summary`, or `sync_to_drive`
 * running before `post_to_slack` so the Slack message can include the link.
 *
 * Spec: §19 (Automations)
 */
import type { AutomationRule, ID } from '@shared/types/entities';
import {
  Automations,
  CalendarEvents,
  Companies,
  GeneratedNotes,
  Meetings,
  People,
  Projects,
  Templates,
} from '@main/db/repositories';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { evaluateConditions, type ConditionContext } from './condition-matcher';
import { runAction } from './action-runner';

const logger = log('automations:engine');

type TriggerHandler = (t: { trigger: string; meetingId: ID; payload?: Record<string, unknown> }) => void;

export class AutomationsEngine {
  private handler: TriggerHandler | null = null;
  private started = false;
  /** Tracks in-flight rule runs so stop() can wait for them to drain. */
  private pending = new Set<Promise<void>>();

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handler = (evt) => {
      const p = this.handleTrigger(evt).catch((err) => {
        logger.error('handleTrigger threw', { trigger: evt.trigger, err: String(err) });
      });
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    };
    bus.on('automation_trigger', this.handler);
    logger.info('automations engine started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.handler) {
      bus.off('automation_trigger', this.handler);
      this.handler = null;
    }
    // Wait for any in-flight rule runs.
    if (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
    logger.info('automations engine stopped');
  }

  /**
   * Manually run a single rule against a single meeting. Conditions are still
   * evaluated; if you want to bypass them, set the rule's conditions to [].
   */
  async runOnce(ruleId: ID, meetingId: ID): Promise<void> {
    const rule = Automations.list().find((r) => r.id === ruleId);
    if (!rule) {
      logger.warn('runOnce: rule not found', { ruleId });
      return;
    }
    const meeting = Meetings.get(meetingId);
    if (!meeting) {
      logger.warn('runOnce: meeting not found', { meetingId });
      return;
    }
    await this.executeRule(rule, meeting.id, undefined);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleTrigger(evt: {
    trigger: string;
    meetingId: ID;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const rules = Automations.byTrigger(evt.trigger as AutomationRule['trigger']);
    if (rules.length === 0) return;
    logger.debug('dispatching trigger', { trigger: evt.trigger, ruleCount: rules.length });
    for (const rule of rules) {
      try {
        await this.executeRule(rule, evt.meetingId, evt.payload);
      } catch (err) {
        logger.error('rule execution failed', { ruleId: rule.id, err: String(err) });
      }
    }
  }

  private async executeRule(
    rule: AutomationRule,
    meetingId: ID,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const meeting = Meetings.get(meetingId);
    if (!meeting) {
      logger.warn('executeRule: meeting not found', { ruleId: rule.id, meetingId });
      return;
    }

    const ctx = buildContext(meeting, payload);
    if (!evaluateConditions(rule.conditions, ctx)) {
      logger.debug('rule skipped — conditions failed', { ruleId: rule.id, name: rule.name });
      return;
    }

    logger.info('running rule', { ruleId: rule.id, name: rule.name, actions: rule.actions.length });

    // Sequential — order matters.
    for (const action of rule.actions) {
      try {
        await runAction(action, { meeting, payload });
      } catch (err) {
        logger.error('action failed', {
          ruleId: rule.id,
          actionType: action.type,
          err: String(err),
        });
      }
    }

    Automations.setLastRun(rule.id);
    bus.emit('notification', {
      kind: 'automation',
      title: `Ran "${rule.name}"`,
      meetingId: meeting.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

function buildContext(
  meeting: ReturnType<typeof Meetings.get> & object,
  payload: Record<string, unknown> | undefined,
): ConditionContext {
  const attendees = (meeting.attendees ?? [])
    .map((id) => People.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const companies = (meeting.company_ids ?? [])
    .map((id) => Companies.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const projects = (meeting.project_ids ?? [])
    .map((id) => Projects.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const template = meeting.template_id ? Templates.get(meeting.template_id) : null;

  let calendar = null;
  if (meeting.calendar_event_id) {
    // calendar_event_id is the local CalendarEvent.id; we don't have a
    // by-id accessor, so fall back to scanning upcoming/forNow if needed.
    calendar = CalendarEvents.forNow();
  }

  const durationMinutes = meeting.started_at
    ? Math.max(
        0,
        Math.round(
          ((meeting.ended_at ? Date.parse(meeting.ended_at) : Date.now()) -
            Date.parse(meeting.started_at)) /
            60_000,
        ),
      )
    : 0;

  const note = GeneratedNotes.get(meeting.id);
  const actionItemCount = note?.action_items?.length ?? 0;

  return {
    meeting,
    calendar,
    attendees,
    companies,
    projects,
    template,
    payload,
    durationMinutes,
    actionItemCount,
  };
}

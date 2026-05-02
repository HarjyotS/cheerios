/**
 * MeetingStateDetector — watches every active meeting (started_at set,
 * ended_at null) and applies the auto-stop heuristics from spec §7:
 *
 *   - meeting app process disappeared from process scan
 *   - calendar event ended >60s ago AND no recent speech
 *   - mic + system silent for >5 minutes
 *   - meeting duration exceeded settings.max_meeting_duration_minutes
 *   - computer about to sleep (powerMonitor 'suspend')
 *
 * When a stop condition triggers we first emit a "Looks like your meeting
 * ended" notification. If the user doesn't respond within 2 minutes we
 * stop the deepgram stream and mark the meeting ended.
 */
import { powerMonitor } from 'electron';
import type { ID, Meeting } from '@shared/types/entities';
import { Meetings, CalendarEvents } from '@main/db/repositories';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { services } from '@main/lib/service-registry';

import { processScanner } from './process-scanner';
import { speechDetector } from './speech-detector';

const logger = log('detection.state');

const POLL_INTERVAL_MS = 30_000;
/** Grace window between notification and forced stop. */
const PENDING_STOP_GRACE_MS = 2 * 60 * 1000;
const NO_SPEECH_AFTER_CALENDAR_END_MS = 60 * 1000;
const SILENCE_TIMEOUT_SECONDS = 5 * 60; // 5 min
const MIN_MEETING_AGE_MS = 30 * 1000;

interface PendingStop {
  meetingId: ID;
  /** When we first noticed a stop condition. */
  firstSeenAt: number;
  /** When we sent the user-facing notification. */
  notifiedAt: number;
  reason: string;
}

export class MeetingStateDetector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pollInProgress = false;
  private pending = new Map<ID, PendingStop>();
  /** User responded to the prompt and asked us to keep the meeting going. */
  private suppressedUntil = new Map<ID, number>();

  private boundOnSuspend = (): void => {
    this.handleSuspend().catch((err) =>
      logger.warn('suspend handler failed', { err: String(err) }),
    );
  };

  /** Subscribe to the user's "keep recording" response from the renderer. */
  private boundOnNotification = (n: { kind: string; meetingId?: ID }): void => {
    if (!n.meetingId) return;
    if (n.kind === 'meeting_keep_running' || n.kind === 'meeting_dismiss_stop') {
      this.pending.delete(n.meetingId);
      // Suppress further auto-stop checks for 5 minutes so we don't immediately
      // re-prompt the user.
      this.suppressedUntil.set(n.meetingId, Date.now() + 5 * 60 * 1000);
    }
  };

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('MeetingStateDetector starting');
    powerMonitor.on('suspend', this.boundOnSuspend);
    bus.on('notification', this.boundOnNotification);
    this.tick().catch((err) => logger.warn('initial state tick failed', { err: String(err) }));
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.warn('state tick failed', { err: String(err) }));
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    powerMonitor.off('suspend', this.boundOnSuspend);
    bus.off('notification', this.boundOnNotification);
    this.pending.clear();
    this.suppressedUntil.clear();
    logger.info('MeetingStateDetector stopped');
  }

  // ------------------------------------------------------------------
  // Polling loop
  // ------------------------------------------------------------------
  private async tick(): Promise<void> {
    if (this.pollInProgress) return;
    this.pollInProgress = true;
    try {
      const active = listActiveMeetings();
      if (active.length === 0) {
        this.pending.clear();
        return;
      }
      const settings = getSettings();
      const processes = await processScanner.scan().catch(() => []);
      const now = Date.now();

      for (const m of active) {
        // Garbage-collect stale suppression entries.
        const supUntil = this.suppressedUntil.get(m.id);
        if (supUntil && supUntil < now) this.suppressedUntil.delete(m.id);

        // Drive any pending stop forward (notify → wait → force stop).
        const pending = this.pending.get(m.id);
        if (pending) {
          if (now - pending.notifiedAt >= PENDING_STOP_GRACE_MS) {
            await this.forceStop(m, pending.reason);
          }
          continue;
        }

        if (this.suppressedUntil.has(m.id)) continue;

        const reason = this.evaluateStopReason(m, processes, settings, now);
        if (!reason) continue;
        this.beginPendingStop(m, reason, now);
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Returns a human-readable reason if a stop condition is currently met,
   * otherwise null.
   */
  private evaluateStopReason(
    meeting: Meeting,
    processes: Array<{ sourceApp: string }>,
    settings: ReturnType<typeof getSettings>,
    now: number,
  ): string | null {
    const startedAt = Date.parse(meeting.started_at);
    if (Number.isFinite(startedAt) && now - startedAt < MIN_MEETING_AGE_MS) {
      // Don't auto-stop a meeting that just started — give signals time to settle.
      return null;
    }

    // 1. Max duration.
    if (Number.isFinite(startedAt)) {
      const durationMin = (now - startedAt) / 60_000;
      if (durationMin > settings.max_meeting_duration_minutes) {
        return `max duration exceeded (${Math.round(durationMin)} min)`;
      }
    }

    // 2. Meeting app process gone.
    if (
      settings.auto_stop_on_call_end &&
      meeting.source_app !== 'unknown' &&
      meeting.source_app !== 'browser'
    ) {
      const stillRunning = processes.some((p) => p.sourceApp === meeting.source_app);
      if (!stillRunning) {
        return `${meeting.source_app} process ended`;
      }
    }

    // 3. Calendar event ended >60s ago AND no recent speech.
    if (settings.auto_stop_on_calendar_end && meeting.calendar_event_id) {
      const ev = lookupCalendarEventByLocalId(meeting.calendar_event_id);
      if (ev) {
        const endsAt = Date.parse(ev.ends_at);
        if (
          Number.isFinite(endsAt) &&
          now - endsAt > NO_SPEECH_AFTER_CALENDAR_END_MS &&
          !speechDetector.recentlyActive(60)
        ) {
          return 'calendar event ended and no recent speech';
        }
      }
    }

    // 4. Silence — no speech for `auto_stop_after_silence_minutes` minutes.
    const silenceWindowSeconds = Math.max(
      60,
      Math.round(settings.auto_stop_after_silence_minutes * 60),
    );
    const meetingAgeSeconds = (now - startedAt) / 1000;
    if (
      meetingAgeSeconds > silenceWindowSeconds &&
      !speechDetector.recentlyActive(Math.max(silenceWindowSeconds, SILENCE_TIMEOUT_SECONDS))
    ) {
      return `silent for ${settings.auto_stop_after_silence_minutes} min`;
    }

    return null;
  }

  /**
   * Notify the user and remember that we're waiting for either a response or
   * the grace window to elapse.
   */
  private beginPendingStop(meeting: Meeting, reason: string, now: number): void {
    logger.info('pending auto-stop', { meetingId: meeting.id, reason });
    this.pending.set(meeting.id, {
      meetingId: meeting.id,
      firstSeenAt: now,
      notifiedAt: now,
      reason,
    });
    bus.emit('notification', {
      kind: 'meeting_maybe_ended',
      title: 'Looks like your meeting ended',
      body: `Stopping in 2 minutes — tap to keep recording. (${reason})`,
      meetingId: meeting.id,
    });
  }

  /**
   * Suspend handler — stop every active meeting immediately. We do NOT use
   * the pending-stop dance here because the system is going to sleep and
   * audio capture will die anyway.
   */
  private async handleSuspend(): Promise<void> {
    const active = listActiveMeetings();
    if (active.length === 0) return;
    logger.info('powerMonitor suspend — stopping active meetings', { count: active.length });
    for (const m of active) {
      await this.forceStop(m, 'system suspending');
    }
  }

  private async forceStop(meeting: Meeting, reason: string): Promise<void> {
    logger.info('auto-stopping meeting', { meetingId: meeting.id, reason });
    this.pending.delete(meeting.id);
    try {
      await services.deepgram?.stopForMeeting(meeting.id);
    } catch (err) {
      logger.warn('deepgram stopForMeeting failed', { meetingId: meeting.id, err: String(err) });
    }
    try {
      const updated = Meetings.update(meeting.id, { ended_at: new Date().toISOString() });
      bus.emit('meeting_ended', updated);
    } catch (err) {
      logger.warn('failed to mark meeting ended', { meetingId: meeting.id, err: String(err) });
    }
  }
}

// ----------------------------------------------------------------------
// Helpers (DB)
// ----------------------------------------------------------------------

function listActiveMeetings(): Meeting[] {
  // Repositories don't expose a typed "active" list, so we filter.
  // `Meetings.list({})` returns recent-first; this is fine because there
  // are usually 0–1 active meetings.
  try {
    return Meetings.list({}).filter((m) => m.started_at && !m.ended_at);
  } catch (err) {
    logger.warn('listActiveMeetings failed', { err: String(err) });
    return [];
  }
}

function lookupCalendarEventByLocalId(localId: string) {
  // CalendarEvents repo only exposes external-id and forNow lookups; do a
  // minimal direct query via the upcoming list and matching id. For personal
  // use the cache holds at most a few dozen events so the linear scan is OK.
  try {
    const all = CalendarEvents.upcoming(200);
    return all.find((e) => e.id === localId) ?? null;
  } catch {
    return null;
  }
}

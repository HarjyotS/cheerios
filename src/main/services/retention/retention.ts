/**
 * Retention service (spec §24). Periodically applies the user's data
 * retention policy:
 *
 *   - `delete_transcripts_after_days` — strip transcript_chunks for
 *     meetings older than N days, but keep the GeneratedNote so the
 *     summary survives.
 *   - `delete_private_meetings_after_days` — fully delete meetings whose
 *     `privacy_mode === 'private'` after N days.
 *   - `keep_summaries_forever` — informational; we always keep summaries
 *     because the transcript-purge path doesn't touch generated_notes.
 *
 * We use a 6-hour watchdog timer that fires runOnce() if it hasn't been
 * run in the local-day yet. The "did I run today?" timestamp is stored
 * in `schema_meta` under `retention.last_run`. This survives sleeps and
 * restarts cleanly — a laptop closed across the 03:00 boundary still
 * runs once on next wake.
 */
import { getDb, getSettings } from '@main/db';
import { Meetings, TranscriptChunks } from '@main/db/repositories';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';

const logger = log('retention');

const WATCHDOG_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const RUN_HOUR_LOCAL = 3; // 03:00 local time
const META_KEY = 'retention.last_run';

interface RunResult {
  deleted: number;
  transcriptsCleared: number;
  privateMeetingsDeleted: number;
}

export class RetentionService {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.interval) return;

    // Kick once on startup — guarded by the "today" check so we never
    // hammer the DB on rapid relaunches.
    void this.maybeRun().catch((err) => logger.error('Initial retention sweep failed', { err: String(err) }));

    this.interval = setInterval(() => {
      void this.maybeRun().catch((err) => logger.error('Scheduled retention sweep failed', { err: String(err) }));
    }, WATCHDOG_INTERVAL_MS);

    logger.info('Retention service started');
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Force a run now, regardless of the daily guard. Used by IPC / tests. */
  async runOnce(): Promise<{ deleted: number }> {
    const result = await this.applyPolicies();
    this.recordLastRun();
    return { deleted: result.deleted };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------
  private async maybeRun(): Promise<void> {
    if (this.running) return;
    if (!this.shouldRunNow()) return;
    this.running = true;
    try {
      const result = await this.applyPolicies();
      this.recordLastRun();
      if (result.deleted > 0) {
        bus.emit('notification', {
          kind: 'retention',
          title: `Retention swept ${result.deleted} ${result.deleted === 1 ? 'item' : 'items'}`,
          body: `Cleared ${result.transcriptsCleared} transcript${result.transcriptsCleared === 1 ? '' : 's'} and deleted ${result.privateMeetingsDeleted} private meeting${result.privateMeetingsDeleted === 1 ? '' : 's'}.`,
        });
      }
      logger.info('Retention sweep complete', result);
    } finally {
      this.running = false;
    }
  }

  /**
   * We only want one run per local day, ideally after the 03:00 mark.
   * This decision intentionally tolerates devices that sleep through
   * 03:00 — if the most recent recorded run is on a different local
   * date, run now whatever the time.
   */
  private shouldRunNow(): boolean {
    const last = this.lastRunAt();
    const now = new Date();
    if (!last) {
      // First boot — only run if we're past the configured hour, so we
      // don't churn on laptop wake at 09:30.
      return now.getHours() >= RUN_HOUR_LOCAL;
    }
    return !sameLocalDay(last, now);
  }

  private lastRunAt(): Date | null {
    try {
      const row = getDb().prepare('SELECT value FROM schema_meta WHERE key = ?').get(META_KEY) as
        | { value: string }
        | undefined;
      if (!row) return null;
      const t = new Date(row.value);
      return isNaN(t.getTime()) ? null : t;
    } catch {
      return null;
    }
  }

  private recordLastRun(): void {
    const d = getDb();
    const value = new Date().toISOString();
    const updated = d.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(value, META_KEY);
    if ((updated.changes ?? 0) === 0) {
      d.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(META_KEY, value);
    }
  }

  private async applyPolicies(): Promise<RunResult> {
    const settings = getSettings();
    const transcriptsDays = settings.delete_transcripts_after_days;
    const privateDays = settings.delete_private_meetings_after_days;

    let transcriptsCleared = 0;
    let privateMeetingsDeleted = 0;

    // 1) Private-meeting purge first — that way we don't bother clearing
    //    transcripts for meetings we're about to delete anyway.
    if (typeof privateDays === 'number' && privateDays >= 0) {
      const cutoff = isoDaysAgo(privateDays);
      // Hydrating every meeting just to filter is fine for personal-scale.
      const meetings = Meetings.list({ to: cutoff });
      for (const m of meetings) {
        if (m.privacy_mode !== 'private') continue;
        try {
          Meetings.delete(m.id);
          privateMeetingsDeleted += 1;
          logger.info('Deleted private meeting past retention', { id: m.id, started_at: m.started_at });
        } catch (err) {
          logger.error('Failed to delete private meeting', { id: m.id, err: String(err) });
        }
      }
    }

    // 2) Transcript purge — keep the GeneratedNote, drop the chunks.
    if (typeof transcriptsDays === 'number' && transcriptsDays >= 0) {
      const cutoff = isoDaysAgo(transcriptsDays);
      const meetings = Meetings.list({ to: cutoff });
      for (const m of meetings) {
        try {
          const removed = TranscriptChunks.deleteByMeeting(m.id);
          if (removed > 0) {
            transcriptsCleared += 1;
            logger.info('Cleared transcript past retention', { id: m.id, removed });
          }
        } catch (err) {
          logger.error('Failed to clear transcript', { id: m.id, err: String(err) });
        }
      }
    }

    return {
      deleted: transcriptsCleared + privateMeetingsDeleted,
      transcriptsCleared,
      privateMeetingsDeleted,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

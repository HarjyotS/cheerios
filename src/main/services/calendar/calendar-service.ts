/**
 * Google Calendar service. Spec §6 / §20.
 *
 * Polls the user's primary calendar every 5 minutes for the window
 * [now − 1h, now + 24h], upserts events into the local calendar_events
 * cache, and infers a meeting-app hint from the event's location /
 * description / conferenceData so detection can pre-tag the source app.
 *
 * Off when not connected — `start()` is safe to call before OAuth has
 * completed; the polling loop short-circuits while disconnected.
 */
import { google, type calendar_v3 } from 'googleapis';
import type { CalendarEvent, SourceApp } from '@shared/types/entities';
import type { GoogleAuthManager } from '../google/auth';
import { CalendarEvents, Integrations } from '@main/db/repositories';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';

const logger = log('calendar');
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const WINDOW_PAST_MS = 60 * 60 * 1000; // 1 h
const WINDOW_FUTURE_MS = 24 * 60 * 60 * 1000; // 24 h
const NETWORK_WARN_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export class CalendarService {
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private lastNetworkWarnAt = 0;

  constructor(private auth: GoogleAuthManager) {}

  async start(): Promise<void> {
    if (this.timer) return;
    // First refresh on boot is fire-and-forget — it might fail silently while
    // disconnected. The polling loop will retry on the next tick.
    this.refresh().catch((err) =>
      logger.warn('initial calendar refresh failed', { err: String(err) }),
    );
    this.timer = setInterval(() => {
      this.refresh().catch((err) =>
        logger.warn('calendar refresh failed', { err: String(err) }),
      );
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): { connected: boolean; account?: string } {
    return { connected: this.auth.isConnected(), account: this.auth.account() };
  }

  async connect() {
    return this.auth.authorize('google_calendar');
  }

  async upcoming(): Promise<CalendarEvent[]> {
    return CalendarEvents.upcoming(50);
  }

  async forNow(): Promise<CalendarEvent | null> {
    return CalendarEvents.forNow();
  }

  /**
   * Pull events from primary calendar in the polling window and upsert
   * them. Updates the integration row on success/failure so the UI can
   * render last-synced + error state.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const client = await this.auth.getOAuth2Client();
      if (!client) return; // not connected — silently skip

      const calendar = google.calendar({ version: 'v3', auth: client as any });
      const now = new Date();
      const timeMin = new Date(now.getTime() - WINDOW_PAST_MS).toISOString();
      const timeMax = new Date(now.getTime() + WINDOW_FUTURE_MS).toISOString();

      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100,
      });

      const items = res.data.items ?? [];
      for (const ev of items) {
        upsertEvent(ev);
      }

      Integrations.setStatus('google_calendar', {
        status: 'connected',
        last_synced_at: new Date().toISOString(),
        error_message: null,
      });
      bus.emit('sync_status', {
        meetingId: '',
        status: 'calendar_synced',
      });
      logger.debug('calendar refreshed', { count: items.length });
    } catch (err) {
      const msg = errorMessage(err);
      if (isNetworkUnavailable(err)) {
        const friendly =
          'Google Calendar is temporarily unreachable. Check your internet or DNS connection and refresh again.';
        if (this.shouldLogNetworkWarning()) {
          logger.warn('calendar refresh skipped: Google APIs unreachable', { error: msg });
        }
        try {
          Integrations.setStatus('google_calendar', {
            status: 'error',
            error_message: friendly,
          });
        } catch {
          // integration row may not exist yet — ignore
        }
        return;
      }

      logger.error('calendar refresh failed', { error: msg });
      try {
        Integrations.setStatus('google_calendar', {
          status: 'error',
          error_message: msg,
        });
      } catch {
        // integration row may not exist yet — ignore
      }
    } finally {
      this.refreshing = false;
    }
  }

  private shouldLogNetworkWarning(): boolean {
    const now = Date.now();
    if (now - this.lastNetworkWarnAt < NETWORK_WARN_INTERVAL_MS) return false;
    this.lastNetworkWarnAt = now;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upsertEvent(ev: calendar_v3.Schema$Event): void {
  if (!ev.id) return;
  const startsAt = ev.start?.dateTime ?? ev.start?.date;
  const endsAt = ev.end?.dateTime ?? ev.end?.date;
  if (!startsAt || !endsAt) return;

  const attendees = (ev.attendees ?? []).map((a) => ({
    email: a.email ?? '',
    name: a.displayName ?? undefined,
    response_status: a.responseStatus ?? undefined,
  }));

  CalendarEvents.upsert({
    provider: 'google',
    external_id: ev.id,
    title: ev.summary ?? '(no title)',
    description: ev.description ?? undefined,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    attendees,
    meeting_link: extractMeetingLink(ev) ?? undefined,
    meeting_app_hint: inferAppHint(ev) ?? undefined,
    recurring_id: ev.recurringEventId ?? undefined,
  });
}

function extractMeetingLink(ev: calendar_v3.Schema$Event): string | undefined {
  // Prefer hangoutLink (Google Meet) → conferenceData entry points → location.
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = ev.conferenceData?.entryPoints ?? [];
  for (const ep of eps) {
    if (ep.entryPointType === 'video' && ep.uri) return ep.uri;
  }
  if (ev.location && /^https?:\/\//i.test(ev.location)) return ev.location;
  return undefined;
}

function inferAppHint(ev: calendar_v3.Schema$Event): SourceApp | undefined {
  const haystack = [
    ev.hangoutLink ?? '',
    ev.location ?? '',
    ev.description ?? '',
    ...(ev.conferenceData?.entryPoints ?? []).map((e) => e.uri ?? ''),
  ].join(' ').toLowerCase();
  if (!haystack) return undefined;
  if (haystack.includes('meet.google.com')) return 'google_meet';
  if (haystack.includes('zoom.us')) return 'zoom';
  if (haystack.includes('teams.microsoft.com')) return 'microsoft_teams';
  if (haystack.includes('webex.com')) return 'webex';
  if (haystack.includes('discord.com')) return 'discord';
  if (haystack.includes('app.slack.com') && haystack.includes('huddle')) return 'slack_huddle';
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isNetworkUnavailable(err: unknown): boolean {
  const e = err as { code?: string; cause?: unknown; message?: string };
  const cause = e?.cause as { code?: string; message?: string } | undefined;
  const msg = [e?.message, cause?.message, errorMessage(err)].filter(Boolean).join(' ');
  const codes = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
  return (
    codes.some((code) => e?.code === code || cause?.code === code || msg.includes(code)) ||
    /getaddrinfo|network.*failed|fetch failed|name or service not known|temporary failure in name resolution/i.test(msg)
  );
}

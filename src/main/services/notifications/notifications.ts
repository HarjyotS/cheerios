/**
 * Notifications service (spec §26). Subscribes to the bus and surfaces
 * relevant events as native macOS notifications via Electron's
 * `Notification` API.
 *
 * Honors:
 *   - `settings.hide_notification_previews` — strips the body and uses
 *     a generic title when on.
 *   - `settings.app_lock_enabled` while the app is locked — we suppress
 *     all notifications so the lock screen doesn't leak content.
 *   - `tray:*` and `lock` / `unlock` event kinds — these are user-driven
 *     or internal signals, not user-visible notifications.
 */
import { BrowserWindow, Notification } from 'electron';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { services } from '@main/lib/service-registry';

const logger = log('notifications');

interface NotificationEvent {
  kind: string;
  title: string;
  body?: string;
  meetingId?: string;
}

// Per-kind formatting overrides. Anything not listed falls back to the
// title/body that was on the bus event itself.
const KIND_PRESETS: Record<string, { titleFallback?: string; body?: string }> = {
  meeting_starting_soon: { titleFallback: 'Meeting starting soon' },
  call_detected: { titleFallback: 'Call detected', body: 'Start a note?' },
  transcription_started: { titleFallback: 'Transcription started' },
  transcription_paused: { titleFallback: 'Transcription paused' },
  transcription_stopped: { titleFallback: 'Transcription stopped' },
  notes_ready: { titleFallback: 'Notes ready' },
  drive_sync_complete: { titleFallback: 'Synced to Drive' },
  drive_sync_failed: { titleFallback: 'Drive sync failed' },
  follow_up_ready: { titleFallback: 'Follow-up draft ready' },
  action_due: { titleFallback: 'Action item due' },
  private_meeting: { titleFallback: 'Private meeting active' },
  transcription_warn: { titleFallback: 'Transcription quota warning' },
  transcription_hard_stop: { titleFallback: 'Transcription stopped — quota reached' },
  automation: { titleFallback: 'Automation ran' },
  retention: { titleFallback: 'Retention complete' },
};

// Internal kinds that should never become a visible notification.
const SUPPRESSED_KINDS = new Set(['lock', 'unlock', 'app_lock_unlocked']);

const GENERIC_TITLE = 'Cherios';

export class NotificationsService {
  private subscribed = false;
  private readonly listener = (n: NotificationEvent) => this.handle(n);

  async start(): Promise<void> {
    if (this.subscribed) return;
    if (!Notification.isSupported()) {
      logger.warn('Native notifications not supported on this platform');
      return;
    }
    bus.on('notification', this.listener);
    this.subscribed = true;
    logger.info('Notifications service started');
  }

  async stop(): Promise<void> {
    if (!this.subscribed) return;
    bus.off('notification', this.listener);
    this.subscribed = false;
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------
  private handle(event: NotificationEvent): void {
    try {
      if (!event || !event.kind) return;

      // 1) Tray-driven and internal lock signals: skip.
      if (event.kind.startsWith('tray')) return;
      if (SUPPRESSED_KINDS.has(event.kind)) return;

      // 2) If the app is locked, hold everything back — we don't want
      //    notification banners to leak content past the lock screen.
      const settings = getSettings();
      if (settings.app_lock_enabled && services.appLock?.isLocked()) {
        logger.debug('Suppressing notification while locked', { kind: event.kind });
        return;
      }

      const preset = KIND_PRESETS[event.kind] ?? {};
      const hidePreview = Boolean(settings.hide_notification_previews);

      const title = hidePreview
        ? GENERIC_TITLE
        : (event.title || preset.titleFallback || GENERIC_TITLE);
      const body = hidePreview
        ? undefined
        : (event.body ?? preset.body);

      const n = new Notification({
        title,
        body,
        silent: false,
      });

      n.on('click', () => this.handleClick(event));
      n.show();
    } catch (err) {
      logger.error('Failed to surface notification', { err: String(err), kind: event?.kind });
    }
  }

  private handleClick(event: NotificationEvent): void {
    // Bring the app forward so the user lands on something useful.
    const all = BrowserWindow.getAllWindows();
    const target = all.find((w) => !w.isDestroyed());
    if (target) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }
    // Fan out to the renderer so it can navigate (open the meeting,
    // jump to action items, etc.).
    bus.emit('notification', {
      kind: 'notification_clicked',
      title: event.title,
      body: event.body,
      meetingId: event.meetingId,
    });
  }
}

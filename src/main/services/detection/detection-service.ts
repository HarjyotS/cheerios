/**
 * MeetingDetectionService — runs a polling loop that fuses signals from the
 * process scanner, browser tab detector, mic monitor, calendar, and (where
 * available) recent speech to decide whether the user is currently in a
 * meeting. Spec §6.
 *
 * When the detection state changes the service emits `meeting_detected` on
 * the event bus. If `auto_start_mode` says we should auto-start, the service
 * creates a Meeting row and asks Deepgram to start streaming.
 */
import type {
  CalendarEvent,
  DetectedMeeting,
  DetectionSignal,
  Settings,
  SourceApp,
} from '@shared/types/entities';
import type { CalendarService } from '../calendar/calendar-service';
import { Meetings, DetectionRules, CalendarEvents } from '@main/db/repositories';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { services } from '@main/lib/service-registry';

import { processScanner, classifyProcessName, type DetectedProcess } from './process-scanner';
import { browserTabDetector, type DetectedBrowserMeeting } from './browser-tab-detector';
import { micMonitor, type MicProcess } from './mic-monitor';
import { speechDetector } from './speech-detector';

const logger = log('detection');

const POLL_INTERVAL_MS = 3_000;
const IGNORE_ONCE_MS = 15 * 60 * 1000;

interface IgnoreRuleRow {
  id: string;
  source_app: string | null;
  domain: string | null;
  person_id: string | null;
  company_id: string | null;
  calendar_event_id: string | null;
}
interface AlwaysStartRuleRow {
  id: string;
  source_app: string | null;
  domain: string | null;
  calendar_event_id: string | null;
}

export class MeetingDetectionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private detected: DetectedMeeting | null = null;
  private transientIgnores = new Map<string, number>();
  /** Meeting id this service auto-started, if any. Prevents double-start. */
  private autoStartedMeetingId: string | null = null;

  constructor(private calendar: CalendarService) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('MeetingDetectionService starting');
    // Run an immediate poll so callers don't have to wait for the first tick.
    this.tick().catch((err) => logger.warn('initial detection tick failed', { err: String(err) }));
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.warn('detection tick failed', { err: String(err) }));
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detected = null;
    this.autoStartedMeetingId = null;
    logger.info('MeetingDetectionService stopped');
  }

  current(): DetectedMeeting | null {
    return this.detected;
  }

  ignoreOnce(detected?: DetectedMeeting | null): void {
    const target = detected ?? this.detected;
    if (!target) return;
    this.transientIgnores.set(ignoreKey(target), Date.now() + IGNORE_ONCE_MS);
    this.maybeEmit(null);
  }

  // ------------------------------------------------------------------
  // Internal poll
  // ------------------------------------------------------------------
  private async tick(): Promise<void> {
    if (this.polling) return; // skip overlapping ticks
    this.polling = true;
    try {
      const settings = getSettings();

      // Suppress detection entirely while we're already capturing into a
      // live meeting — otherwise our own mic activity would cause repeated
      // prompts. The detection prompt is for OTHER apps holding the mic.
      const liveMeeting = Meetings.list().some((m) => !m.ended_at);
      if (liveMeeting) {
        this.maybeEmit(null);
        return;
      }

      const [processes, micSnap, calendarEvent] = await Promise.all([
        processScanner.scan(),
        micMonitor.snapshot(),
        this.calendar.forNow().catch(() => null),
      ]);

      const enabledProcesses = processes.filter((p) => isAppEnabled(p.sourceApp, settings));
      const browserMeeting = shouldInspectBrowserTabs(settings, enabledProcesses, micSnap.processes)
        ? await browserTabDetector.detect().catch(() => null)
        : null;
      const enabledBrowserMeeting =
        browserMeeting && isAppEnabled(browserMeeting.sourceApp, settings) ? browserMeeting : null;

      const signal = this.buildSignal({
        processes: enabledProcesses,
        browserMeeting: enabledBrowserMeeting,
        micActive: micSnap.active,
        calendarEvent,
      });

      const detected = this.computeDetected(signal, enabledProcesses, enabledBrowserMeeting, calendarEvent, micSnap.processes);

      if (detected && detected.confidence === 'low' && !settings.show_low_confidence_detection) {
        this.maybeEmit(null);
        return;
      }

      if (detected && this.matchesTransientIgnore(detected)) {
        logger.debug('detection suppressed by transient ignore', { source: detected.source_app });
        this.maybeEmit(null);
        return;
      }

      // Apply ignore rules — they always take precedence over alwaysStart.
      if (detected && this.matchesIgnoreRule(detected)) {
        logger.debug('detection suppressed by ignore rule', { source: detected.source_app });
        this.maybeEmit(null);
        return;
      }

      this.maybeEmit(detected);

      if (detected) {
        await this.maybeAutoStart(detected, settings);
      } else {
        // Detection cleared — drop our auto-start tracker so a future detection
        // can auto-start again. The actual stop is handled by MeetingStateDetector.
        this.autoStartedMeetingId = null;
      }
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------
  // Signal fusion
  // ------------------------------------------------------------------
  private buildSignal(input: {
    processes: DetectedProcess[];
    browserMeeting: DetectedBrowserMeeting | null;
    micActive: boolean;
    calendarEvent: CalendarEvent | null;
  }): DetectionSignal {
    const primary =
      input.browserMeeting?.sourceApp ??
      input.processes.find((p) => p.sourceApp !== 'browser')?.sourceApp ??
      input.processes[0]?.sourceApp;

    return {
      source_app: primary,
      process_name: input.processes[0]?.command,
      window_title: input.browserMeeting?.title,
      browser_url: privateBrowserSignalUrl(input.browserMeeting?.url),
      microphone_active: input.micActive,
      system_audio_active: false, // we don't sniff system audio passively
      human_speech_detected: speechDetector.humanSpeechDetected(),
      calendar_event_active: input.calendarEvent ?? null,
      foreground_app: undefined,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Decide whether to fire detection. Primary trigger is mic activity in any
   * non-our, non-system-daemon process (already filtered by mic-monitor).
   * Browser tabs and meeting-app processes are used to *label* the source
   * but are no longer required to fire — opening the mic from any app the
   * user uses for meetings is enough.
   *
   * Confidence ladder:
   *   HIGH   = browser tab / meeting app match + calendar event
   *   MEDIUM = browser tab / meeting app match
   *   LOW    = mic active in an unrecognized app (still fires; user can ignore)
   */
  private computeDetected(
    signal: DetectionSignal,
    processes: DetectedProcess[],
    browserMeeting: DetectedBrowserMeeting | null,
    calendarEvent: CalendarEvent | null,
    micProcesses: MicProcess[] = [],
  ): DetectedMeeting | null {
    const knownAppFromBrowser = browserMeeting?.sourceApp;
    // Native (non-browser) meeting app process, in priority order.
    const nativeMeetingApp = processes.find(
      (p) => p.sourceApp !== 'browser' && p.sourceApp !== 'unknown',
    );
    const hasKnownApp = Boolean(knownAppFromBrowser || nativeMeetingApp);

    // Bail if we have nothing to go on.
    if (!hasKnownApp && !signal.microphone_active) return null;

    // Try to identify which app holds the mic from the lsof process names.
    // We strip "(GPU)", "(Renderer)" etc. helper suffixes so "Google Chrome
    // Helper (GPU)" still classifies as browser.
    const micProc = micProcesses[0];
    const micProcAppName = micProc ? cleanProcessName(micProc.name) : undefined;
    const micProcSourceApp = micProcAppName ? classifyProcessName(micProcAppName) : null;

    const sourceApp: SourceApp =
      knownAppFromBrowser ??
      nativeMeetingApp?.sourceApp ??
      micProcSourceApp ??
      (processes.length > 0 ? processes[0].sourceApp : 'unknown');

    // Display label for unknown apps: use the cleaned process name so the
    // toast can say "Mic active in Spotify" instead of "Mic active in Unknown".
    const fallbackLabel = micProcAppName;

    // 1. Browser tab matches a real meeting URL — strongest single signal.
    if (knownAppFromBrowser) {
      const confidence: DetectedMeeting['confidence'] =
        signal.microphone_active || calendarEvent ? 'high' : 'medium';
      return {
        source_app: sourceApp,
        title: browserMeeting?.title || calendarEvent?.title || titleFromSourceApp(sourceApp),
        attendees: calendarEvent?.attendees?.map((a) => a.email).filter(Boolean) ?? [],
        calendar_event: calendarEvent,
        confidence,
        signals: { ...signal, process_name: micProcAppName ?? signal.process_name },
      };
    }

    // 2. Mic is active in any non-system, non-our app. Fire detection so the
    //    toast can ask the user whether to take notes. The user can dismiss
    //    or "Never for this app" if it's a false positive (Voice Memos /
    //    Music / etc.).
    if (signal.microphone_active) {
      const confidence: DetectedMeeting['confidence'] =
        nativeMeetingApp || micProcSourceApp ? (calendarEvent ? 'high' : 'medium') : 'low';
      return {
        source_app: sourceApp,
        title:
          calendarEvent?.title ||
          (sourceApp !== 'unknown' ? titleFromSourceApp(sourceApp) : fallbackLabel ?? 'Meeting'),
        attendees: calendarEvent?.attendees?.map((a) => a.email).filter(Boolean) ?? [],
        calendar_event: calendarEvent,
        confidence,
        signals: { ...signal, process_name: micProcAppName ?? signal.process_name },
      };
    }

    // Native app open but mic not yet on — wait until they actually start.
    return null;
  }

  // ------------------------------------------------------------------
  // Ignore / always-start rules
  // ------------------------------------------------------------------
  private matchesIgnoreRule(detected: DetectedMeeting): boolean {
    let rules: IgnoreRuleRow[];
    try {
      rules = DetectionRules.ignore.list() as IgnoreRuleRow[];
    } catch {
      return false;
    }
    if (rules.length === 0) return false;
    const url = detected.signals.browser_url ?? '';
    const calendarExternalId = detected.calendar_event?.external_id ?? null;
    for (const rule of rules) {
      if (rule.source_app && rule.source_app === detected.source_app) return true;
      if (rule.domain && url.toLowerCase().includes(rule.domain.toLowerCase())) return true;
      if (rule.calendar_event_id && calendarExternalId && rule.calendar_event_id === calendarExternalId) return true;
    }
    return false;
  }

  private matchesTransientIgnore(detected: DetectedMeeting): boolean {
    const key = ignoreKey(detected);
    const until = this.transientIgnores.get(key);
    if (!until) return false;
    if (until <= Date.now()) {
      this.transientIgnores.delete(key);
      return false;
    }
    return true;
  }

  private matchesAlwaysStart(detected: DetectedMeeting): boolean {
    let rules: AlwaysStartRuleRow[];
    try {
      rules = DetectionRules.alwaysStart.list() as AlwaysStartRuleRow[];
    } catch {
      return false;
    }
    if (rules.length === 0) return false;
    const url = detected.signals.browser_url ?? '';
    const calendarExternalId = detected.calendar_event?.external_id ?? null;
    for (const rule of rules) {
      if (rule.source_app && rule.source_app === detected.source_app) return true;
      if (rule.domain && url.toLowerCase().includes(rule.domain.toLowerCase())) return true;
      if (rule.calendar_event_id && calendarExternalId && rule.calendar_event_id === calendarExternalId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Emit / change detection
  // ------------------------------------------------------------------
  private maybeEmit(next: DetectedMeeting | null): void {
    const prev = this.detected;
    if (!detectedEqual(prev, next)) {
      this.detected = next;
      if (next) {
        logger.info('meeting detected', {
          source: next.source_app,
          confidence: next.confidence,
          title: next.title,
        });
        bus.emit('meeting_detected', next);
      } else if (prev) {
        logger.info('meeting detection cleared', { previous: prev.source_app });
        bus.emit('meeting_detected', null);
      }
    }
  }

  // ------------------------------------------------------------------
  // Auto-start
  // ------------------------------------------------------------------
  private async maybeAutoStart(detected: DetectedMeeting, settings: Settings): Promise<void> {
    if (this.autoStartedMeetingId) return; // already auto-started for this detection cycle

    const mode = settings.auto_start_mode;
    if (mode === 'never' || mode === 'ask') return;

    const matchesAlways = this.matchesAlwaysStart(detected);

    let shouldStart = matchesAlways;
    if (!shouldStart) {
      switch (mode) {
        case 'all':
          shouldStart = true;
          break;
        case 'calendar':
          shouldStart = Boolean(detected.calendar_event);
          break;
        case 'known_apps':
          shouldStart = detected.source_app !== 'unknown' && detected.source_app !== 'browser';
          // browser-with-known-meeting (google_meet etc.) qualifies because we
          // already mapped sourceApp upstream. So "browser" alone (unknown URL)
          // does not auto-start, but google_meet/zoom/etc. do.
          break;
      }
    }

    if (!shouldStart) return;

    try {
      // Resolve / cache calendar event row id (if any) so we can store the
      // foreign key on the Meeting.
      let calendarEventLocalId: string | null = null;
      if (detected.calendar_event) {
        const cached = CalendarEvents.byExternalId(
          detected.calendar_event.provider,
          detected.calendar_event.external_id,
        );
        calendarEventLocalId = cached?.id ?? detected.calendar_event.id ?? null;
      }

      const meeting = Meetings.create({
        title: detected.title || titleFromSourceApp(detected.source_app),
        source_app: detected.source_app,
        calendar_event_id: calendarEventLocalId,
        detection_confidence: detected.confidence,
        privacy_mode: settings.default_privacy_mode,
      });

      this.autoStartedMeetingId = meeting.id;
      logger.info('auto-starting meeting', {
        meetingId: meeting.id,
        source: detected.source_app,
        mode,
      });

      // Lazy lookup: services.deepgram is wired after construction.
      try {
        await services.deepgram?.startForMeeting(meeting.id);
      } catch (err) {
        logger.warn('deepgram failed to start; meeting row remains', {
          meetingId: meeting.id,
          err: String(err),
        });
      }

      bus.emit('meeting_started', meeting);
    } catch (err) {
      logger.error('auto-start failed', { err: String(err) });
    }
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function isAppEnabled(app: SourceApp, s: Settings): boolean {
  switch (app) {
    case 'zoom':
      return s.detect_zoom;
    case 'google_meet':
      return s.detect_google_meet;
    case 'microsoft_teams':
      return s.detect_teams;
    case 'slack_huddle':
      return s.detect_slack;
    case 'webex':
      return s.detect_webex;
    case 'discord':
      return s.detect_discord;
    case 'facetime':
      return s.detect_facetime;
    case 'browser':
      return s.detect_browser_calls;
    case 'unknown':
      return true;
    default:
      return true;
  }
}

/**
 * Strip Electron/Chromium-style helper suffixes from a process name so we
 * can classify or display "Google Chrome Helper (GPU)" as "Google Chrome".
 */
function cleanProcessName(raw: string): string {
  return raw
    .replace(/\s+Helper\s*\([^)]*\)\s*$/, '')
    .replace(/\s+Helper\s*$/, '')
    .replace(/\s+\(GPU\)\s*$/, '')
    .replace(/\s+\(Renderer\)\s*$/, '')
    .replace(/\s+\(Plugin\)\s*$/, '')
    .trim();
}

function titleFromSourceApp(app: SourceApp): string {
  switch (app) {
    case 'zoom':
      return 'Zoom Meeting';
    case 'google_meet':
      return 'Google Meet';
    case 'microsoft_teams':
      return 'Teams Meeting';
    case 'slack_huddle':
      return 'Slack Huddle';
    case 'webex':
      return 'Webex Meeting';
    case 'discord':
      return 'Discord Call';
    case 'facetime':
      return 'FaceTime Call';
    case 'browser':
      return 'Browser Meeting';
    default:
      return 'Meeting';
  }
}

function shouldInspectBrowserTabs(
  settings: Settings,
  processes: DetectedProcess[],
  micProcesses: MicProcess[],
): boolean {
  if (!settings.detect_browser_calls) return false;
  if (micProcesses.length === 0) return false;
  const browserRunning = processes.some((p) => p.sourceApp === 'browser');
  if (!browserRunning) return false;
  return micProcesses.some((p) => classifyProcessName(cleanProcessName(p.name)) === 'browser');
}

function privateBrowserSignalUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    return undefined;
  }
}

function ignoreKey(detected: DetectedMeeting): string {
  return [
    detected.source_app,
    detected.signals.process_name ?? '',
    detected.signals.browser_url ?? '',
    detected.calendar_event?.external_id ?? '',
  ].join('|');
}

function detectedEqual(a: DetectedMeeting | null, b: DetectedMeeting | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.source_app === b.source_app &&
    a.confidence === b.confidence &&
    (a.title ?? '') === (b.title ?? '') &&
    (a.calendar_event?.external_id ?? null) === (b.calendar_event?.external_id ?? null) &&
    a.signals.microphone_active === b.signals.microphone_active &&
    (a.signals.browser_url ?? '') === (b.signals.browser_url ?? '')
  );
}

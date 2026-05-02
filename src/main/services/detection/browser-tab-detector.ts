/**
 * Browser tab detector - read the active tab URL/title from running browsers
 * via osascript (AppleScript). Used to identify Google Meet / Zoom Web /
 * Teams / Slack huddles / Webex / Discord meetings happening inside a browser.
 *
 * macOS only. On other platforms this returns null gracefully.
 *
 * The caller gates this behind mic/calendar context; do not call this on an
 * idle polling loop. Each AppleScript snippet is wrapped in `if it is running
 * then` so we do not inadvertently launch a browser.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceApp } from '@shared/types/entities';
import { log } from '@main/lib/logger';

const execAsync = promisify(exec);
const logger = log('detection.browser');

export interface BrowserTabInfo {
  browser: 'chrome' | 'safari' | 'arc' | 'brave';
  url: string;
  title: string;
}

export interface DetectedBrowserMeeting {
  sourceApp: SourceApp;
  url: string;
  title: string;
  browser: BrowserTabInfo['browser'];
  /** Extracted meeting code if one is present in the URL. */
  meetingCode?: string;
}

/**
 * URL -> SourceApp mappings. Each entry has a regex that must match the URL
 * and an optional capture group for a "meeting code" we can use as a title
 * fallback. Patterns are applied in order; first match wins.
 */
const URL_PATTERNS: Array<{ pattern: RegExp; sourceApp: SourceApp; codeGroup?: number }> = [
  // Google Meet - meet codes follow `xxx-xxxx-xxx` (3-4-3 lowercase letters).
  // Avoids matching the marketing landing page `meet.google.com/landing`.
  { pattern: /https?:\/\/meet\.google\.com\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})/i, sourceApp: 'google_meet', codeGroup: 1 },
  // Zoom web client variants: /j/<id>, /wc/<id>, /s/<id>
  { pattern: /https?:\/\/(?:[^\/]+\.)?zoom\.us\/(?:j|wc|s|wc\/join)\/(\d+)/i, sourceApp: 'zoom', codeGroup: 1 },
  // Teams meet-join URLs
  { pattern: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\//i, sourceApp: 'microsoft_teams' },
  { pattern: /https?:\/\/teams\.live\.com\/meet\//i, sourceApp: 'microsoft_teams' },
  // Slack huddles open inside the web app under a deep path
  { pattern: /https?:\/\/app\.slack\.com\/.+\/huddle/i, sourceApp: 'slack_huddle' },
  // Webex personal-room and meeting URLs
  { pattern: /https?:\/\/[^\/]*webex\.com\/(?:meet|join|webappng|wbxmjs)/i, sourceApp: 'webex' },
  // Discord voice/stage channels - URL contains /channels/<guild>/<channel>
  // and the active call is signaled by the page title; we conservatively
  // match only when the path contains "/voice" or "/call".
  { pattern: /https?:\/\/discord\.com\/channels\/.+\/(?:voice|call)/i, sourceApp: 'discord' },
];

export class BrowserTabDetector {
  /**
   * Probe each supported browser for its active tab and return the first
   * recognized meeting URL. Returns null if no browser is running, no
   * frontmost tab matches a meeting pattern, or detection fails.
   */
  async detect(): Promise<DetectedBrowserMeeting | null> {
    if (process.platform !== 'darwin') return null;
    const probes = await Promise.all([
      this.probeChrome(),
      this.probeArc(),
      this.probeBrave(),
      this.probeSafari(),
    ]);
    for (const tab of probes) {
      if (!tab) continue;
      const meeting = this.classify(tab);
      if (meeting) {
        if (!this.lastReported || this.lastReported !== meeting.url) {
          logger.info('browser meeting detected', {
            browser: meeting.browser,
            sourceApp: meeting.sourceApp,
            host: hostFromUrl(meeting.url),
          });
          this.lastReported = meeting.url;
        }
        return meeting;
      }
    }
    if (this.lastReported) {
      logger.debug('browser meeting cleared');
      this.lastReported = null;
    }
    return null;
  }

  /** Last raw meeting URL seen internally so we don't spam detection logs. */
  private lastReported: string | null = null;

  /**
   * Classify an arbitrary tab as a meeting or not. Exposed so other code
   * (e.g. tests, calendar-link matching) can reuse the URL classifier.
   */
  classify(tab: BrowserTabInfo): DetectedBrowserMeeting | null {
    for (const entry of URL_PATTERNS) {
      const m = tab.url.match(entry.pattern);
      if (!m) continue;
      const code = entry.codeGroup ? m[entry.codeGroup] : undefined;
      return {
        sourceApp: entry.sourceApp,
        url: tab.url,
        title: tab.title,
        browser: tab.browser,
        meetingCode: code,
      };
    }
    return null;
  }

  // -- per-browser AppleScript probes ----------------------------------------

  private async probeChrome(): Promise<BrowserTabInfo | null> {
    return this.runOsa('Google Chrome', 'chrome', [
      'tell application "Google Chrome"',
      '  if not (it is running) then return ""',
      '  if (count of windows) is 0 then return ""',
      '  set theURL to URL of active tab of front window',
      '  set theTitle to title of active tab of front window',
      '  return theURL & "\\n" & theTitle',
      'end tell',
    ]);
  }

  private async probeArc(): Promise<BrowserTabInfo | null> {
    // Arc exposes the same scripting interface as Chromium. The bundle is
    // identified to AppleScript as "Arc".
    return this.runOsa('Arc', 'arc', [
      'tell application "Arc"',
      '  if not (it is running) then return ""',
      '  if (count of windows) is 0 then return ""',
      '  set theURL to URL of active tab of front window',
      '  set theTitle to title of active tab of front window',
      '  return theURL & "\\n" & theTitle',
      'end tell',
    ]);
  }

  private async probeBrave(): Promise<BrowserTabInfo | null> {
    return this.runOsa('Brave Browser', 'brave', [
      'tell application "Brave Browser"',
      '  if not (it is running) then return ""',
      '  if (count of windows) is 0 then return ""',
      '  set theURL to URL of active tab of front window',
      '  set theTitle to title of active tab of front window',
      '  return theURL & "\\n" & theTitle',
      'end tell',
    ]);
  }

  private async probeSafari(): Promise<BrowserTabInfo | null> {
    // Safari uses different scripting nouns (current tab vs active tab) and
    // the "name" of the tab as its title.
    return this.runOsa('Safari', 'safari', [
      'tell application "Safari"',
      '  if not (it is running) then return ""',
      '  if (count of windows) is 0 then return ""',
      '  set theURL to URL of current tab of front window',
      '  set theTitle to name of current tab of front window',
      '  return theURL & "\\n" & theTitle',
      'end tell',
    ]);
  }

  /**
   * Execute an AppleScript snippet that returns "<url>\n<title>" and parse
   * the result. Returns null on any error or empty output.
   */
  private async runOsa(
    appLabel: string,
    browser: BrowserTabInfo['browser'],
    scriptLines: string[],
  ): Promise<BrowserTabInfo | null> {
    // Each "-e" arg is a separate AppleScript line; this avoids needing to
    // escape newlines/quotes inside a single-string script.
    const args = scriptLines.flatMap((line) => ['-e', line]);
    try {
      const { stdout } = await execAsync(
        `/usr/bin/osascript ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
        { timeout: 2_000, maxBuffer: 256 * 1024 },
      );
      const text = stdout.trim();
      if (!text) return null;
      const newlineIdx = text.indexOf('\n');
      const url = newlineIdx >= 0 ? text.slice(0, newlineIdx).trim() : text.trim();
      const title = newlineIdx >= 0 ? text.slice(newlineIdx + 1).trim() : '';
      if (!url) return null;
      return { browser, url, title };
    } catch (err) {
      // Browser not running, no permission, or AppleScript timeout — log at
      // info the first time we see a "not authorized" error per browser so
      // the user can see they need to grant Automation access.
      const msg = String(err);
      const seenKey = `${browser}:${/not authorised|not allowed|errAEEventNotPermitted|-1743|-600/i.test(msg) ? 'denied' : 'other'}`;
      if (!this.loggedFailures.has(seenKey)) {
        this.loggedFailures.add(seenKey);
        if (/not authorised|not allowed|errAEEventNotPermitted|-1743|-600/i.test(msg)) {
          logger.info(
            `Automation permission likely missing for ${appLabel}. ` +
              `Grant in System Settings → Privacy & Security → Automation → Electron → ${appLabel}.`,
          );
        } else {
          logger.debug('osascript probe failed', { app: appLabel, err: msg });
        }
      }
      return null;
    }
  }

  private loggedFailures = new Set<string>();
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return 'unknown';
  }
}

export const browserTabDetector = new BrowserTabDetector();

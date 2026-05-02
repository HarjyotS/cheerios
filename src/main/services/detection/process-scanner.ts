/**
 * Process scanner — wraps `ps -A -o pid=,comm=` to enumerate running processes
 * and map them to known meeting apps. Polled by MeetingDetectionService.
 *
 * Spec §6: signals include "known meeting app process running and foreground".
 * For pragmatic personal-use detection we only care that the process is alive;
 * foreground-ness is left to other signals (mic activity, browser tab).
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceApp } from '@shared/types/entities';
import { log } from '@main/lib/logger';

const execAsync = promisify(exec);
const logger = log('detection.process');

export interface DetectedProcess {
  pid: number;
  command: string;
  sourceApp: SourceApp;
}

/**
 * Mapping from process command (basename of `ps -A -o comm=`) to SourceApp.
 * Keys are lowercased to make matching case-insensitive. Values can be matched
 * either as exact basename or substring depending on the matcher below.
 *
 * NOTE: macOS `comm` returns the full path (e.g. `/Applications/zoom.us.app/...`).
 * We strip path then lowercase before matching.
 */
const PROCESS_MAP: Array<{ patterns: string[]; sourceApp: SourceApp }> = [
  { patterns: ['zoom.us', 'zoom'], sourceApp: 'zoom' },
  { patterns: ['microsoft teams', 'msteams', 'teams', 'teams (work or school)'], sourceApp: 'microsoft_teams' },
  { patterns: ['slack'], sourceApp: 'slack_huddle' },
  { patterns: ['webex', 'cisco webex meetings', 'webexmeetings', 'webexhost'], sourceApp: 'webex' },
  { patterns: ['discord'], sourceApp: 'discord' },
  { patterns: ['facetime'], sourceApp: 'facetime' },
  // Browsers — coarse "browser" classification; refined by browser-tab-detector.
  { patterns: ['google chrome', 'chrome'], sourceApp: 'browser' },
  { patterns: ['arc'], sourceApp: 'browser' },
  { patterns: ['safari'], sourceApp: 'browser' },
  { patterns: ['brave browser', 'brave'], sourceApp: 'browser' },
];

export class ProcessScanner {
  /**
   * Scan all running processes and return those that match a known meeting app.
   * Returns empty array on any error (never throws — detection runs on a tight
   * loop and a transient failure must not crash the service).
   */
  async scan(): Promise<DetectedProcess[]> {
    try {
      // `-A` lists all processes, `-o pid=,comm=` strips headers and prints
      // "<pid> <command>". The trailing `=` on each column tells `ps` to omit
      // its label, giving us pure data. `comm` is the executable basename on
      // BSD/macOS, which is what we want for matching.
      const { stdout } = await execAsync('ps -A -o pid=,comm=', {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5_000,
      });
      return this.parse(stdout);
    } catch (err) {
      logger.debug('process scan failed', { err: String(err) });
      return [];
    }
  }

  /**
   * Parse `ps` output into matched DetectedProcess entries. Exposed for tests
   * and to keep the I/O-free part separately reasonable.
   */
  parse(stdout: string): DetectedProcess[] {
    const out: DetectedProcess[] = [];
    const seenPids = new Set<number>();
    const lines = stdout.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // First whitespace separates pid from the command path. The command path
      // may itself contain spaces (e.g. "Microsoft Teams"), so split only once.
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const fullCmd = m[2];
      // Take basename so "/Applications/Slack.app/Contents/MacOS/Slack" → "Slack".
      const basename = fullCmd.split('/').pop() ?? fullCmd;
      const lower = basename.toLowerCase();

      const match = PROCESS_MAP.find((entry) =>
        entry.patterns.some((p) => lower === p || lower.includes(p)),
      );
      if (!match) continue;
      if (seenPids.has(pid)) continue;
      seenPids.add(pid);
      out.push({ pid, command: basename, sourceApp: match.sourceApp });
    }
    return out;
  }
}

export const processScanner = new ProcessScanner();

/**
 * Classify any process name (e.g. from `lsof` output, where helper names
 * like "Google Chrome Helper (GPU)" or "Slack Helper" appear) into a
 * SourceApp using the same patterns as the foreground process scanner.
 * Returns null if no pattern matches — the caller can fall back to
 * displaying the raw process name.
 */
export function classifyProcessName(name: string): SourceApp | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  const match = PROCESS_MAP.find((entry) => entry.patterns.some((p) => lower.includes(p)));
  return match?.sourceApp ?? null;
}

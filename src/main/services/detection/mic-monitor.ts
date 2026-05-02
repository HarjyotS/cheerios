/**
 * Mic monitor — detect which (if any) processes currently hold the
 * microphone open. Polled every 3 seconds by the detection service.
 *
 * macOS does not expose a stable, sandbox-friendly API for "which app is
 * using the mic?". We therefore use a best-effort, layered approach:
 *
 *   1. IORegistry — ask whether an input audio device is actually running.
 *      This tracks the same user-visible state as macOS's orange mic indicator.
 *   2. `lsof` — ask which processes have audio-related drivers open.
 *      This is broad, so we only use it to label the app in the prompt.
 *
 * Detection MUST never throw — on any error we return `{ active: false, pids: [] }`.
 *
 * The shell incantations below look strange; they are deliberately broad
 * because the names of audio kexts/services vary across macOS versions:
 *
 *   - `AppleHDA`         — built-in HDA audio (older Intel Macs, some externals)
 *   - `VoiceProcessingIO` — Apple's voice-processing AudioUnit, used by most VoIP apps
 *   - `CoreAudio`         — daemon `coreaudiod` brokers all audio I/O
 *   - `AudioCoreUnit`     — Apple Silicon coreaudio plugin
 *   - `AppleHDAEngineInput` — input engine specifically (microphones)
 */
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = log('detection.mic');

export interface MicProcess {
  pid: number;
  /** Process command name as seen by lsof (e.g. "Google Chrome Helper (GPU)"). */
  name: string;
}

export interface MicSnapshot {
  /** True when at least one non-system, non-own process appears to be using the mic. */
  active: boolean;
  /** PIDs that hold an audio driver / coreaudiod handle (already filtered). */
  pids: number[];
  /** Filtered processes — system daemons and our own helpers stripped. */
  processes: MicProcess[];
  /** When the check ran. */
  takenAt: number;
}

const EMPTY: MicSnapshot = { active: false, pids: [], processes: [], takenAt: 0 };

const IOREG_TIMEOUT_MS = 1_500;
const LSOF_TIMEOUT_MS = 2_000;

/**
 * Process names belonging to the OS itself; if these are the *only* hits we
 * shouldn't conclude the mic is in use. coreaudiod always holds the device.
 */
const SYSTEM_AUDIO_PROCESSES = new Set([
  'coreaudiod',
  'audioaccessoryd',
  'audioclocksyncd',
  'audioanalyticsd',
  'audiomxd',
  'mediaserverd',
  'launchd',
  'WindowServer',
  'loginwindow',
]);

/**
 * Process-name fragments belonging to OUR OWN app. When we're recording, the
 * Electron renderer holds the mic via WebAudio; we must not treat that as
 * "another app is in a call" or the detection prompt would loop forever.
 */
const OWN_APP_NAME_FRAGMENTS = [
  'electron',
  'cherios',
  'granola',
  'codex',
  'personal meeting os',
];

const PREFERRED_MIC_PROCESS_PATTERNS = [
  /google chrome/i,
  /\bchrome\b/i,
  /\barc\b/i,
  /brave/i,
  /safari/i,
  /zoom/i,
  /teams/i,
  /slack/i,
  /discord/i,
  /facetime/i,
  /webex/i,
];

function isOwnProcess(name: string): boolean {
  const lower = name.toLowerCase();
  return OWN_APP_NAME_FRAGMENTS.some((frag) => lower.includes(frag));
}

export class MicMonitor {
  private last: MicSnapshot = EMPTY;

  /**
   * Take a fresh snapshot. Returns the cached value on failure.
   */
  async snapshot(): Promise<MicSnapshot> {
    if (process.platform !== 'darwin') {
      // On non-mac platforms we can't reliably detect mic use; return inactive
      // so the rest of the detection pipeline keeps working without crashing.
      return { ...EMPTY, takenAt: Date.now() };
    }
    try {
      const inputActive = await this.detectMacOSInputActive();
      const pids = inputActive === false ? [] : await this.detectMacOSProcesses();
      // Drop OS-owned and our-own processes before returning attribution.
      // The actual active/inactive decision is driven by IORegistry when
      // available; lsof is too broad to be trusted as the primary signal on
      // recent macOS because many apps keep CoreAudio handles open while idle.
      const external = rankMicProcesses(
        pids.filter((p) => !SYSTEM_AUDIO_PROCESSES.has(p.name) && !isOwnProcess(p.name)),
      );
      const active = inputActive ?? external.length > 0;
      const snap: MicSnapshot = {
        active,
        pids: active ? external.map((p) => p.pid) : [],
        processes: active ? external : [],
        takenAt: Date.now(),
      };
      this.last = snap;
      return snap;
    } catch (err) {
      logger.debug('mic snapshot failed; using last known', { err: String(err) });
      return this.last;
    }
  }

  /**
   * Synchronously return the most recent snapshot without performing any I/O.
   * Useful for callers that just need the cached state.
   */
  current(): MicSnapshot {
    return this.last;
  }

  /**
   * macOS active-input detection. Apple Silicon exposes input devices through
   * AppleSecondaryAudio; the device's "is running" property tracks whether an
   * input stream is actually live. This catches the case users care about:
   * Chrome/Meet/Zoom activates the laptop mic and macOS shows the orange mic
   * indicator.
   */
  private async detectMacOSInputActive(): Promise<boolean | null> {
    const modern = await this.detectAppleSecondaryAudioInput();
    if (modern !== null) return modern;
    return this.detectLegacyHdaInput();
  }

  private async detectAppleSecondaryAudioInput(): Promise<boolean | null> {
    let stdout = '';
    try {
      const r = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'AppleSecondaryAudio', '-w0', '-l'], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: IOREG_TIMEOUT_MS,
      });
      stdout = r.stdout;
    } catch (err) {
      logger.debug('AppleSecondaryAudio probe failed', { err: String(err) });
      return null;
    }
    return parseAppleSecondaryAudio(stdout);
  }

  private async detectLegacyHdaInput(): Promise<boolean | null> {
    let stdout = '';
    try {
      const r = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'AppleHDAEngineInput', '-w0', '-l'], {
        maxBuffer: 1024 * 1024,
        timeout: IOREG_TIMEOUT_MS,
      });
      stdout = r.stdout;
    } catch (err) {
      logger.debug('AppleHDAEngineInput probe failed', { err: String(err) });
      return null;
    }
    return parseLegacyHdaInput(stdout);
  }

  /**
   * macOS attribution: pipe lsof output through awk to find processes with
   * audio drivers open. This is only a best-effort label for the toast, not
   * the active/inactive signal.
   */
  private async detectMacOSProcesses(): Promise<Array<{ pid: number; name: string }>> {
    // Use `lsof -F pcn` to print machine-readable records, one field per line:
    //   p<pid>\nc<command>\nn<name>\n
    // This avoids fragile column-position parsing.
    //
    // We grep across a few audio-related driver/service names. If `lsof`
    // exits non-zero (common when grep finds nothing) we treat it as empty.
    const cmd =
      "/usr/sbin/lsof -nP -w -F pcn 2>/dev/null | " +
      "awk '/^p[0-9]+$/{pid=substr($0,2)} " +
      "/^c/{cmd=substr($0,2)} " +
      "/^n.*(AppleHDAEngineInput|VoiceProcessingIO|AudioCoreUnit|AppleHDA|CoreAudio|coreaudiod)/" +
      "{print pid \"\\t\" cmd}'";
    let stdout = '';
    try {
      const r = await execAsync(cmd, { maxBuffer: 4 * 1024 * 1024, timeout: LSOF_TIMEOUT_MS, shell: '/bin/bash' });
      stdout = r.stdout;
    } catch (err: any) {
      // grep/awk pipelines often exit 1 when nothing matches — that's not a real failure.
      if (err && typeof err === 'object' && 'stdout' in err) {
        stdout = String((err as { stdout: string }).stdout || '');
      } else {
        return [];
      }
    }
    const out: Array<{ pid: number; name: string }> = [];
    const seen = new Set<number>();
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const [pidStr, ...rest] = line.split('\t');
      const pid = Number(pidStr);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const name = (rest.join('\t') || '').trim();
      if (!name) continue;
      out.push({ pid, name });
    }
    return out;
  }
}

export const micMonitor = new MicMonitor();

function parseAppleSecondaryAudio(stdout: string): boolean | null {
  if (!stdout.trim()) return null;
  let sawInputDevice = false;
  const blocks = stdout.split(/\n\s*\n/);
  for (const block of blocks) {
    const hasInputStreams =
      /"input streams"\s*=\s*\(/.test(block) && !/"input streams"\s*=\s*\(\)/.test(block);
    if (!hasInputStreams) continue;
    sawInputDevice = true;
    if (/"is running"\s*=\s*Yes/.test(block)) return true;
  }
  return sawInputDevice ? false : null;
}

function parseLegacyHdaInput(stdout: string): boolean | null {
  if (!stdout.trim()) return null;
  const states = [...stdout.matchAll(/"IOAudioEngineState"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (states.length === 0) return null;
  return states.some((s) => Number.isFinite(s) && s > 0);
}

function rankMicProcesses(processes: MicProcess[]): MicProcess[] {
  return [...processes].sort((a, b) => micProcessRank(a.name) - micProcessRank(b.name));
}

function micProcessRank(name: string): number {
  if (PREFERRED_MIC_PROCESS_PATTERNS.some((pattern) => pattern.test(name))) return 0;
  if (/helper/i.test(name)) return 1;
  return 2;
}

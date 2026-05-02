/**
 * Speech detector — lightweight energy-based VAD.
 *
 * Spec calls for a "best-effort" indication that human speech occurred
 * recently. We avoid pulling in a real WebRTC VAD model — instead we compute
 * the RMS of incoming PCM frames and compare against an adaptive threshold.
 *
 * Frames arrive from AudioCaptureService via `pushFrames(channel, pcm)`.
 * PCM is assumed to be signed 16-bit little-endian (the format produced by
 * both the renderer mic capture and the macOS native helper).
 *
 * Speech "detection" is not strict — it just means "there was non-silent
 * audio energy in the last N seconds". That's enough for the auto-stop
 * heuristics in spec §7.
 */

export type AudioChannelLabel = 'mic' | 'system';

interface EnergyEvent {
  /** Wall-clock time (ms since epoch). */
  at: number;
  /** RMS of the frame, in normalized [0, 1] units. */
  rms: number;
  channel: AudioChannelLabel;
}

const MAX_HISTORY_MS = 10 * 60 * 1000; // keep up to 10 min of energy history
const RMS_THRESHOLD = 0.012; // ~ -38 dBFS — tuned to ignore quiet keyboard noise

export class SpeechDetector {
  private events: EnergyEvent[] = [];

  /**
   * Push a chunk of 16-bit PCM. Computes RMS and stores a single energy
   * event tagged with "now". Buffer is left untouched.
   */
  pushFrames(channel: AudioChannelLabel, pcm: Buffer): void {
    if (!pcm || pcm.length < 2) return;
    const rms = computeRms16le(pcm);
    const now = Date.now();
    this.events.push({ at: now, rms, channel });
    this.prune(now);
  }

  /**
   * Returns true if the detector has seen at least one frame in the last
   * `seconds` whose RMS exceeded the speech threshold.
   */
  recentlyActive(seconds: number): boolean {
    const cutoff = Date.now() - seconds * 1000;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.at < cutoff) break;
      if (e.rms >= RMS_THRESHOLD) return true;
    }
    return false;
  }

  /**
   * Convenience: any human speech in the last 60s.
   */
  humanSpeechDetected(): boolean {
    return this.recentlyActive(60);
  }

  /**
   * Drop events older than MAX_HISTORY_MS to keep memory bounded.
   */
  private prune(now: number): void {
    const cutoff = now - MAX_HISTORY_MS;
    if (this.events.length === 0) return;
    if (this.events[0].at >= cutoff) return;
    // Find first event >= cutoff and slice from there. Linear scan is fine —
    // the list is small (one event per audio frame ~50ms = ~12k entries max).
    let idx = 0;
    while (idx < this.events.length && this.events[idx].at < cutoff) idx++;
    this.events = this.events.slice(idx);
  }

  /** For tests / debugging. */
  reset(): void {
    this.events = [];
  }
}

/**
 * Compute the RMS amplitude of a buffer of signed 16-bit little-endian PCM
 * samples, normalized to [0, 1]. Returns 0 for empty input.
 */
function computeRms16le(buf: Buffer): number {
  const sampleCount = buf.length >>> 1; // 2 bytes per sample
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = buf.readInt16LE(i * 2);
    const norm = s / 32768; // [-1, 1]
    sumSquares += norm * norm;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export const speechDetector = new SpeechDetector();

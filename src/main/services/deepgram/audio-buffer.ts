/**
 * Rolling ring buffer for PCM audio data.
 *
 * Used by DeepgramStreamingService to keep the last N seconds of audio per
 * channel. When a Deepgram socket disconnects, we replay the buffer into the
 * fresh socket so we don't lose the in-flight utterance. Sized in bytes so we
 * don't have to assume a sample rate.
 *
 * The implementation is intentionally tiny — no Node Buffer pool gymnastics,
 * no streams. We push small Buffers as they arrive and drop oldest entries
 * once we exceed the byte budget.
 */
export class RollingAudioBuffer {
  private chunks: Buffer[] = [];
  private byteCount = 0;

  /**
   * @param maxBytes Maximum total bytes to retain. For 16kHz mono 16-bit PCM
   *                 (32 000 B/s), 60 seconds ≈ 1.92 MB.
   */
  constructor(private readonly maxBytes: number) {}

  push(buf: Buffer): void {
    if (buf.byteLength === 0) return;
    this.chunks.push(buf);
    this.byteCount += buf.byteLength;
    while (this.byteCount > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.byteCount -= dropped.byteLength;
    }
  }

  /** Snapshot of the current buffer contents as a single Buffer. */
  snapshot(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(this.chunks, this.byteCount);
  }

  size(): number {
    return this.byteCount;
  }

  clear(): void {
    this.chunks = [];
    this.byteCount = 0;
  }
}

/** Compute byte budget for `seconds` of mono 16-bit PCM at the given rate. */
export function bytesForSeconds(sampleRate: number, seconds: number): number {
  return sampleRate * 2 * seconds;
}

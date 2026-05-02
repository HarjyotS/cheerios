/**
 * pcm-downsampler AudioWorkletProcessor
 *
 * Receives Float32 frames at the AudioContext's sample rate (48 kHz expected),
 * mixes stereo (or higher) down to mono, downsamples to 16 kHz via fast linear
 * interpolation, converts to little-endian Int16 PCM, and posts the resulting
 * ArrayBuffer to the main thread roughly every 100 ms (1600 samples @ 16 kHz).
 *
 * NOTE: This file is plain JS — AudioWorkletProcessors are loaded directly
 * from a URL at runtime, so no transpilation step exists. A sibling
 * audio-worklet.ts file mirrors the message types for type-checking only.
 */

const TARGET_SAMPLE_RATE = 16000;
// 100 ms of audio at 16 kHz = 1600 samples. Posted as Int16 (2 bytes) = 3200 B.
const TARGET_FRAMES_PER_CHUNK = 1600;

class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // The position (fractional) we want to sample next from the input timeline.
    // Increments by `inputSampleRate / TARGET_SAMPLE_RATE` per output sample.
    this._inputPos = 0;
    // Carry the last input sample across process() calls so linear
    // interpolation can span buffer boundaries.
    this._lastInputSample = 0;
    // How many input samples we've consumed so far in the current "epoch".
    // We reset _inputPos relative to the start of each process() call to
    // avoid floating-point drift over long sessions.
    this._inputBuffered = 0;
    // Output Int16 buffer accumulating until we hit TARGET_FRAMES_PER_CHUNK.
    this._outBuffer = new Int16Array(TARGET_FRAMES_PER_CHUNK);
    this._outIndex = 0;
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean}
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      // No input connected this quantum — keep the processor alive.
      return true;
    }

    const channelCount = input.length;
    const frameCount = input[0].length;
    if (frameCount === 0) return true;

    // Mix all channels down to mono (simple average).
    let mono;
    if (channelCount === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frameCount);
      for (let ch = 0; ch < channelCount; ch++) {
        const data = input[ch];
        for (let i = 0; i < frameCount; i++) {
          mono[i] += data[i];
        }
      }
      const inv = 1 / channelCount;
      for (let i = 0; i < frameCount; i++) mono[i] *= inv;
    }

    const inputSampleRate = sampleRate; // global from AudioWorkletGlobalScope
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;

    // We logically prepend `_lastInputSample` so interpolation across boundary
    // works. Index -1 in our virtual timeline = _lastInputSample, indices 0..N-1
    // are this quantum's samples.
    // Start from where we left off (in the virtual timeline that begins at -1).
    let pos = this._inputPos;

    while (pos < frameCount) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? this._lastInputSample : mono[i0];
      const s1 = i0 + 1 < 0 ? this._lastInputSample : mono[i0 + 1];
      const sample = s0 + (s1 - s0) * frac;

      // Clamp + convert to Int16
      let s = sample;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._outBuffer[this._outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._outIndex >= TARGET_FRAMES_PER_CHUNK) {
        // Transfer a fresh copy so we can keep reusing _outBuffer.
        const out = new Int16Array(TARGET_FRAMES_PER_CHUNK);
        out.set(this._outBuffer);
        const buf = out.buffer;
        this.port.postMessage(buf, [buf]);
        this._outIndex = 0;
      }

      pos += ratio;
    }

    // Save the last actual sample of this quantum for boundary interpolation.
    this._lastInputSample = mono[frameCount - 1];
    // Carry over the fractional offset into the next quantum's timeline.
    this._inputPos = pos - frameCount;

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);

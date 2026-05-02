/**
 * Type-only mirror of public/audio-worklet.js.
 *
 * The actual processor is loaded at runtime from /audio-worklet.js (served from
 * src/renderer/public). This file exists purely so the rest of the renderer can
 * import the message shape and shared constants with type-checking. It is NOT
 * registered as a worklet and is not bundled into the worklet runtime.
 *
 * Keep these constants in sync with public/audio-worklet.js.
 */

export const PCM_DOWNSAMPLER_PROCESSOR = 'pcm-downsampler' as const;
export const PCM_TARGET_SAMPLE_RATE = 16000;
export const PCM_TARGET_FRAMES_PER_CHUNK = 1600;

/**
 * Messages posted by the worklet to the main (renderer) thread.
 *
 * The worklet sends a raw transferable ArrayBuffer (no envelope) — each chunk
 * is a little-endian Int16 PCM mono buffer at PCM_TARGET_SAMPLE_RATE.
 */
export type PCMWorkletMessage = ArrayBuffer;

// Reference shape only — see public/audio-worklet.js for the runtime impl.
export interface PCMDownsamplerProcessorLike {
  process(inputs: Float32Array[][]): boolean;
}

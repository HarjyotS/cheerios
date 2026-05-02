/**
 * MicCapture — captures microphone audio in the renderer, downsamples to
 * 16 kHz mono Int16 PCM via an AudioWorklet, and forwards each chunk to the
 * main process over the preload `window.audio` bridge.
 *
 * Lifecycle:
 *   const cap = new MicCapture(meetingId);
 *   await cap.start(deviceId?);  // throws on permission denied / no device
 *   // ...later...
 *   await cap.stop();
 *
 * System audio is captured separately by a native macOS helper, so this class
 * deliberately handles only the 'mic' channel.
 */

import {
  PCM_DOWNSAMPLER_PROCESSOR,
  PCM_TARGET_SAMPLE_RATE,
  type PCMWorkletMessage,
} from './audio-worklet';

const INPUT_SAMPLE_RATE = 48000;
const WORKLET_URL = '/audio-worklet.js';

const BUILT_IN_MIC_PATTERNS = [
  /macbook.*microphone/i,
  /built[- ]?in.*microphone/i,
  /internal.*microphone/i,
  /digital mic/i,
];

const HEADSET_MIC_PATTERNS = [
  /airpods/i,
  /bluetooth/i,
  /headset/i,
  /headphones/i,
  /beats/i,
  /bose/i,
  /sony/i,
  /wh-\d/i,
  /wf-\d/i,
];

export class MicCaptureError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'permission-denied'
      | 'no-device'
      | 'worklet-load-failed'
      | 'audio-context-failed'
      | 'unknown',
  ) {
    super(message);
    this.name = 'MicCaptureError';
  }
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private started = false;
  private stopping = false;

  constructor(private readonly meetingId: string) {}

  async start(deviceId?: string): Promise<void> {
    if (this.started) return;
    this.started = true;

    let stream: MediaStream;
    try {
      const resolvedDeviceId = deviceId ?? (await pickPreferredMicDeviceId());
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: resolvedDeviceId ? { exact: resolvedDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: INPUT_SAMPLE_RATE,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      this.started = false;
      const e = err as DOMException;
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        throw new MicCaptureError(
          'Microphone permission denied. Grant access in System Settings → Privacy & Security → Microphone.',
          'permission-denied',
        );
      }
      if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') {
        throw new MicCaptureError(
          'No matching microphone device was found.',
          'no-device',
        );
      }
      throw new MicCaptureError(
        `Failed to acquire microphone: ${e?.message ?? String(err)}`,
        'unknown',
      );
    }
    this.stream = stream;

    let audioContext: AudioContext;
    try {
      audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    } catch (err) {
      await this.cleanupOnError();
      throw new MicCaptureError(
        `Failed to create AudioContext: ${(err as Error).message}`,
        'audio-context-failed',
      );
    }
    this.audioContext = audioContext;

    try {
      await audioContext.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      await this.cleanupOnError();
      throw new MicCaptureError(
        `Failed to load audio worklet: ${(err as Error).message}`,
        'worklet-load-failed',
      );
    }

    const source = audioContext.createMediaStreamSource(stream);
    this.sourceNode = source;

    const worklet = new AudioWorkletNode(audioContext, PCM_DOWNSAMPLER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.workletNode = worklet;

    worklet.port.onmessage = (ev: MessageEvent<PCMWorkletMessage>) => {
      if (this.stopping) return;
      const buf = ev.data;
      if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
      try {
        window.audio.sendChunk(this.meetingId, 'mic', buf);
      } catch {
        // Bridge errors are non-fatal here — main may have torn down already.
      }
    };

    // Connect: mic source → worklet → silent destination.
    // We must connect to destination so the worklet is actually scheduled,
    // but we feed it through a zero-gain node to avoid any monitor playback.
    source.connect(worklet);
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    worklet.connect(muteGain).connect(audioContext.destination);

    try {
      window.audio.sendStart(this.meetingId, 'mic', PCM_TARGET_SAMPLE_RATE);
    } catch {
      // Non-fatal — chunks will still arrive; main side will accept lazily.
    }
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;

    try {
      if (this.workletNode) {
        try {
          this.workletNode.port.onmessage = null;
          this.workletNode.disconnect();
        } catch {
          /* ignore */
        }
        this.workletNode = null;
      }

      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch {
          /* ignore */
        }
        this.sourceNode = null;
      }

      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
        this.stream = null;
      }

      if (this.audioContext) {
        try {
          await this.audioContext.close();
        } catch {
          /* ignore */
        }
        this.audioContext = null;
      }

      try {
        window.audio.sendEnd(this.meetingId, 'mic');
      } catch {
        /* ignore */
      }
    } finally {
      this.started = false;
      this.stopping = false;
    }
  }

  private async cleanupOnError(): Promise<void> {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      this.stream = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        /* ignore */
      }
      this.audioContext = null;
    }
    this.started = false;
  }
}

async function pickPreferredMicDeviceId(): Promise<string | undefined> {
  if (!navigator.mediaDevices?.enumerateDevices) return undefined;
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return undefined;
  }

  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
  if (inputs.length === 0) return undefined;

  const builtIn = inputs.find((d) => BUILT_IN_MIC_PATTERNS.some((pattern) => pattern.test(d.label)));
  if (builtIn) return builtIn.deviceId;

  const nonHeadset = inputs.find((d) => {
    if (!d.label) return false;
    return !HEADSET_MIC_PATTERNS.some((pattern) => pattern.test(d.label));
  });
  return nonHeadset?.deviceId;
}

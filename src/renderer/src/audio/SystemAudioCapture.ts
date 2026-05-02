/**
 * SystemAudioCapture — captures system audio in the renderer using
 * `navigator.mediaDevices.getDisplayMedia({ audio: true })`. Electron's main
 * process satisfies the request with a `'loopback'` audio source, which on
 * macOS captures everything the user hears (Zoom, Meet, Teams, Slack, …)
 * without needing a virtual audio device or a Swift native helper.
 *
 * Lifecycle mirrors MicCapture:
 *   const cap = new SystemAudioCapture(meetingId);
 *   await cap.start();
 *   // ...later...
 *   await cap.stop();
 *
 * macOS Screen Recording permission is required the first time
 * getDisplayMedia is called. After granting it the stream's audio track
 * carries the system audio; the video track is ignored.
 */

import {
  PCM_DOWNSAMPLER_PROCESSOR,
  PCM_TARGET_SAMPLE_RATE,
  type PCMWorkletMessage,
} from './audio-worklet';

const INPUT_SAMPLE_RATE = 48000;
const WORKLET_URL = '/audio-worklet.js';

export class SystemAudioCaptureError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'permission-denied'
      | 'no-audio-track'
      | 'worklet-load-failed'
      | 'audio-context-failed'
      | 'unsupported'
      | 'unknown',
  ) {
    super(message);
    this.name = 'SystemAudioCaptureError';
  }
}

export class SystemAudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private started = false;
  private stopping = false;

  constructor(private readonly meetingId: string) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.started = false;
      throw new SystemAudioCaptureError('getDisplayMedia not supported in this runtime.', 'unsupported');
    }

    let stream: MediaStream;
    try {
      // Both video and audio are requested — the video track is required by
      // the API but immediately stopped below. Audio comes from Electron's
      // 'loopback' source (system output mix).
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
    } catch (err) {
      this.started = false;
      const e = err as DOMException;
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        throw new SystemAudioCaptureError(
          'Screen Recording permission denied. Grant access in System Settings → Privacy & Security → Screen Recording, then restart the app.',
          'permission-denied',
        );
      }
      throw new SystemAudioCaptureError(
        `Failed to acquire system audio: ${e?.message ?? String(err)}`,
        'unknown',
      );
    }
    this.stream = stream;

    // Drop the video track immediately — we never render it, and keeping it
    // alive would waste CPU/GPU.
    for (const track of stream.getVideoTracks()) {
      try { track.stop(); } catch { /* ignore */ }
      try { stream.removeTrack(track); } catch { /* ignore */ }
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      await this.cleanupOnError();
      throw new SystemAudioCaptureError(
        'No system-audio track available. macOS may not have granted Screen Recording permission, or the OS audio is off.',
        'no-audio-track',
      );
    }

    let audioContext: AudioContext;
    try {
      audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    } catch (err) {
      await this.cleanupOnError();
      throw new SystemAudioCaptureError(
        `Failed to create AudioContext: ${(err as Error).message}`,
        'audio-context-failed',
      );
    }
    this.audioContext = audioContext;

    try {
      await audioContext.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      await this.cleanupOnError();
      throw new SystemAudioCaptureError(
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
        window.audio.sendChunk(this.meetingId, 'system', buf);
      } catch {
        // bridge errors are non-fatal
      }
    };

    // Connect: source → worklet → muted destination.
    source.connect(worklet);
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    worklet.connect(muteGain).connect(audioContext.destination);

    // If the user revokes the screen-recording permission mid-session, the
    // audio track will end. Stop ourselves cleanly when that happens.
    audioTracks[0].addEventListener('ended', () => {
      this.stop().catch(() => undefined);
    });

    try {
      window.audio.sendStart(this.meetingId, 'system', PCM_TARGET_SAMPLE_RATE);
    } catch {
      // non-fatal
    }
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;

    try {
      if (this.workletNode) {
        try { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); } catch { /* ignore */ }
        this.workletNode = null;
      }
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch { /* ignore */ }
        this.sourceNode = null;
      }
      if (this.stream) {
        for (const t of this.stream.getTracks()) {
          try { t.stop(); } catch { /* ignore */ }
        }
        this.stream = null;
      }
      if (this.audioContext) {
        try { await this.audioContext.close(); } catch { /* ignore */ }
        this.audioContext = null;
      }
      try {
        window.audio.sendEnd(this.meetingId, 'system');
      } catch { /* ignore */ }
    } finally {
      this.started = false;
      this.stopping = false;
    }
  }

  private async cleanupOnError(): Promise<void> {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this.stream = null;
    }
    if (this.audioContext) {
      try { await this.audioContext.close(); } catch { /* ignore */ }
      this.audioContext = null;
    }
    this.started = false;
  }
}

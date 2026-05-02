/**
 * AudioCaptureService — coordinates audio sources for an active meeting.
 *
 * Two audio sources are kept separate when possible (spec §8):
 *   - Microphone: captured by the renderer via getUserMedia → PCM frames sent to main.
 *   - System audio: captured by the Swift native helper (ScreenCaptureKit on macOS 13+).
 *     The helper writes 16-bit PCM frames to stdout; we tee them to Deepgram.
 *
 * This service does not transcribe — it only routes audio frames to the
 * appropriate Deepgram channel.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { log } from '../../lib/logger';
import { services } from '../../lib/service-registry';

const logger = log('audio');

export type AudioChannel = 'mic' | 'system';

interface ActiveSession {
  meetingId: string;
  micSampleRate?: number;
  systemSampleRate?: number;
  systemProcess?: ChildProcess;
}

export class AudioCaptureService {
  private sessions = new Map<string, ActiveSession>();

  /**
   * Start system audio capture for a meeting (macOS only). Mic capture is
   * driven by the renderer, so we just register the meeting here and wait
   * for the renderer to send the start handshake.
   */
  async startSystemAudio(meetingId: string): Promise<void> {
    if (process.platform !== 'darwin') {
      logger.warn('System audio capture only implemented for macOS');
      return;
    }
    const helper = locateNativeHelper();
    if (!helper) {
      logger.warn('Native helper not found; system audio disabled. Run `npm run build:native`.');
      return;
    }

    const session = this.ensureSession(meetingId);
    if (session.systemProcess) return;

    const child = spawn(helper, ['--rate', '16000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (buf: Buffer) => {
      services.deepgram?.feedAudio(meetingId, 'system', buf);
    });
    child.stderr?.on('data', (b) => logger.debug('native-stderr', { msg: b.toString() }));
    child.on('exit', (code) => {
      logger.info('Native helper exited', { meetingId, code });
      session.systemProcess = undefined;
    });
    session.systemProcess = child;
    session.systemSampleRate = 16000;
    services.deepgram?.startChannel(meetingId, 'system', 16000);
  }

  async stopSystemAudio(meetingId: string): Promise<void> {
    const session = this.sessions.get(meetingId);
    if (!session) return;
    session.systemProcess?.kill();
    session.systemProcess = undefined;
    services.deepgram?.endChannel(meetingId, 'system');
  }

  // -- IPC handlers — invoked from main/index.ts when renderer sends frames --
  handleStart(p: { meetingId: string; channel: AudioChannel; sampleRate: number }) {
    const session = this.ensureSession(p.meetingId);
    if (p.channel === 'mic') session.micSampleRate = p.sampleRate;
    else session.systemSampleRate = p.sampleRate;
    logger.info('audio.channel.start', { channel: p.channel, sampleRate: p.sampleRate });
    services.deepgram?.startChannel(p.meetingId, p.channel, p.sampleRate);
  }

  handleChunk(p: { meetingId: string; channel: AudioChannel; data: Buffer }) {
    // Periodic sampling so we can see audio is actually flowing.
    const session = this.sessions.get(p.meetingId);
    if (session) {
      const counter = (session as any)[`${p.channel}_chunks`] = ((session as any)[`${p.channel}_chunks`] ?? 0) + 1;
      if (counter % 50 === 1) {
        logger.info('audio.chunk', {
          channel: p.channel,
          chunks: counter,
          bytes: p.data.byteLength,
        });
      }
    }
    services.deepgram?.feedAudio(p.meetingId, p.channel, p.data);
  }

  handleEnd(p: { meetingId: string; channel: AudioChannel }) {
    logger.info('audio.channel.end', { channel: p.channel });
    services.deepgram?.endChannel(p.meetingId, p.channel);
  }

  endAll(meetingId: string) {
    const s = this.sessions.get(meetingId);
    if (!s) return;
    s.systemProcess?.kill();
    this.sessions.delete(meetingId);
  }

  private ensureSession(meetingId: string): ActiveSession {
    let s = this.sessions.get(meetingId);
    if (!s) {
      s = { meetingId };
      this.sessions.set(meetingId, s);
    }
    return s;
  }
}

function locateNativeHelper(): string | null {
  // Search known locations: dev path, packaged path, user-built path.
  const candidates = [
    join(app.getAppPath(), 'resources', 'bin', 'system-audio-capture'),
    join(process.resourcesPath ?? '', 'bin', 'system-audio-capture'),
    join(app.getAppPath(), 'native', 'SystemAudioCapture', '.build', 'release', 'SystemAudioCapture'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

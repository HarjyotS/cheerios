/**
 * AudioController — top-level singleton used by the UI to start/stop mic
 * and system-audio capture for a meeting. Ensures only one of each is
 * active at a time and serializes start/stop ops so rapid UI toggles
 * can't interleave teardown with a fresh capture's setup.
 *
 * System audio is captured via `getDisplayMedia({ audio: true })` against
 * Electron's built-in 'loopback' source — no native helper required.
 */

import { MicCapture } from './MicCapture';
import { SystemAudioCapture } from './SystemAudioCapture';

interface ActiveMic {
  meetingId: string;
  capture: MicCapture;
}
interface ActiveSystem {
  meetingId: string;
  capture: SystemAudioCapture;
}

class AudioControllerImpl {
  private mic: ActiveMic | null = null;
  private system: ActiveSystem | null = null;
  // Serialize start/stop calls so rapid UI toggles can't interleave teardown
  // with a fresh capture's setup.
  private opChain: Promise<unknown> = Promise.resolve();

  // ---------------- Mic ----------------

  async startMicForMeeting(meetingId: string, deviceId?: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.mic && this.mic.meetingId === meetingId) return;
      if (this.mic) {
        const prev = this.mic;
        this.mic = null;
        await prev.capture.stop();
      }
      const capture = new MicCapture(meetingId);
      try {
        await capture.start(deviceId);
      } catch (err) {
        this.mic = null;
        throw err;
      }
      this.mic = { meetingId, capture };
    });
  }

  async stopMicForMeeting(meetingId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.mic || this.mic.meetingId !== meetingId) return;
      const prev = this.mic;
      this.mic = null;
      await prev.capture.stop();
    });
  }

  isMicActive(meetingId: string): boolean {
    return this.mic?.meetingId === meetingId;
  }

  // ---------------- System audio ----------------

  async startSystemForMeeting(meetingId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.system && this.system.meetingId === meetingId) return;
      if (this.system) {
        const prev = this.system;
        this.system = null;
        await prev.capture.stop();
      }
      const capture = new SystemAudioCapture(meetingId);
      try {
        await capture.start();
      } catch (err) {
        this.system = null;
        throw err;
      }
      this.system = { meetingId, capture };
    });
  }

  async stopSystemForMeeting(meetingId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.system || this.system.meetingId !== meetingId) return;
      const prev = this.system;
      this.system = null;
      await prev.capture.stop();
    });
  }

  isSystemActive(meetingId: string): boolean {
    return this.system?.meetingId === meetingId;
  }

  // ---------------- Teardown ----------------

  /** Stop everything for a meeting (called on meeting stop). */
  async stopAllForMeeting(meetingId: string): Promise<void> {
    await Promise.allSettled([
      this.stopMicForMeeting(meetingId),
      this.stopSystemForMeeting(meetingId),
    ]);
  }

  /**
   * Stop whatever meeting is currently being captured (regardless of id).
   * Called before starting a new meeting so we never have two running.
   */
  async stopAnyActive(): Promise<void> {
    const ids = new Set<string>();
    if (this.mic) ids.add(this.mic.meetingId);
    if (this.system) ids.add(this.system.meetingId);
    for (const id of ids) await this.stopAllForMeeting(id);
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    // enumerateDevices only returns labeled entries after at least one
    // getUserMedia grant. Callers that need labels should request mic
    // permission first (e.g. via a one-shot startMicForMeeting).
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => undefined);
    return next;
  }
}

export const audioController = new AudioControllerImpl();
export type AudioController = AudioControllerImpl;

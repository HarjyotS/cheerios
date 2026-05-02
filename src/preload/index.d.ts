import type { API } from '@shared/types/ipc';

declare global {
  interface Window {
    api: API;
    audio: {
      sendStart(meetingId: string, channel: 'mic' | 'system', sampleRate: number): void;
      sendChunk(meetingId: string, channel: 'mic' | 'system', data: ArrayBuffer): void;
      sendEnd(meetingId: string, channel: 'mic' | 'system'): void;
    };
  }
}

export {};

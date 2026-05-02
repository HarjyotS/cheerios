/**
 * In-process pub/sub used by the main process. Services emit, IPC bridges,
 * and other services subscribe. Tiny and synchronous — no external deps.
 */
import { EventEmitter } from 'node:events';
import type { TranscriptEvent } from '@shared/types/transcript-events';
import type {
  Meeting,
  GeneratedNote,
  Settings,
  DetectedMeeting,
  ID,
} from '@shared/types/entities';

export type AppEvents = {
  transcript: (e: TranscriptEvent) => void;
  meeting_detected: (d: DetectedMeeting | null) => void;
  meeting_updated: (m: Meeting) => void;
  meeting_started: (m: Meeting) => void;
  meeting_ended: (m: Meeting) => void;
  note_updated: (n: GeneratedNote) => void;
  sync_status: (s: { meetingId: ID; status: string; error?: string }) => void;
  notification: (n: { kind: string; title: string; body?: string; meetingId?: ID }) => void;
  settings_changed: (s: Settings) => void;
  automation_trigger: (t: { trigger: string; meetingId: ID; payload?: Record<string, unknown> }) => void;
};

class TypedEmitter extends EventEmitter {
  override on<K extends keyof AppEvents>(event: K, listener: AppEvents[K]): this {
    return super.on(event as string, listener);
  }
  override off<K extends keyof AppEvents>(event: K, listener: AppEvents[K]): this {
    return super.off(event as string, listener);
  }
  override emit<K extends keyof AppEvents>(event: K, ...args: Parameters<AppEvents[K]>): boolean {
    return super.emit(event as string, ...args);
  }
}

export const bus = new TypedEmitter();
bus.setMaxListeners(100);

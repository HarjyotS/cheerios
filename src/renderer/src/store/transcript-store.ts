/**
 * Per-meeting transcript store. Decoupled from the main store because
 * transcript chunks update at high frequency.
 */
import { create } from 'zustand';
import type { TranscriptChunk } from '@shared/types/entities';
import type { TranscriptEvent } from '@shared/types/transcript-events';

interface InterimChunk {
  meetingId: string;
  text: string;
  speakerId?: string;
  startTime?: number;
  endTime?: number;
}

interface TranscriptState {
  finalsByMeeting: Record<string, TranscriptChunk[]>;
  interimByMeeting: Record<string, InterimChunk | null>;
  connectionByMeeting: Record<string, 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>;
  errorByMeeting: Record<string, string | null>;

  loadInitial(meetingId: string): Promise<void>;
  ingest(e: TranscriptEvent): void;
  clear(meetingId: string): void;
  removeChunk(chunkId: string): void;
  highlightChunk(chunkId: string, on: boolean): void;
  renameSpeaker(meetingId: string, speakerId: string, name: string): void;
}

let unsubscribeEvents: (() => void) | null = null;

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  finalsByMeeting: {},
  interimByMeeting: {},
  connectionByMeeting: {},
  errorByMeeting: {},

  async loadInitial(meetingId) {
    try {
      const chunks = await window.api.transcript.listChunks(meetingId);
      set({
        finalsByMeeting: { ...get().finalsByMeeting, [meetingId]: chunks },
      });
    } catch {
      /* noop */
    }
  },

  ingest(e) {
    const finals = { ...get().finalsByMeeting };
    const interim = { ...get().interimByMeeting };
    const connection = { ...get().connectionByMeeting };
    const errors = { ...get().errorByMeeting };

    switch (e.type) {
      case 'final': {
        const list = finals[e.meetingId] ? [...finals[e.meetingId]] : [];
        // Build a synthetic TranscriptChunk from the event.
        const chunk: TranscriptChunk = {
          id: e.chunkId,
          meeting_id: e.meetingId,
          provider: 'deepgram',
          speaker_id: e.speakerId,
          speaker_name: e.speakerName,
          channel: e.channel,
          start_time: e.startTime,
          end_time: e.endTime,
          text: e.text,
          words: e.words,
          confidence: e.confidence,
          language: e.language,
          is_final: true,
          is_deleted: false,
          is_highlighted: false,
          source: e.channel === 1 ? 'system_audio' : 'microphone',
          created_at: new Date().toISOString(),
        };
        // Replace if already present (rare), else append.
        const existingIdx = list.findIndex((c) => c.id === chunk.id);
        if (existingIdx === -1) list.push(chunk);
        else list[existingIdx] = chunk;
        finals[e.meetingId] = list;
        // Clear matching interim
        interim[e.meetingId] = null;
        break;
      }
      case 'interim': {
        interim[e.meetingId] = {
          meetingId: e.meetingId,
          text: e.text,
          speakerId: e.speakerId,
          startTime: e.startTime,
          endTime: e.endTime,
        };
        break;
      }
      case 'connected': {
        connection[e.meetingId] = 'connected';
        errors[e.meetingId] = null;
        break;
      }
      case 'reconnecting': {
        connection[e.meetingId] = 'reconnecting';
        break;
      }
      case 'error': {
        connection[e.meetingId] = 'error';
        errors[e.meetingId] = e.message;
        break;
      }
      default:
        break;
    }

    set({
      finalsByMeeting: finals,
      interimByMeeting: interim,
      connectionByMeeting: connection,
      errorByMeeting: errors,
    });
  },

  clear(meetingId) {
    const f = { ...get().finalsByMeeting };
    delete f[meetingId];
    const i = { ...get().interimByMeeting };
    delete i[meetingId];
    set({ finalsByMeeting: f, interimByMeeting: i });
  },

  removeChunk(chunkId) {
    const finals = { ...get().finalsByMeeting };
    for (const m of Object.keys(finals)) {
      finals[m] = finals[m].map((c) =>
        c.id === chunkId ? { ...c, is_deleted: true } : c,
      );
    }
    set({ finalsByMeeting: finals });
  },

  highlightChunk(chunkId, on) {
    const finals = { ...get().finalsByMeeting };
    for (const m of Object.keys(finals)) {
      finals[m] = finals[m].map((c) =>
        c.id === chunkId ? { ...c, is_highlighted: on } : c,
      );
    }
    set({ finalsByMeeting: finals });
  },

  renameSpeaker(meetingId, speakerId, name) {
    const finals = { ...get().finalsByMeeting };
    if (!finals[meetingId]) return;
    finals[meetingId] = finals[meetingId].map((c) =>
      c.speaker_id === speakerId ? { ...c, speaker_name: name } : c,
    );
    set({ finalsByMeeting: finals });
  },
}));

/**
 * Wire the global transcript subscription exactly once.
 * Called from MainShell on mount.
 */
export function attachGlobalTranscriptSubscription(): () => void {
  if (unsubscribeEvents) return unsubscribeEvents;
  const off = window.api.events.onTranscript((e) => {
    useTranscriptStore.getState().ingest(e);
  });
  unsubscribeEvents = () => {
    off();
    unsubscribeEvents = null;
  };
  return unsubscribeEvents;
}

/**
 * Transcript event stream from the Deepgram service layer.
 * Spec §8A.
 */
import type { ID, TranscriptWord } from './entities';

export type TranscriptEvent =
  | {
      type: 'interim';
      meetingId: ID;
      text: string;
      speakerId?: string;
      channel?: number;
      startTime?: number;
      endTime?: number;
    }
  | {
      type: 'final';
      meetingId: ID;
      chunkId: ID;
      text: string;
      speakerId?: string;
      speakerName?: string;
      channel?: number;
      confidence?: number;
      startTime: number;
      endTime: number;
      words?: TranscriptWord[];
      language?: string;
    }
  | {
      type: 'speech_started';
      meetingId: ID;
      timestamp: number;
    }
  | {
      type: 'utterance_end';
      meetingId: ID;
      timestamp: number;
    }
  | {
      type: 'gap';
      meetingId: ID;
      from: number;
      to: number;
      reason: string;
    }
  | {
      type: 'error';
      meetingId: ID;
      provider: 'deepgram';
      message: string;
    }
  | {
      type: 'connected';
      meetingId: ID;
      requestId?: string;
    }
  | {
      type: 'reconnecting';
      meetingId: ID;
      attempt: number;
    };

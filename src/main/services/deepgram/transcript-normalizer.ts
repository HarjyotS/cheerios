/**
 * Normalize Deepgram realtime messages into our internal TranscriptEvent /
 * TranscriptChunk shapes.
 *
 * Deepgram's `Results` envelope (relevant fields):
 *   {
 *     type: 'Results',
 *     channel_index: [n, total],
 *     start: number,            // seconds, relative to socket open
 *     duration: number,
 *     is_final: boolean,        // segment is final
 *     speech_final: boolean,    // utterance boundary (endpointing)
 *     from_finalize: boolean,   // emitted because we sent {type:'Finalize'}
 *     channel: {
 *       alternatives: [{
 *         transcript: string,
 *         confidence: number,
 *         words: [{ word, start, end, confidence, speaker?, punctuated_word? }],
 *       }],
 *     },
 *     metadata: { request_id?: string, ... }
 *   }
 *
 * For our purposes we treat each `is_final` Results as a final chunk (one per
 * channel), independent of `speech_final`. Interim results are emitted only
 * for the live transcript view.
 */
import { nanoid } from 'nanoid';
import type {
  ID,
  TranscriptChunk,
  TranscriptWord,
} from '@shared/types/entities';
import type { TranscriptEvent } from '@shared/types/transcript-events';
import { normalizeSpeakerId, type SpeakerKey } from './diarization-mapper';

/** Loose typing for the Deepgram Results envelope. */
export interface DeepgramResultsEnvelope {
  type?: string;
  channel_index?: [number, number];
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: Array<{
        word?: string;
        punctuated_word?: string;
        start?: number;
        end?: number;
        confidence?: number;
        speaker?: number | string;
      }>;
    }>;
  };
  metadata?: { request_id?: string };
}

export interface NormalizeContext {
  meetingId: ID;
  /** 0 for mic, 1 for system. */
  channelIndex: number;
  /** Audio source label persisted on the chunk. */
  source: 'microphone' | 'system_audio' | 'mixed';
  /** ms since meeting start when the socket was opened, used as time base. */
  channelStartMs: number;
  /** Static speaker id to use for this channel (mic → "speaker_me");
   *  for system audio leave undefined so we read it off the words array. */
  fixedSpeakerId?: SpeakerKey;
  /** Resolves a display name for a Deepgram speaker key. */
  resolveSpeakerName: (speakerId: SpeakerKey) => string;
  language?: string;
}

export interface NormalizedFinal {
  event: Extract<TranscriptEvent, { type: 'final' }>;
  chunk: TranscriptChunk;
}

/** Convert a Deepgram words[] array into our TranscriptWord[]. */
function mapWords(raw: NonNullable<NonNullable<DeepgramResultsEnvelope['channel']>['alternatives']>[number]['words']): TranscriptWord[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: TranscriptWord[] = [];
  for (const w of raw) {
    const word = w.punctuated_word ?? w.word ?? '';
    if (!word) continue;
    out.push({
      word,
      start: w.start ?? 0,
      end: w.end ?? 0,
      confidence: w.confidence ?? 0,
      speaker: w.speaker !== undefined ? String(w.speaker) : undefined,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Pick the dominant speaker for a final segment. Deepgram tags speaker per
 * word; we vote by word count to assign one speaker_id to the whole chunk.
 */
function dominantSpeaker(words: TranscriptWord[] | undefined): SpeakerKey | undefined {
  if (!words || words.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w.speaker === undefined) continue;
    counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  let best: string | undefined;
  let max = -1;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best ? normalizeSpeakerId(best) : undefined;
}

/**
 * Normalize a Deepgram Results envelope into either an interim event or a
 * final event + persistable TranscriptChunk. Returns null when the message
 * has no usable transcript text.
 */
export function normalizeResults(
  msg: DeepgramResultsEnvelope,
  ctx: NormalizeContext,
): { kind: 'interim'; event: Extract<TranscriptEvent, { type: 'interim' }> }
  | { kind: 'final'; data: NormalizedFinal }
  | null {
  const alt = msg.channel?.alternatives?.[0];
  const transcript = (alt?.transcript ?? '').trim();
  if (!transcript) return null;

  const words = mapWords(alt?.words);
  const baseStart = (ctx.channelStartMs / 1000) + (msg.start ?? 0);
  const baseEnd = baseStart + (msg.duration ?? 0);

  if (!msg.is_final) {
    const speakerKey = ctx.fixedSpeakerId ?? dominantSpeaker(words);
    return {
      kind: 'interim',
      event: {
        type: 'interim',
        meetingId: ctx.meetingId,
        text: transcript,
        speakerId: speakerKey,
        channel: ctx.channelIndex,
        startTime: baseStart,
        endTime: baseEnd,
      },
    };
  }

  const speakerKey = ctx.fixedSpeakerId ?? dominantSpeaker(words) ?? normalizeSpeakerId(0);
  const speakerName = speakerKey ? ctx.resolveSpeakerName(speakerKey) : undefined;
  const chunkId = 'tcp_' + nanoid(12);
  const createdAt = new Date().toISOString();

  const chunk: TranscriptChunk = {
    id: chunkId,
    meeting_id: ctx.meetingId,
    provider: 'deepgram',
    deepgram_request_id: msg.metadata?.request_id,
    channel: ctx.channelIndex,
    speaker_id: speakerKey,
    speaker_name: speakerName,
    start_time: baseStart,
    end_time: baseEnd,
    text: transcript,
    words,
    confidence: alt?.confidence,
    language: ctx.language,
    is_final: true,
    is_deleted: false,
    is_highlighted: false,
    source: ctx.source,
    created_at: createdAt,
  };

  const event: Extract<TranscriptEvent, { type: 'final' }> = {
    type: 'final',
    meetingId: ctx.meetingId,
    chunkId,
    text: transcript,
    speakerId: speakerKey,
    speakerName,
    channel: ctx.channelIndex,
    confidence: alt?.confidence,
    startTime: baseStart,
    endTime: baseEnd,
    words,
    language: ctx.language,
  };

  return { kind: 'final', data: { event, chunk } };
}

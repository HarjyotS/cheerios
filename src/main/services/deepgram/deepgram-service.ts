/**
 * DeepgramStreamingService — source of truth for transcript generation.
 *
 * Architecture (spec §8 + §8A):
 *   - One LiveClient per (meetingId, channel). The mic stream and the system-
 *     audio stream live in independent sockets so they can start/stop on
 *     different schedules and reconnect independently.
 *   - Audio is forwarded as 16-bit little-endian mono PCM. Sample rate is
 *     declared per stream when we open the socket.
 *   - On `is_final` Results we persist a TranscriptChunk and emit a 'final'
 *     event on the bus. Interim Results are emitted but never persisted.
 *   - Mic is attributed to "Me" by convention (single speaker assumption).
 *     System audio uses Deepgram diarization → speaker_0/1/... resolved via
 *     DiarizationMapper.
 *   - On disconnect we keep a 60-second rolling buffer per channel, replay it
 *     into the new socket, and emit a 'gap' event for the wall-clock window
 *     where the previous socket was unavailable. Up to 5 reconnect attempts
 *     with exponential backoff.
 *   - Privacy: 'private' meetings refuse to start; 'sensitive' meetings pass
 *     redact=[...] to Deepgram.
 *   - Usage: total streamed seconds per meeting are accumulated and recorded
 *     via Usage.record() on stop. We hard-stop when the monthly limit is hit.
 */
import { createClient, LiveTranscriptionEvents, type LiveClient } from '@deepgram/sdk';
import { Meetings, TranscriptChunks, Usage } from '@main/db/repositories';
import { getSettings } from '@main/db';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import type { ID } from '@shared/types/entities';
import type { TranscriptEvent } from '@shared/types/transcript-events';
import { DiarizationMapper, normalizeSpeakerId, type SpeakerKey } from './diarization-mapper';
import { normalizeResults, type DeepgramResultsEnvelope } from './transcript-normalizer';
import { RollingAudioBuffer, bytesForSeconds } from './audio-buffer';

const logger = log('deepgram');

// nova-3 streaming pricing — ~$0.0043 / minute. Recompute per second.
const COST_PER_SEC: Record<string, number> = {
  'nova-3': 0.0043 / 60,
  'nova-2': 0.0043 / 60,
  enhanced: 0.0145 / 60,
};

const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const ROLLING_BUFFER_SECONDS = 60;

/**
 * Coerce a Node Buffer into a value the Deepgram SDK accepts. The SDK's
 * `send()` is typed as ArrayBuffer | SharedArrayBuffer | Blob, but at runtime
 * it accepts any TypedArray. Returning a Uint8Array view (zero-copy) keeps
 * the type checker happy without an extra allocation.
 */
function toSocketData(buf: Buffer): ArrayBuffer {
  // Slice the underlying ArrayBuffer to the exact range the Buffer covers.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

type Channel = 'mic' | 'system';

interface ChannelState {
  meetingId: ID;
  channel: Channel;
  sampleRate: number;
  /** Wall-clock ms when we first started this channel for the meeting. Used
   *  as the time base for chunk start_time / end_time. */
  channelStartMs: number;
  /** Live Deepgram socket. May be null while reconnecting. */
  connection: LiveClient | null;
  /** True once Deepgram emits Open and we can flush queued audio. */
  ready: boolean;
  /** Audio that arrived before .Open (buffered to forward on connect). */
  pendingPreOpen: Buffer[];
  /** Rolling window of recent PCM for replay on reconnect. */
  rolling: RollingAudioBuffer;
  /** Reconnect bookkeeping. */
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  /** Wall-clock of the last successful Open, for gap event start time. */
  lastOpenAtMs: number;
  /** Total seconds of audio sent on this channel (estimated from byte count). */
  streamedSeconds: number;
  /** True once endChannel() has been called — suppresses reconnects. */
  closing: boolean;
}

interface MeetingState {
  meetingId: ID;
  language: string;
  privacyMode: 'normal' | 'private' | 'local_only' | 'sensitive';
  redact: string[];
  paused: boolean;
  startMs: number;
  channels: Map<Channel, ChannelState>;
  /** Sum of streamed seconds across all channels — recorded on stop. */
  totalStreamedSeconds: number;
}

export class DeepgramStreamingService {
  private meetings = new Map<ID, MeetingState>();
  private mapper = new DiarizationMapper();
  private apiKey: string | null = null;
  /** Cached monthly usage check result so we don't re-query on every chunk. */
  private hardStopHit = false;

  // -------------------------------------------------------------------------
  // Public API (matches stub)
  // -------------------------------------------------------------------------

  async startForMeeting(meetingId: ID): Promise<void> {
    if (this.meetings.has(meetingId)) return;

    const meeting = Meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    if (meeting.privacy_mode === 'private') {
      throw new Error('Cannot stream private meeting to Deepgram');
    }

    // Check monthly hard stop before opening any sockets.
    const settings = getSettings();
    const monthly = Usage.totalsForMonth();
    const hardStopSec = settings.monthly_transcription_hard_stop_minutes * 60;
    if (monthly.seconds >= hardStopSec) {
      this.hardStopHit = true;
      bus.emit('notification', {
        kind: 'transcription_hard_stop',
        title: 'Transcription disabled',
        body: `Monthly limit of ${settings.monthly_transcription_hard_stop_minutes} minutes reached.`,
      });
      throw new Error('Monthly transcription hard stop limit reached');
    }

    // Soft warning.
    const warnSec = settings.monthly_transcription_warn_minutes * 60;
    if (monthly.seconds >= warnSec) {
      bus.emit('notification', {
        kind: 'transcription_warn',
        title: 'Transcription usage high',
        body: `You've used ${(monthly.seconds / 60).toFixed(0)} minutes this month.`,
      });
    }

    // Mic is always "Me" — seed before any words arrive.
    const micKey = normalizeSpeakerId('me');
    if (micKey) this.mapper.seed(meetingId, micKey, 'Me');

    this.meetings.set(meetingId, {
      meetingId,
      language: meeting.language ?? settings.deepgram_language ?? 'en-US',
      privacyMode: meeting.privacy_mode,
      redact: meeting.privacy_mode === 'sensitive' ? settings.deepgram_redact ?? [] : [],
      paused: false,
      startMs: Date.now(),
      channels: new Map(),
      totalStreamedSeconds: 0,
    });

    logger.info('Meeting active', { meetingId, privacy: meeting.privacy_mode });
  }

  async stopForMeeting(meetingId: ID): Promise<void> {
    const state = this.meetings.get(meetingId);
    if (!state) return;

    for (const ch of [...state.channels.keys()]) {
      this.endChannel(meetingId, ch);
    }

    // Record usage.
    const seconds = Math.round(state.totalStreamedSeconds);
    if (seconds > 0) {
      const rate = COST_PER_SEC[getSettings().deepgram_model] ?? COST_PER_SEC['nova-3'];
      Usage.record(meetingId, 'deepgram', seconds, seconds * rate);
    }

    this.mapper.forget(meetingId);
    this.meetings.delete(meetingId);
    logger.info('Meeting stopped', { meetingId, streamedSeconds: seconds });
  }

  async pauseForMeeting(meetingId: ID): Promise<void> {
    const state = this.meetings.get(meetingId);
    if (!state || state.paused) return;
    state.paused = true;
    // Sockets stay open but feedAudio() drops frames; this lets us resume
    // without paying the reconnect penalty for short pauses.
    logger.info('Meeting paused', { meetingId });
  }

  async resumeForMeeting(meetingId: ID): Promise<void> {
    const state = this.meetings.get(meetingId);
    if (!state || !state.paused) return;
    state.paused = false;
    logger.info('Meeting resumed', { meetingId });
  }

  startChannel(meetingId: ID, channel: Channel, sampleRate: number): void {
    const meetingState = this.meetings.get(meetingId);
    if (!meetingState) {
      logger.warn('startChannel called before startForMeeting', { meetingId, channel });
      return;
    }
    if (meetingState.channels.has(channel)) return;

    const chState: ChannelState = {
      meetingId,
      channel,
      sampleRate,
      channelStartMs: Date.now() - meetingState.startMs,
      connection: null,
      ready: false,
      pendingPreOpen: [],
      rolling: new RollingAudioBuffer(bytesForSeconds(sampleRate, ROLLING_BUFFER_SECONDS)),
      reconnectAttempts: 0,
      lastOpenAtMs: Date.now(),
      streamedSeconds: 0,
      closing: false,
    };
    meetingState.channels.set(channel, chState);

    void this.openSocket(chState).catch((err) => {
      logger.error('Failed to open socket', { meetingId, channel, err: String(err) });
      bus.emit('transcript', {
        type: 'error',
        meetingId,
        provider: 'deepgram',
        message: `Failed to open ${channel} socket: ${String(err)}`,
      } as TranscriptEvent);
    });
  }

  feedAudio(meetingId: ID, channel: Channel, buf: Buffer): void {
    const meetingState = this.meetings.get(meetingId);
    if (!meetingState || meetingState.paused) return;
    const chState = meetingState.channels.get(channel);
    if (!chState || chState.closing) return;

    // Track usage by bytes — sample_rate * 2 bytes/sample/sec.
    const seconds = buf.byteLength / (chState.sampleRate * 2);
    chState.streamedSeconds += seconds;
    meetingState.totalStreamedSeconds += seconds;

    // Hard-stop guard while streaming.
    if (!this.hardStopHit) {
      const total = Usage.totalsForMonth().seconds + meetingState.totalStreamedSeconds;
      const hardStopSec = getSettings().monthly_transcription_hard_stop_minutes * 60;
      if (total >= hardStopSec) {
        this.hardStopHit = true;
        bus.emit('notification', {
          kind: 'transcription_hard_stop',
          title: 'Transcription disabled',
          body: 'Monthly limit reached — stopping live transcription.',
          meetingId,
        });
        // Tear down channels but leave the meeting state so stopForMeeting
        // can still record usage.
        for (const ch of [...meetingState.channels.keys()]) this.endChannel(meetingId, ch);
        return;
      }
    }

    chState.rolling.push(buf);

    if (!chState.connection || !chState.ready) {
      chState.pendingPreOpen.push(buf);
      return;
    }

    try {
      chState.connection.send(toSocketData(buf));
    } catch (err) {
      logger.warn('send() threw — scheduling reconnect', {
        meetingId,
        channel,
        err: String(err),
      });
      this.scheduleReconnect(chState);
    }
  }

  endChannel(meetingId: ID, channel: Channel): void {
    const meetingState = this.meetings.get(meetingId);
    if (!meetingState) return;
    const chState = meetingState.channels.get(channel);
    if (!chState) return;
    chState.closing = true;
    if (chState.reconnectTimer) {
      clearTimeout(chState.reconnectTimer);
      chState.reconnectTimer = undefined;
    }
    if (chState.connection) {
      try {
        // Request final results, then close.
        const c = chState.connection as unknown as { finish?: () => void; requestClose?: () => void; close?: () => void };
        if (typeof c.requestClose === 'function') c.requestClose();
        else if (typeof c.finish === 'function') c.finish();
        else if (typeof c.close === 'function') c.close();
      } catch (err) {
        logger.debug('Error closing connection', { err: String(err) });
      }
      chState.connection = null;
    }
    meetingState.channels.delete(channel);
    logger.info('Channel ended', { meetingId, channel, seconds: Math.round(chState.streamedSeconds) });
  }

  persistSpeakerName(speakerId: string, name: string): void {
    const key = normalizeSpeakerId(speakerId);
    if (!key) return;
    // Without a meetingId we treat this as a global hint. Callers with a
    // meeting context should prefer renaming via TranscriptChunks.renameSpeaker
    // and persisting via the dedicated meeting-scoped path below.
    this.mapper.persistGlobal(key, name);
  }

  /** Persist a speaker name within a specific meeting and update existing
   *  chunks. Useful to expose via IPC; the public stub API doesn't take a
   *  meetingId so we offer this helper for callers that have one. */
  persistSpeakerNameForMeeting(meetingId: ID, speakerId: string, name: string): void {
    const key = normalizeSpeakerId(speakerId);
    if (!key) return;
    this.mapper.persist(meetingId, key, name);
    TranscriptChunks.renameSpeaker(meetingId, key, name);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const k = await getSecret(SECRET_KEYS.deepgramApiKey);
    if (!k) throw new Error('Deepgram API key not configured');
    this.apiKey = k;
    return k;
  }

  private async openSocket(ch: ChannelState): Promise<void> {
    const meetingState = this.meetings.get(ch.meetingId);
    if (!meetingState) return;

    const apiKey = await this.getApiKey();
    const settings = getSettings();
    const client = createClient(apiKey);

    // Build options. Note: Deepgram accepts the sample rate we declare; we
    // don't resample. Diarization is applied to system audio only — for mic
    // we already know the speaker is "Me".
    const liveOptions: Record<string, unknown> = {
      model: settings.deepgram_model,
      language: meetingState.language,
      smart_format: settings.deepgram_smart_format,
      punctuate: true,
      diarize: ch.channel === 'system' ? settings.deepgram_diarize : false,
      utterances: true,
      interim_results: true,
      endpointing: 300,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: ch.sampleRate,
      channels: 1,
      tag: ch.channel,
    };
    if (meetingState.redact.length > 0) liveOptions.redact = meetingState.redact;

    const connection = client.listen.live(liveOptions);
    ch.connection = connection;
    ch.ready = false;

    const fixedSpeakerId: SpeakerKey | undefined =
      ch.channel === 'mic' ? normalizeSpeakerId('me') : undefined;

    connection.on(LiveTranscriptionEvents.Open, () => {
      logger.info('Deepgram socket open', { meetingId: ch.meetingId, channel: ch.channel });
      ch.ready = true;
      ch.reconnectAttempts = 0;
      ch.lastOpenAtMs = Date.now();

      bus.emit('transcript', {
        type: 'connected',
        meetingId: ch.meetingId,
      } as TranscriptEvent);

      // If we're reconnecting, replay the rolling buffer first so we don't
      // lose the in-flight utterance.
      const replay = ch.rolling.snapshot();
      if (replay.byteLength > 0) {
        try {
          connection.send(toSocketData(replay));
        } catch (err) {
          logger.warn('Replay send failed', { err: String(err) });
        }
      }
      // Flush any audio that arrived between connection construction and Open.
      const pending = ch.pendingPreOpen;
      ch.pendingPreOpen = [];
      for (const b of pending) {
        try {
          connection.send(toSocketData(b));
        } catch (err) {
          logger.warn('Pre-open flush failed', { err: String(err) });
          break;
        }
      }
    });

    connection.on(LiveTranscriptionEvents.Transcript, (raw: unknown) => {
      const msg = raw as DeepgramResultsEnvelope;
      const norm = normalizeResults(msg, {
        meetingId: ch.meetingId,
        channelIndex: ch.channel === 'mic' ? 0 : 1,
        source: ch.channel === 'mic' ? 'microphone' : 'system_audio',
        channelStartMs: ch.channelStartMs,
        fixedSpeakerId,
        resolveSpeakerName: (key) => this.mapper.resolveName(ch.meetingId, key),
        language: meetingState.language,
      });
      if (!norm) return;

      if (norm.kind === 'interim') {
        bus.emit('transcript', norm.event as TranscriptEvent);
        return;
      }

      // Final: persist + emit.
      try {
        TranscriptChunks.insert(norm.data.chunk);
      } catch (err) {
        logger.error('Failed to insert chunk', { err: String(err) });
      }
      bus.emit('transcript', norm.data.event as TranscriptEvent);
    });

    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      bus.emit('transcript', {
        type: 'speech_started',
        meetingId: ch.meetingId,
        timestamp: Date.now() - meetingState.startMs,
      } as TranscriptEvent);
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      bus.emit('transcript', {
        type: 'utterance_end',
        meetingId: ch.meetingId,
        timestamp: Date.now() - meetingState.startMs,
      } as TranscriptEvent);
    });

    connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      logger.warn('Deepgram error', { meetingId: ch.meetingId, channel: ch.channel, err: String(err) });
      bus.emit('transcript', {
        type: 'error',
        meetingId: ch.meetingId,
        provider: 'deepgram',
        message: typeof err === 'string' ? err : (err as Error)?.message ?? 'unknown',
      } as TranscriptEvent);
      this.scheduleReconnect(ch);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      logger.info('Deepgram socket closed', { meetingId: ch.meetingId, channel: ch.channel });
      ch.ready = false;
      ch.connection = null;
      if (!ch.closing) this.scheduleReconnect(ch);
    });
  }

  private scheduleReconnect(ch: ChannelState): void {
    if (ch.closing) return;
    if (ch.reconnectTimer) return; // already scheduled
    if (ch.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      logger.error('Reconnect attempts exhausted', {
        meetingId: ch.meetingId,
        channel: ch.channel,
      });
      bus.emit('transcript', {
        type: 'error',
        meetingId: ch.meetingId,
        provider: 'deepgram',
        message: `Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts`,
      } as TranscriptEvent);
      ch.closing = true;
      return;
    }
    ch.reconnectAttempts += 1;
    const delay = RECONNECT_BASE_DELAY_MS * 2 ** (ch.reconnectAttempts - 1);

    bus.emit('transcript', {
      type: 'reconnecting',
      meetingId: ch.meetingId,
      attempt: ch.reconnectAttempts,
    } as TranscriptEvent);

    const meetingState = this.meetings.get(ch.meetingId);
    const gapStartMs = ch.lastOpenAtMs - (meetingState?.startMs ?? 0);
    const gapEndMs = Date.now() - (meetingState?.startMs ?? 0);
    bus.emit('transcript', {
      type: 'gap',
      meetingId: ch.meetingId,
      from: gapStartMs / 1000,
      to: gapEndMs / 1000,
      reason: 'deepgram_disconnect',
    } as TranscriptEvent);

    ch.reconnectTimer = setTimeout(() => {
      ch.reconnectTimer = undefined;
      void this.openSocket(ch).catch((err) => {
        logger.warn('Reconnect openSocket failed', { err: String(err) });
        this.scheduleReconnect(ch);
      });
    }, delay);
  }
}

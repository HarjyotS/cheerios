/**
 * Diarization mapper — turns Deepgram raw speaker ids (e.g. "0", "1", or
 * "speaker_0") into stable display names ("Me", "Sarah", or fallback
 * "Speaker 0"). Mappings are persisted to the `speaker_mappings` table so
 * subsequent meetings can reuse them when the user has named someone.
 *
 * Two scopes:
 *   - per-meeting mapping (preferred)  → row with meeting_id set
 *   - global mapping (fallback hint)   → row with meeting_id NULL
 */
import { nanoid } from 'nanoid';
import { getDb } from '@main/db';
import type { ID } from '@shared/types/entities';

export type SpeakerKey = string; // canonical: "speaker_<n>"

const PREFIX = 'speaker_';

/** Normalize whatever Deepgram hands us into a "speaker_<n>" key. */
export function normalizeSpeakerId(raw: string | number | undefined | null): SpeakerKey | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  if (s.startsWith(PREFIX)) return s;
  // Deepgram emits numeric speaker indices (0, 1, 2, ...); coerce.
  if (/^\d+$/.test(s)) return PREFIX + s;
  return s;
}

export class DiarizationMapper {
  /** In-memory cache: meetingId → (speakerId → name). */
  private byMeeting = new Map<ID, Map<SpeakerKey, string>>();
  /** Global cache: speakerId → name (for cross-meeting hints). */
  private global = new Map<SpeakerKey, string>();
  private hydrated = new Set<ID>();

  /**
   * Resolve a display name for the given Deepgram speaker id within a
   * meeting. Falls back to "Speaker N" when no mapping exists.
   */
  resolveName(meetingId: ID, speakerId: SpeakerKey): string {
    this.hydrate(meetingId);
    const local = this.byMeeting.get(meetingId)?.get(speakerId);
    if (local) return local;
    const g = this.global.get(speakerId);
    if (g) return g;
    return prettyFallback(speakerId);
  }

  /** Persist a name for a speaker within a meeting (overwrites if present). */
  persist(meetingId: ID, speakerId: SpeakerKey, name: string): void {
    const d = getDb();
    // Upsert by (meeting_id, speaker_id). Schema lacks a unique constraint, so
    // we delete-then-insert to keep semantics simple.
    d.prepare('DELETE FROM speaker_mappings WHERE meeting_id = ? AND speaker_id = ?').run(meetingId, speakerId);
    d.prepare(
      `INSERT INTO speaker_mappings (id, meeting_id, speaker_id, speaker_name, person_id, voice_embedding, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('spk_' + nanoid(10), meetingId, speakerId, name, null, null, new Date().toISOString());

    let m = this.byMeeting.get(meetingId);
    if (!m) {
      m = new Map();
      this.byMeeting.set(meetingId, m);
    }
    m.set(speakerId, name);
  }

  /** Persist a global hint (used when the user names a speaker outside a
   *  meeting context, or when we want this name to apply across meetings). */
  persistGlobal(speakerId: SpeakerKey, name: string): void {
    const d = getDb();
    d.prepare('DELETE FROM speaker_mappings WHERE meeting_id IS NULL AND speaker_id = ?').run(speakerId);
    d.prepare(
      `INSERT INTO speaker_mappings (id, meeting_id, speaker_id, speaker_name, person_id, voice_embedding, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('spk_' + nanoid(10), null, speakerId, name, null, null, new Date().toISOString());
    this.global.set(speakerId, name);
  }

  /** Forget the in-memory cache for a meeting (called when the meeting ends). */
  forget(meetingId: ID): void {
    this.byMeeting.delete(meetingId);
    this.hydrated.delete(meetingId);
  }

  /**
   * Pre-populate a fixed mapping. Used for the mic channel where we always
   * want to attribute to "Me" without hitting the DB.
   */
  seed(meetingId: ID, speakerId: SpeakerKey, name: string): void {
    let m = this.byMeeting.get(meetingId);
    if (!m) {
      m = new Map();
      this.byMeeting.set(meetingId, m);
    }
    m.set(speakerId, name);
  }

  private hydrate(meetingId: ID): void {
    if (this.hydrated.has(meetingId)) return;
    this.hydrated.add(meetingId);
    const d = getDb();
    const rows = d
      .prepare('SELECT speaker_id, speaker_name FROM speaker_mappings WHERE meeting_id = ?')
      .all(meetingId) as Array<{ speaker_id: string; speaker_name: string }>;
    const m = this.byMeeting.get(meetingId) ?? new Map<SpeakerKey, string>();
    for (const r of rows) m.set(r.speaker_id, r.speaker_name);
    this.byMeeting.set(meetingId, m);

    if (this.global.size === 0) {
      const gRows = d
        .prepare('SELECT speaker_id, speaker_name FROM speaker_mappings WHERE meeting_id IS NULL')
        .all() as Array<{ speaker_id: string; speaker_name: string }>;
      for (const r of gRows) this.global.set(r.speaker_id, r.speaker_name);
    }
  }
}

function prettyFallback(speakerId: SpeakerKey): string {
  // "speaker_0" → "Speaker 0"
  const m = /^speaker_(\d+)$/.exec(speakerId);
  if (m) return `Speaker ${m[1]}`;
  return speakerId;
}

/**
 * Privacy service — pure helpers that decide what other services are
 * allowed to do with a meeting based on its `privacy_mode` and the
 * global settings (spec §22).
 *
 * The rules:
 *   'private'     — no transcription, no Drive sync, no AI memory.
 *   'local_only'  — transcription OK, no Drive sync, AI memory OK.
 *   'sensitive'   — transcription OK with redaction, sync OK but
 *                   the drive service should only export the summary,
 *                   AI memory OK.
 *   'normal'      — everything on.
 *
 * Every other service should funnel decisions through this module so
 * the privacy contract stays in one place.
 */
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import type { Meeting, Settings } from '@shared/types/entities';

const logger = log('privacy');

// We cache settings in-memory so the hot-path predicates don't hit
// SQLite on every transcript chunk. The bus subscription below keeps
// it in sync.
let cachedSettings: Settings | null = null;

function settings(): Settings {
  if (!cachedSettings) cachedSettings = getSettings();
  return cachedSettings;
}

// Wire once at module load. The bus is a long-lived singleton.
bus.on('settings_changed', (s) => {
  cachedSettings = s;
  logger.debug('Settings refreshed in privacy cache');
});

export const Privacy = {
  /**
   * May we send this meeting's audio to a transcription provider?
   * Only blocks when the meeting is fully private.
   */
  canTranscribe(meeting: Meeting): boolean {
    return meeting.privacy_mode !== 'private';
  },

  /**
   * May we sync this meeting's notes to Google Drive?
   * Both 'private' and 'local_only' refuse. 'sensitive' allows but the
   * drive service should restrict the export to the summary.
   */
  canSyncToDrive(meeting: Meeting): boolean {
    if (meeting.privacy_mode === 'private') return false;
    if (meeting.privacy_mode === 'local_only') return false;
    return true;
  },

  /**
   * For 'sensitive' meetings we lean on Deepgram's redaction features.
   * Returns the list of redaction tags to send (e.g. ['pii','numbers']).
   * Falls back to the user's configured list, with a sensible default
   * when sensitive is selected but no list is set.
   */
  shouldRedactForDeepgram(meeting: Meeting): string[] {
    if (meeting.privacy_mode !== 'sensitive') {
      return settings().deepgram_redact ?? [];
    }
    const configured = settings().deepgram_redact ?? [];
    if (configured.length > 0) return configured;
    return ['pii', 'numbers'];
  },

  /**
   * May this meeting's content be folded into the AI memory / context
   * used for future generation? Private meetings opt out unconditionally.
   */
  includeInAIMemory(meeting: Meeting): boolean {
    if (meeting.privacy_mode === 'private') return false;
    return true;
  },

  /**
   * Should the title be hidden in lists and notifications? Driven by
   * the global toggle `hide_sensitive_titles`, but only applied for
   * meetings that aren't 'normal'.
   */
  shouldHideTitle(meeting: Meeting): boolean {
    if (!settings().hide_sensitive_titles) return false;
    return meeting.privacy_mode !== 'normal';
  },

  /**
   * Should notification bodies show meeting content? Inverse of the
   * `hide_notification_previews` setting.
   */
  notificationPreviewVisible(): boolean {
    return !settings().hide_notification_previews;
  },

  /** Force a settings refresh — useful in tests. */
  _refresh(): void {
    cachedSettings = getSettings();
  },
};

export type PrivacyModule = typeof Privacy;

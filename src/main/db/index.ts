/**
 * Database initialization. Opens better-sqlite3, applies schema, seeds
 * built-in templates and default settings.
 */
import { app } from 'electron';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { BUILTIN_TEMPLATES } from '@shared/templates/builtin';
import type { Settings } from '@shared/types/entities';
// Vite inlines the schema as a string at build time, so the SQL ships
// inside the bundle and we never need a sibling file at runtime.
// In dev, Vite serves the same import.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite handles the ?raw query.
import SCHEMA_SQL_INLINE from './schema.sql?raw';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized; call initDb() first.');
  return db;
}

const SCHEMA_VERSION = 1;

export function initDb(): Database.Database {
  if (db) return db;

  const userData = app.getPath('userData');
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'meetings.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Locate schema.sql alongside the compiled bundle in dev or prod.
  const schemaSql = loadSchemaSql();
  db.exec(schemaSql);

  ensureSchemaVersion(db);
  migrateFtsIfContentless(db);
  migrateAddMeetingsColumns(db);
  seedBuiltinTemplates(db);
  ensureDefaultSettings(db);
  ensureBuiltinIntegrationsRow(db);

  return db;
}

/**
 * Earlier versions of this app created the meetings_fts and chunks_fts
 * tables with `content=''` (contentless mode). Contentless FTS5 doesn't
 * support DELETE / UPDATE, which we need every time a meeting's title
 * or raw notes change. Detect that case, drop the tables, recreate them
 * from the new schema (already exec'd above as a no-op via IF NOT EXISTS,
 * so we have to drop and recreate explicitly), and rebuild the index
 * from the source tables.
 */
function migrateFtsIfContentless(d: Database.Database): void {
  const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='meetings_fts'").get() as
    | { sql: string }
    | undefined;
  if (!row || !row.sql || !row.sql.includes("content=''")) return;

  const tx = d.transaction(() => {
    d.exec('DROP TABLE IF EXISTS meetings_fts');
    d.exec('DROP TABLE IF EXISTS chunks_fts');
    d.exec("CREATE VIRTUAL TABLE meetings_fts USING fts5(title, raw_notes, summary, tokenize='porter unicode61')");
    d.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, speaker_name, tokenize='porter unicode61')");

    // Rebuild meetings index.
    const meetings = d.prepare('SELECT id, title, raw_notes FROM meetings').all() as Array<{
      id: string;
      title: string;
      raw_notes: string | null;
    }>;
    const noteSummary = d.prepare('SELECT summary FROM generated_notes WHERE meeting_id = ?');
    const insertMeeting = d.prepare(
      'INSERT INTO meetings_fts(rowid, title, raw_notes, summary) VALUES (?,?,?,?)',
    );
    for (const m of meetings) {
      const sumRow = noteSummary.get(m.id) as { summary: string } | undefined;
      insertMeeting.run(hashStringToInt(m.id), m.title, m.raw_notes ?? '', sumRow?.summary ?? '');
    }

    // Rebuild final-chunk index.
    const chunks = d
      .prepare('SELECT id, text, speaker_name FROM transcript_chunks WHERE is_final = 1 AND is_deleted = 0')
      .all() as Array<{ id: string; text: string; speaker_name: string | null }>;
    const insertChunk = d.prepare(
      'INSERT INTO chunks_fts(rowid, text, speaker_name) VALUES (?,?,?)',
    );
    for (const c of chunks) {
      insertChunk.run(hashStringToInt(c.id), c.text, c.speaker_name ?? '');
    }
  });
  tx();
}

/**
 * Add columns introduced after the initial schema. better-sqlite3 raises
 * a duplicate-column-name error if the column already exists, which we
 * silently swallow so this is idempotent.
 */
function migrateAddMeetingsColumns(d: Database.Database): void {
  const cols = [
    "ALTER TABLE meetings ADD COLUMN title_is_auto INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE meetings ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL",
  ];
  for (const sql of cols) {
    try {
      d.exec(sql);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }
}

/**
 * 32-bit FNV-1a — same function as in repositories.ts. Inlined here so the
 * migration doesn't pull in the repository module before the schema is
 * ready.
 */
function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h & 0x7fffffff;
}

function loadSchemaSql(): string {
  // Bundled by Vite via `?raw` — never throws.
  if (typeof SCHEMA_SQL_INLINE === 'string' && SCHEMA_SQL_INLINE.length > 0) {
    return SCHEMA_SQL_INLINE as string;
  }
  // Defensive fallback if someone runs this outside Vite (tests).
  const candidates = [
    join(__dirname, 'schema.sql'),
    join(__dirname, '..', '..', 'src', 'main', 'db', 'schema.sql'),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // try next
    }
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, 'schema.sql'), 'utf-8');
  } catch {
    throw new Error('Could not locate schema.sql');
  }
}

function ensureSchemaVersion(d: Database.Database) {
  const row = d.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
  if (!row) {
    d.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('version', String(SCHEMA_VERSION));
  }
  // Future migrations: read row.value, compare to SCHEMA_VERSION, run migrators.
}

function seedBuiltinTemplates(d: Database.Database) {
  const existing = d.prepare('SELECT name FROM templates WHERE builtin = 1').all() as Array<{ name: string }>;
  const have = new Set(existing.map((r) => r.name));
  const insert = d.prepare(`
    INSERT INTO templates (id, name, description, when_to_use, required_sections, optional_sections, formatting_rules, action_item_format, follow_up_style, drive_folder_path, auto_apply_rules, builtin, created_at, updated_at)
    VALUES (@id,@name,@description,@when_to_use,@required_sections,@optional_sections,@formatting_rules,@action_item_format,@follow_up_style,@drive_folder_path,@auto_apply_rules,1,@now,@now)
  `);
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const t of BUILTIN_TEMPLATES) {
      if (have.has(t.name)) continue;
      insert.run({
        id: 'tpl_' + nanoid(10),
        name: t.name,
        description: t.description,
        when_to_use: t.when_to_use,
        required_sections: JSON.stringify(t.required_sections),
        optional_sections: JSON.stringify(t.optional_sections),
        formatting_rules: t.formatting_rules,
        action_item_format: t.action_item_format,
        follow_up_style: t.follow_up_style,
        drive_folder_path: t.drive_folder_path ?? null,
        auto_apply_rules: JSON.stringify(t.auto_apply_rules),
        now,
      });
    }
  });
  tx();
}

const INTEGRATION_KINDS = [
  'google_drive', 'google_calendar', 'gmail', 'google_contacts', 'google_tasks',
  'slack', 'notion', 'linear', 'todoist', 'asana',
  'apple_reminders', 'apple_calendar', 'outlook', 'onedrive',
  'webhook',
] as const;

function ensureBuiltinIntegrationsRow(d: Database.Database) {
  const existing = d.prepare('SELECT kind FROM integrations').all() as Array<{ kind: string }>;
  const have = new Set(existing.map((r) => r.kind));
  const insert = d.prepare(`
    INSERT INTO integrations (id, kind, name, enabled, status, config, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const kind of INTEGRATION_KINDS) {
      if (have.has(kind)) continue;
      insert.run('itg_' + nanoid(10), kind, prettyName(kind), 1, 'disconnected', '{}', now, now);
    }
  });
  tx();
}

function prettyName(k: string): string {
  return k
    .split('_')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(' ');
}

// -----------------------------------------------------------------------
// Settings — stored in a single row keyed by 'singleton'
// -----------------------------------------------------------------------
export const DEFAULT_SETTINGS: Settings = {
  setup_completed: false,
  advanced_labs_enabled: false,

  detect_zoom: true,
  detect_google_meet: true,
  detect_teams: true,
  detect_slack: true,
  detect_webex: true,
  detect_discord: true,
  detect_facetime: true,
  detect_browser_calls: true,
  auto_start_mode: 'ask',
  auto_stop_on_call_end: true,
  auto_stop_after_silence_minutes: 5,
  auto_stop_on_calendar_end: true,
  max_meeting_duration_minutes: 240,
  show_low_confidence_detection: false,

  deepgram_model: 'nova-3',
  deepgram_language: 'en-US',
  deepgram_smart_format: true,
  deepgram_diarize: true,
  deepgram_multichannel: true,
  deepgram_redact: [],
  store_audio: false,
  daily_transcription_limit_minutes: 600,
  monthly_transcription_warn_minutes: 500,
  monthly_transcription_hard_stop_minutes: 3000,

  default_note_style: 'medium',
  default_note_tone: 'direct',
  default_note_format: 'bullets',
  raw_notes_priority: true,
  include_previous_meeting_context: true,
  ai_model: 'gpt-5',

  drive_sync_mode: 'all',
  drive_folder_strategy: 'hybrid',
  drive_export_formats: ['google_doc', 'markdown'],
  drive_two_way_sync: false,

  default_privacy_mode: 'normal',
  hide_sensitive_titles: false,
  hide_notification_previews: true,
  app_lock_enabled: false,
  app_lock_inactivity_minutes: 15,

  keep_summaries_forever: true,
  delete_transcripts_after_days: null,
  delete_private_meetings_after_days: 30,

  local_api_enabled: false,
  local_api_port: 47823,
  mcp_enabled: false,
  mcp_disable_transcript_access: false,
  mcp_disable_private_notes: true,
};

export function ensureDefaultSettings(d: Database.Database) {
  const row = d.prepare("SELECT value FROM schema_meta WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    d.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('settings', JSON.stringify(DEFAULT_SETTINGS));
  }
}

export function getSettings(): Settings {
  const d = getDb();
  const row = d.prepare("SELECT value FROM schema_meta WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const d = getDb();
  const merged = { ...getSettings(), ...patch };
  d.prepare("UPDATE schema_meta SET value = ? WHERE key = 'settings'").run(JSON.stringify(merged));
  return merged;
}

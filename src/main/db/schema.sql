-- Cherios SQLite schema.
-- Maps the entities in src/shared/types/entities.ts to relational storage.
-- JSON columns are used for nested arrays/objects to avoid an explosion of join tables;
-- queries that need indexing on those fields lift the field into a dedicated column.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- People / companies / projects / folders
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  role TEXT,
  relationship_type TEXT,
  notes TEXT,
  ai_profile TEXT,
  voice_embedding_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_email ON people(email);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  notes TEXT,
  ai_profile TEXT,
  drive_folder_id TEXT,
  crm_link TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  drive_folder_id TEXT,
  ai_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  drive_folder_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Templates
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  when_to_use TEXT,
  required_sections TEXT NOT NULL DEFAULT '[]', -- json
  optional_sections TEXT NOT NULL DEFAULT '[]', -- json
  formatting_rules TEXT,
  action_item_format TEXT,
  follow_up_style TEXT,
  drive_folder_path TEXT,
  auto_apply_rules TEXT NOT NULL DEFAULT '[]', -- json
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Calendar events (cached)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  title TEXT,
  description TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  attendees TEXT NOT NULL DEFAULT '[]', -- json
  meeting_link TEXT,
  meeting_app_hint TEXT,
  recurring_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_starts_at ON calendar_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_recurring ON calendar_events(recurring_id);

-- -----------------------------------------------------------------------
-- Meetings
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_app TEXT NOT NULL,
  calendar_event_id TEXT REFERENCES calendar_events(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  privacy_mode TEXT NOT NULL DEFAULT 'normal',
  drive_sync_status TEXT NOT NULL DEFAULT 'not_synced',
  drive_file_ids TEXT NOT NULL DEFAULT '{}', -- json
  detection_confidence TEXT,
  language TEXT,
  raw_notes TEXT,
  -- 1 while title is the placeholder ("Quick note · …"); flipped to 0 once
  -- either the user renames manually or the AI produces a real title.
  title_is_auto INTEGER NOT NULL DEFAULT 1,
  -- Filesystem-style folder containment. NULL means the note is in the
  -- root inbox.
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_template ON meetings(template_id);
CREATE INDEX IF NOT EXISTS idx_meetings_privacy ON meetings(privacy_mode);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id)
);

CREATE TABLE IF NOT EXISTS meeting_projects (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, project_id)
);

CREATE TABLE IF NOT EXISTS meeting_companies (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, company_id)
);

-- -----------------------------------------------------------------------
-- Transcript chunks
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  deepgram_request_id TEXT,
  channel INTEGER,
  speaker_id TEXT,
  speaker_name TEXT,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  text TEXT NOT NULL,
  words TEXT, -- json TranscriptWord[]
  confidence REAL,
  language TEXT,
  is_final INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_highlighted INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'mixed',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON transcript_chunks(meeting_id, start_time);
CREATE INDEX IF NOT EXISTS idx_chunks_speaker ON transcript_chunks(meeting_id, speaker_id);

-- Persistent speaker name memory (per-meeting and global hints).
CREATE TABLE IF NOT EXISTS speaker_mappings (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE, -- null = global
  speaker_id TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  voice_embedding BLOB,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speaker_mappings_meeting ON speaker_mappings(meeting_id);

-- -----------------------------------------------------------------------
-- Generated notes
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  sections TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  action_items TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  quotes TEXT NOT NULL DEFAULT '[]',
  follow_up_email TEXT,
  personal_reminders TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tone TEXT,
  length_preset TEXT,
  format_preset TEXT
);

-- -----------------------------------------------------------------------
-- Action items
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'me',
  owner_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  source_chunk_id TEXT REFERENCES transcript_chunks(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  external_ids TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_meeting ON action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_action_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_due ON action_items(due_date);

-- -----------------------------------------------------------------------
-- Drive sync rules
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drive_sync_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  formats TEXT NOT NULL DEFAULT '["google_doc"]',
  folder_strategy TEXT NOT NULL DEFAULT 'hybrid',
  custom_path_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Automations
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Chat threads
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,                     -- json ChatScope
  messages TEXT NOT NULL DEFAULT '[]',     -- json ChatMessage[]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Integrations
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_email TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Detection ignore rules
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detection_ignore_rules (
  id TEXT PRIMARY KEY,
  source_app TEXT,
  domain TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detection_always_start_rules (
  id TEXT PRIMARY KEY,
  source_app TEXT,
  domain TEXT,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Usage metering (Deepgram budget guardrails)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);

-- -----------------------------------------------------------------------
-- Full-text search.
-- These are *not* contentless tables: contentless FTS5 (`content=''`)
-- doesn't support DELETE/UPDATE, which we need every time a meeting's
-- title/raw_notes/summary changes. The storage cost is small (the text
-- is also held in the source tables but that's fine for personal scale).
-- -----------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
  title, raw_notes, summary, tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, speaker_name, tokenize='porter unicode61'
);

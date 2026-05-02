/**
 * Cherios entity types.
 * Source of truth for the data model defined in spec §28.
 *
 * Every entity is keyed by a string id (nanoid). Timestamps are ISO 8601 strings.
 */

export type ID = string;
export type ISODate = string; // "2026-04-30T15:00:00Z"

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export type SourceApp =
  | 'zoom'
  | 'google_meet'
  | 'microsoft_teams'
  | 'slack_huddle'
  | 'webex'
  | 'discord'
  | 'facetime'
  | 'browser'
  | 'unknown';

export type PrivacyMode = 'normal' | 'private' | 'local_only' | 'sensitive';

export type DriveSyncStatus =
  | 'not_synced'
  | 'queued'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'conflict';

export interface Meeting {
  id: ID;
  title: string;
  source_app: SourceApp;
  calendar_event_id?: string | null;
  started_at: ISODate;
  ended_at?: ISODate | null;
  attendees: ID[]; // person ids
  project_ids: ID[];
  company_ids: ID[];
  /** Filesystem folder this note lives in (null = root inbox). */
  folder_id?: ID | null;
  template_id?: ID | null;
  privacy_mode: PrivacyMode;
  drive_sync_status: DriveSyncStatus;
  drive_file_ids: {
    google_doc?: string;
    markdown?: string;
    pdf?: string;
    txt?: string;
    json?: string;
  };
  detection_confidence?: 'high' | 'medium' | 'low';
  language?: string;
  raw_notes?: string; // markdown
  /**
   * True while the title is still the placeholder shown on creation.
   * Flipped to false on the user's first manual rename, or when the AI
   * engine produces a meaningful title from meeting content.
   */
  title_is_auto?: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string;
}

export interface TranscriptChunk {
  id: ID;
  meeting_id: ID;
  provider: 'deepgram' | 'whisper_local' | 'whisper_cloud';
  deepgram_request_id?: string;
  channel?: number; // 0 = mic, 1 = system
  speaker_id?: string; // raw deepgram speaker_0, etc.
  speaker_name?: string; // mapped name (Me, Sarah, …)
  start_time: number; // seconds from meeting start
  end_time: number;
  text: string;
  words?: TranscriptWord[];
  confidence?: number;
  language?: string;
  is_final: boolean;
  is_deleted: boolean;
  is_highlighted: boolean;
  source: 'microphone' | 'system_audio' | 'mixed';
  created_at: ISODate;
}

// ---------------------------------------------------------------------------
// AI-generated note
// ---------------------------------------------------------------------------

export interface NoteSection {
  heading: string;
  body: string; // markdown
}

export interface ActionItemDraft {
  task: string;
  owner: string; // raw name; resolved to Person later
  due_date?: ISODate | null;
  priority?: 'low' | 'medium' | 'high';
  source_chunk_ids: ID[];
  confidence: number;
}

export interface DecisionDraft {
  text: string;
  source_chunk_ids: ID[];
}

export interface QuoteDraft {
  speaker: string;
  text: string;
  start_time?: number;
  source_chunk_ids: ID[];
}

export interface GeneratedNote {
  id: ID;
  meeting_id: ID;
  template_id?: ID | null;
  summary: string; // markdown
  sections: NoteSection[];
  decisions: DecisionDraft[];
  action_items: ActionItemDraft[];
  open_questions: string[];
  risks: string[];
  quotes: QuoteDraft[];
  follow_up_email?: string;
  personal_reminders: string[];
  created_at: ISODate;
  updated_at: ISODate;
  model: string; // e.g., "claude-sonnet-4-5"
  tone?: string;
  length_preset?: 'short' | 'medium' | 'detailed';
  format_preset?: 'bullets' | 'narrative' | 'table' | 'product_spec' | 'crm' | 'research';
}

// ---------------------------------------------------------------------------
// Action items (canonical, post-extraction)
// ---------------------------------------------------------------------------

export interface ActionItem {
  id: ID;
  meeting_id: ID;
  task: string;
  owner: string; // "me" or person id or freeform name
  owner_person_id?: ID | null;
  due_date?: ISODate | null;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'done' | 'cancelled' | 'waiting';
  source_chunk_id?: ID | null;
  confidence: number;
  external_ids?: Record<string, string>; // e.g. { google_tasks: "...", linear: "..." }
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// People, Companies, Projects, Folders
// ---------------------------------------------------------------------------

export interface Person {
  id: ID;
  name: string;
  email?: string;
  company_id?: ID | null;
  role?: string;
  relationship_type?: string; // colleague, customer, investor, mentor, friend, …
  notes?: string;
  ai_profile?: string; // generated summary
  voice_embedding_id?: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Company {
  id: ID;
  name: string;
  domain?: string;
  website?: string;
  notes?: string;
  ai_profile?: string;
  drive_folder_id?: string | null;
  crm_link?: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Project {
  id: ID;
  name: string;
  description?: string;
  drive_folder_id?: string | null;
  ai_summary?: string;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Folder {
  id: ID;
  name: string;
  parent_id?: ID | null;
  drive_folder_id?: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateAutoApplyRule {
  field:
    | 'calendar_title'
    | 'attendee_email'
    | 'attendee_domain'
    | 'company_id'
    | 'project_id'
    | 'meeting_app'
    | 'recurring'
    | 'folder_id'
    | 'keyword_in_first_5_minutes';
  operator: 'contains' | 'equals' | 'matches' | 'in' | 'is_true';
  value: string | string[] | boolean;
}

export interface Template {
  id: ID;
  name: string;
  description: string;
  when_to_use: string;
  required_sections: string[];
  optional_sections: string[];
  formatting_rules: string;
  action_item_format: string;
  follow_up_style: string;
  drive_folder_path?: string;
  auto_apply_rules: TemplateAutoApplyRule[];
  builtin: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Drive sync
// ---------------------------------------------------------------------------

export type DriveExportFormat = 'google_doc' | 'markdown' | 'pdf' | 'txt' | 'json';

export interface DriveSyncRule {
  id: ID;
  name: string;
  scope: 'all' | 'template' | 'project' | 'folder' | 'manual';
  scope_id?: ID | null;
  formats: DriveExportFormat[];
  folder_strategy: 'date' | 'project' | 'person' | 'company' | 'hybrid' | 'custom';
  custom_path_template?: string; // e.g. "/AI Meeting Notes/{year}/{month}"
  enabled: boolean;
  created_at: ISODate;
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export type AutomationTrigger =
  | 'meeting_created'
  | 'meeting_ended'
  | 'meeting_notes_generated'
  | 'action_item_detected'
  | 'note_added_to_project'
  | 'person_detected'
  | 'company_detected'
  | 'keyword_detected'
  | 'drive_sync_complete';

export interface AutomationCondition {
  field:
    | 'calendar_title'
    | 'attendee_email'
    | 'attendee_domain'
    | 'meeting_app'
    | 'template'
    | 'project'
    | 'folder'
    | 'keyword'
    | 'meeting_length_minutes'
    | 'action_item_count';
  operator: 'contains' | 'equals' | 'matches' | 'gt' | 'lt' | 'in';
  value: string | number | string[];
}

export type AutomationActionType =
  | 'apply_template'
  | 'move_to_folder'
  | 'sync_to_drive'
  | 'create_gmail_draft'
  | 'create_google_task'
  | 'post_to_slack'
  | 'create_notion_page'
  | 'create_linear_issue'
  | 'send_webhook'
  | 'tag_person'
  | 'tag_company'
  | 'generate_summary';

export interface AutomationAction {
  type: AutomationActionType;
  template_id?: ID;
  folder?: string;
  template?: string; // gmail template name etc.
  url?: string; // webhook
  payload?: Record<string, unknown>;
}

export interface AutomationRule {
  id: ID;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  enabled: boolean;
  last_run_at?: ISODate | null;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Chat threads
// ---------------------------------------------------------------------------

export type ChatScope =
  | { kind: 'all' }
  | { kind: 'meeting'; meeting_id: ID }
  | { kind: 'meetings'; meeting_ids: ID[] }
  | { kind: 'person'; person_id: ID }
  | { kind: 'company'; company_id: ID }
  | { kind: 'project'; project_id: ID }
  | { kind: 'folder'; folder_id: ID }
  | { kind: 'date_range'; from: ISODate; to: ISODate };

export interface ChatMessage {
  id: ID;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: ISODate;
  citations?: Array<{ meeting_id: ID; chunk_id?: ID; quote?: string }>;
}

export interface ChatThread {
  id: ID;
  title: string;
  scope: ChatScope;
  messages: ChatMessage[];
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export type IntegrationKind =
  | 'google_drive'
  | 'google_calendar'
  | 'gmail'
  | 'google_contacts'
  | 'google_tasks'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'todoist'
  | 'asana'
  | 'apple_reminders'
  | 'apple_calendar'
  | 'outlook'
  | 'onedrive'
  | 'hubspot'
  | 'salesforce'
  | 'attio'
  | 'affinity'
  | 'airtable'
  | 'obsidian'
  | 'webhook';

export interface Integration {
  id: ID;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  // Tokens go in keychain — only the metadata lives in DB.
  account_email?: string;
  config?: Record<string, unknown>;
  last_synced_at?: ISODate | null;
  status: 'connected' | 'disconnected' | 'error';
  error_message?: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Calendar events (cached)
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: ID; // local id
  external_id: string; // google calendar id
  provider: 'google' | 'outlook' | 'apple';
  title: string;
  description?: string;
  starts_at: ISODate;
  ends_at: ISODate;
  attendees: Array<{ email: string; name?: string; response_status?: string }>;
  meeting_link?: string;
  meeting_app_hint?: SourceApp;
  recurring_id?: string;
  created_at: ISODate;
  updated_at: ISODate;
}

// ---------------------------------------------------------------------------
// Settings (small kv store, plus typed settings tree)
// ---------------------------------------------------------------------------

export interface Settings {
  // release / onboarding
  setup_completed: boolean;
  advanced_labs_enabled: boolean;

  // detection
  detect_zoom: boolean;
  detect_google_meet: boolean;
  detect_teams: boolean;
  detect_slack: boolean;
  detect_webex: boolean;
  detect_discord: boolean;
  detect_facetime: boolean;
  detect_browser_calls: boolean;
  auto_start_mode: 'never' | 'ask' | 'calendar' | 'known_apps' | 'all';
  auto_stop_on_call_end: boolean;
  auto_stop_after_silence_minutes: number;
  auto_stop_on_calendar_end: boolean;
  max_meeting_duration_minutes: number;
  show_low_confidence_detection: boolean;

  // transcription
  deepgram_model: 'nova-3' | 'nova-2' | 'enhanced';
  deepgram_language: string;
  deepgram_smart_format: boolean;
  deepgram_diarize: boolean;
  deepgram_multichannel: boolean;
  deepgram_redact: string[]; // e.g. ['pii','numbers']
  store_audio: boolean;
  daily_transcription_limit_minutes: number;
  monthly_transcription_warn_minutes: number;
  monthly_transcription_hard_stop_minutes: number;

  // ai
  default_note_style: 'short' | 'medium' | 'detailed';
  default_note_tone: 'clean' | 'direct' | 'executive' | 'casual' | 'technical';
  default_note_format: 'bullets' | 'narrative' | 'table' | 'product_spec' | 'crm' | 'research';
  raw_notes_priority: boolean;
  include_previous_meeting_context: boolean;
  ai_model: string;

  // drive
  drive_sync_mode: 'off' | 'ask' | 'all' | 'selected';
  drive_folder_strategy: 'date' | 'project' | 'person' | 'company' | 'hybrid';
  drive_export_formats: DriveExportFormat[];
  drive_two_way_sync: boolean;

  // privacy
  default_privacy_mode: PrivacyMode;
  hide_sensitive_titles: boolean;
  hide_notification_previews: boolean;
  app_lock_enabled: boolean;
  app_lock_inactivity_minutes: number;

  // retention
  keep_summaries_forever: boolean;
  delete_transcripts_after_days?: number | null;
  delete_private_meetings_after_days?: number | null;

  // api / mcp
  local_api_enabled: boolean;
  local_api_port: number;
  mcp_enabled: boolean;
  mcp_disable_transcript_access: boolean;
  mcp_disable_private_notes: boolean;
}

// ---------------------------------------------------------------------------
// Detection signals & state (transient — not persisted)
// ---------------------------------------------------------------------------

export interface DetectionSignal {
  source_app?: SourceApp;
  process_name?: string;
  window_title?: string;
  browser_url?: string;
  microphone_active: boolean;
  system_audio_active: boolean;
  human_speech_detected?: boolean;
  multiple_voices_detected?: boolean;
  calendar_event_active?: CalendarEvent | null;
  bluetooth_call_mode?: boolean;
  foreground_app?: string;
  timestamp: ISODate;
}

export interface DetectedMeeting {
  source_app: SourceApp;
  title?: string;
  attendees?: string[];
  calendar_event?: CalendarEvent | null;
  confidence: 'high' | 'medium' | 'low';
  signals: DetectionSignal;
}

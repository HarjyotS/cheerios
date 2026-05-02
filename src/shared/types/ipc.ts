/**
 * IPC contract between main and renderer.
 * The preload bridge exposes window.api with these methods.
 */
import type {
  Meeting,
  TranscriptChunk,
  GeneratedNote,
  ActionItem,
  Person,
  Company,
  Project,
  Folder,
  Template,
  AutomationRule,
  ChatThread,
  ChatScope,
  Integration,
  CalendarEvent,
  Settings,
  PrivacyMode,
  DriveExportFormat,
  DetectedMeeting,
  ID,
} from './entities';
import type { TranscriptEvent } from './transcript-events';

export interface MeetingsAPI {
  list(filter?: { from?: string; to?: string; project_id?: ID; person_id?: ID; company_id?: ID; folder_id?: ID | null }): Promise<Meeting[]>;
  get(id: ID): Promise<Meeting | null>;
  create(input: Partial<Meeting> & { title: string }): Promise<Meeting>;
  update(id: ID, patch: Partial<Meeting>): Promise<Meeting>;
  delete(id: ID): Promise<void>;
  /** Move a note into a folder (null = root inbox). */
  move(id: ID, folderId: ID | null): Promise<Meeting>;
  start(id: ID): Promise<void>; // start transcription
  stop(id: ID): Promise<void>;
  pause(id: ID): Promise<void>;
  resume(id: ID): Promise<void>;
  /** Re-open an ended meeting and resume capture into the same note. */
  reopen(id: ID): Promise<Meeting>;
  setPrivacy(id: ID, mode: PrivacyMode): Promise<void>;
  deleteLastSeconds(id: ID, seconds: number): Promise<void>;
  getRawNotes(id: ID): Promise<string>;
  setRawNotes(id: ID, markdown: string): Promise<void>;
}

export interface TranscriptAPI {
  listChunks(meetingId: ID): Promise<TranscriptChunk[]>;
  highlight(chunkId: ID, on: boolean): Promise<void>;
  delete(chunkId: ID): Promise<void>;
  renameSpeaker(meetingId: ID, speakerId: string, name: string, persist: boolean): Promise<void>;
}

export interface NotesAPI {
  get(meetingId: ID): Promise<GeneratedNote | null>;
  generate(meetingId: ID, opts?: { templateId?: ID; tone?: string; length?: 'short' | 'medium' | 'detailed' }): Promise<GeneratedNote>;
  regenerateSection(meetingId: ID, section: string): Promise<GeneratedNote>;
  transform(meetingId: ID, kind: 'shorter' | 'detailed' | 'study_notes' | 'action_items_only' | 'pain_points' | 'engineering_reqs' | 'follow_up_email' | 'product_spec' | 'investor_update' | 'interview_eval' | 'translate' | 'tone'): Promise<GeneratedNote>;
}

export interface ActionItemsAPI {
  list(filter?: { status?: string; person_id?: ID; company_id?: ID; project_id?: ID; due_before?: string }): Promise<ActionItem[]>;
  update(id: ID, patch: Partial<ActionItem>): Promise<ActionItem>;
  delete(id: ID): Promise<void>;
  syncTo(id: ID, integration: 'google_tasks' | 'todoist' | 'linear' | 'notion' | 'asana' | 'apple_reminders'): Promise<void>;
}

export interface PeopleAPI {
  list(): Promise<Person[]>;
  get(id: ID): Promise<Person | null>;
  upsert(person: Partial<Person> & { name: string }): Promise<Person>;
  delete(id: ID): Promise<void>;
  meetings(id: ID): Promise<Meeting[]>;
  buildProfile(id: ID): Promise<string>;
}

export interface CompaniesAPI {
  list(): Promise<Company[]>;
  get(id: ID): Promise<Company | null>;
  upsert(company: Partial<Company> & { name: string }): Promise<Company>;
  delete(id: ID): Promise<void>;
  meetings(id: ID): Promise<Meeting[]>;
  buildProfile(id: ID): Promise<string>;
}

export interface ProjectsAPI {
  list(): Promise<Project[]>;
  get(id: ID): Promise<Project | null>;
  upsert(project: Partial<Project> & { name: string }): Promise<Project>;
  delete(id: ID): Promise<void>;
  meetings(id: ID): Promise<Meeting[]>;
}

export interface FoldersAPI {
  list(): Promise<Folder[]>;
  upsert(folder: Partial<Folder> & { name: string }): Promise<Folder>;
  delete(id: ID): Promise<void>;
}

export interface TemplatesAPI {
  list(): Promise<Template[]>;
  get(id: ID): Promise<Template | null>;
  upsert(t: Partial<Template> & { name: string }): Promise<Template>;
  delete(id: ID): Promise<void>;
  pickForMeeting(meetingId: ID): Promise<Template | null>;
}

export interface AutomationsAPI {
  list(): Promise<AutomationRule[]>;
  upsert(rule: Partial<AutomationRule> & { name: string; trigger: AutomationRule['trigger'] }): Promise<AutomationRule>;
  delete(id: ID): Promise<void>;
  runOnce(ruleId: ID, meetingId: ID): Promise<void>;
}

export interface ChatAPI {
  threads(): Promise<ChatThread[]>;
  thread(id: ID): Promise<ChatThread | null>;
  newThread(scope: ChatScope, title?: string): Promise<ChatThread>;
  send(threadId: ID, message: string): Promise<ChatThread>;
  delete(id: ID): Promise<void>;
}

export interface DriveAPI {
  status(): Promise<{ connected: boolean; account?: string }>;
  connect(): Promise<{ ok: true; account: string } | { ok: false; error: string }>;
  disconnect(): Promise<void>;
  syncMeeting(id: ID, formats?: DriveExportFormat[]): Promise<void>;
  resyncAll(): Promise<{ queued: number }>;
  openInDrive(meetingId: ID): Promise<void>;
}

export interface GmailAPI {
  status(): Promise<{ connected: boolean; account?: string }>;
  connect(): Promise<{ ok: true; account: string } | { ok: false; error: string }>;
  draftFollowUp(meetingId: ID, kind: 'thank_you' | 'sales' | 'investor' | 'research' | 'recruiting' | 'recap' | 'intro'): Promise<{ draftId: string; url: string }>;
}

export interface CalendarAPI {
  status(): Promise<{ connected: boolean; account?: string }>;
  connect(): Promise<{ ok: true; account: string } | { ok: false; error: string }>;
  upcoming(): Promise<CalendarEvent[]>;
  forNow(): Promise<CalendarEvent | null>;
  refresh(): Promise<void>;
}

export interface SettingsAPI {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
  reset(): Promise<Settings>;
}

export interface IntegrationsAPI {
  list(): Promise<Integration[]>;
  setEnabled(kind: Integration['kind'], enabled: boolean): Promise<void>;
  setConfig(kind: Integration['kind'], config: Record<string, unknown>): Promise<Integration>;
  authorize(kind: Integration['kind']): Promise<{ ok: boolean; error?: string }>;
  disconnect(kind: Integration['kind']): Promise<void>;
}

export interface SearchAPI {
  meetings(q: string, limit?: number): Promise<Array<{ meeting: Meeting; snippet: string }>>;
  semantic(q: string, scope?: ChatScope): Promise<Array<{ meeting: Meeting; snippet: string; score: number }>>;
}

export interface DetectionAPI {
  current(): Promise<DetectedMeeting | null>;
  ignoreOnce(detection: DetectedMeeting): Promise<void>;
  alwaysStartFor(rule: { source_app?: string; domain?: string; calendar_event_id?: string }): Promise<void>;
  alwaysIgnore(rule: { source_app?: string; domain?: string; person_id?: ID; company_id?: ID; calendar_event_id?: string }): Promise<void>;
}

export interface AppAPI {
  ready(): Promise<{ version: string }>;
  showMainWindow(): Promise<void>;
  openMeeting(meetingId: ID): Promise<void>;
  showFloatingWidget(meetingId?: ID): Promise<void>;
  showCommandPalette(): Promise<void>;
  dismissDetectionOverlay(): Promise<void>;
  togglePrivateMode(): Promise<void>;
  exportAllData(): Promise<{ path: string }>;
  deleteAllData(): Promise<void>;
  /** Whether each known API key is currently set in the keychain. */
  getKeyStatus(): Promise<Record<string, boolean>>;
  /** Set (or clear, when value is empty) one API key. */
  setKey(name: string, value: string): Promise<{ ok: true }>;
  /** macOS Privacy gate status for mic + screen recording. */
  getPermissionStatus(): Promise<{ microphone: string; screen: string }>;
  /** Open a specific Privacy pane in System Settings (macOS only). */
  openSystemSettings(pane: 'screen' | 'microphone' | 'automation' | 'privacy'): Promise<void>;
}

/** Subscription channels — main → renderer push. */
export interface EventsAPI {
  onTranscript(cb: (e: TranscriptEvent) => void): () => void;
  onMeetingDetected(cb: (d: DetectedMeeting | null) => void): () => void;
  onMeetingUpdated(cb: (m: Meeting) => void): () => void;
  onNoteUpdated(cb: (n: GeneratedNote) => void): () => void;
  onSyncStatus(cb: (s: { meetingId: ID; status: string; error?: string }) => void): () => void;
  onNotification(cb: (n: { kind: string; title: string; body?: string; meetingId?: ID }) => void): () => void;
  onSettingsChanged(cb: (s: Settings) => void): () => void;
}

export interface API {
  app: AppAPI;
  meetings: MeetingsAPI;
  transcript: TranscriptAPI;
  notes: NotesAPI;
  actionItems: ActionItemsAPI;
  people: PeopleAPI;
  companies: CompaniesAPI;
  projects: ProjectsAPI;
  folders: FoldersAPI;
  templates: TemplatesAPI;
  automations: AutomationsAPI;
  chat: ChatAPI;
  drive: DriveAPI;
  gmail: GmailAPI;
  calendar: CalendarAPI;
  settings: SettingsAPI;
  integrations: IntegrationsAPI;
  search: SearchAPI;
  detection: DetectionAPI;
  events: EventsAPI;
}

/** IPC channel names — keep in sync with main/ipc/handlers.ts. */
export const IPC = {
  // request/response
  invoke: 'pmos:invoke', // single multiplexed channel: { domain, method, args }
  // push streams
  transcript: 'pmos:event:transcript',
  meetingDetected: 'pmos:event:meeting_detected',
  meetingUpdated: 'pmos:event:meeting_updated',
  noteUpdated: 'pmos:event:note_updated',
  syncStatus: 'pmos:event:sync_status',
  notification: 'pmos:event:notification',
  settingsChanged: 'pmos:event:settings_changed',
} as const;

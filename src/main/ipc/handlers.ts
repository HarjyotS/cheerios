/**
 * Top-level IPC handler registration. Each domain delegates to the
 * matching service module.
 */
import { app, BrowserWindow, shell, systemPreferences } from 'electron';
import { registerDomain } from './index';
import { bus } from '../lib/event-bus';
import { getSettings, saveSettings } from '../db';
import {
  Meetings, TranscriptChunks, GeneratedNotes, ActionItems, People, Companies,
  Projects, Folders, Templates, Automations, ChatThreads, Integrations, DetectionRules,
} from '../db/repositories';
import { services } from '../lib/service-registry';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getSecret, setSecret, deleteSecret, SECRET_KEYS } from '../lib/secrets';
import type { ChatScope, ID, Settings } from '@shared/types/entities';

// Whitelist of keys editable from the renderer. Anything else is rejected
// to prevent the renderer from poking at internal secrets.
type KeyName = 'openai' | 'deepgram' | 'google_client_id' | 'google_client_secret' | 'todoist' | 'linear' | 'notion' | 'asana' | 'slack';
const KEY_MAP: Record<KeyName, string> = {
  openai: SECRET_KEYS.openaiApiKey,
  deepgram: SECRET_KEYS.deepgramApiKey,
  google_client_id: SECRET_KEYS.googleClientId,
  google_client_secret: SECRET_KEYS.googleClientSecret,
  todoist: SECRET_KEYS.todoistToken,
  linear: SECRET_KEYS.linearToken,
  notion: SECRET_KEYS.notionToken,
  asana: SECRET_KEYS.asanaToken,
  slack: SECRET_KEYS.slackToken,
};

export function registerAllHandlers() {
  // -------- app --------
  registerDomain('app', {
    ready: () => ({ version: app.getVersion() }),
    showMainWindow: () => {
      const win = findMainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    openMeeting: (meetingId: ID) => {
      const win = findMainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      const hash = `#/meeting/${encodeURIComponent(meetingId)}`;
      win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
    },
    showFloatingWidget: () => { /* main handles */ },
    showCommandPalette: () => { /* main forwards via menu */ },
    dismissDetectionOverlay: () => {
      const win = findDetectionOverlayWindow();
      if (win && !win.isDestroyed()) win.hide();
    },
    togglePrivateMode: async () => {
      const s = getSettings();
      const next = s.default_privacy_mode === 'private' ? 'normal' : 'private';
      const updated = saveSettings({ default_privacy_mode: next });
      bus.emit('settings_changed', updated);
      return updated;
    },
    exportAllData: async () => {
      const out = join(app.getPath('downloads'), `pmos-export-${Date.now()}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'meetings.json'), JSON.stringify(Meetings.list(), null, 2));
      writeFileSync(join(out, 'people.json'), JSON.stringify(People.list(), null, 2));
      writeFileSync(join(out, 'companies.json'), JSON.stringify(Companies.list(), null, 2));
      writeFileSync(join(out, 'projects.json'), JSON.stringify(Projects.list(), null, 2));
      writeFileSync(join(out, 'action_items.json'), JSON.stringify(ActionItems.list(), null, 2));
      writeFileSync(join(out, 'templates.json'), JSON.stringify(Templates.list(), null, 2));
      writeFileSync(join(out, 'automations.json'), JSON.stringify(Automations.list(), null, 2));
      shell.openPath(out);
      return { path: out };
    },
    deleteAllData: async () => {
      const dataDir = join(app.getPath('userData'), 'data');
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      app.relaunch(); app.exit(0);
    },
    /**
     * Returns booleans for each known API key indicating whether it's set.
     * Never returns the key value — only presence.
     */
    getKeyStatus: async () => {
      const out: Record<string, boolean> = {};
      for (const [name, secretKey] of Object.entries(KEY_MAP)) {
        const v = await getSecret(secretKey);
        out[name] = !!(v && v.length > 0);
      }
      return out;
    },
    /**
     * Returns macOS media permission statuses. On non-darwin returns 'granted'
     * for everything since there's no equivalent gate.
     */
    getPermissionStatus: async (): Promise<{ microphone: string; screen: string }> => {
      if (process.platform !== 'darwin') {
        return { microphone: 'granted', screen: 'granted' };
      }
      return {
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
        screen: systemPreferences.getMediaAccessStatus('screen'),
      };
    },
    /**
     * Open a specific macOS Privacy pane. The url scheme is documented by
     * Apple. On non-darwin platforms this is a no-op.
     */
    openSystemSettings: async (pane: 'screen' | 'microphone' | 'automation' | 'privacy') => {
      if (process.platform !== 'darwin') return;
      const urls: Record<string, string> = {
        screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
        privacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy',
      };
      shell.openExternal(urls[pane] ?? urls.privacy);
    },
    /** Set or clear a single API key. Pass an empty string to clear. */
    setKey: async (name: KeyName, value: string) => {
      const secretKey = KEY_MAP[name];
      if (!secretKey) throw new Error('Unknown key: ' + name);
      const v = (value ?? '').trim();
      if (v.length === 0) await deleteSecret(secretKey);
      else await setSecret(secretKey, v);
      return { ok: true };
    },
  });

  // -------- meetings --------
  registerDomain('meetings', {
    list: (filter: any) => Meetings.list(filter),
    get: (id: ID) => Meetings.get(id),
    create: async (input: any) => {
      // Enforce single-live-meeting: stop any meetings without an ended_at
      // before starting a new one. Audio capture (mic + system) is the
      // renderer's responsibility; we tell it to release via the same
      // event the UI uses to detect "live" state.
      const live = Meetings.list().filter((x) => !x.ended_at);
      for (const old of live) {
        try {
          await services.deepgram?.stopForMeeting(old.id);
        } catch {
          /* ignore */
        }
        const ended = Meetings.update(old.id, { ended_at: new Date().toISOString() });
        bus.emit('meeting_ended', ended);
        bus.emit('meeting_updated', ended);
        bus.emit('automation_trigger', { trigger: 'meeting_ended', meetingId: old.id });
        // Best-effort note generation for the meeting we just ended.
        services.ai?.generateNoteAsync(old.id).catch(() => undefined);
      }

      const m = Meetings.create(input);
      bus.emit('meeting_started', m);
      bus.emit('meeting_updated', m);
      bus.emit('automation_trigger', { trigger: 'meeting_created', meetingId: m.id });
      return m;
    },
    update: (id: ID, patch: any) => {
      const m = Meetings.update(id, patch);
      bus.emit('meeting_updated', m);
      return m;
    },
    delete: (id: ID) => {
      Meetings.delete(id);
      bus.emit('meeting_updated', { id, deleted: true } as any);
    },
    move: (id: ID, folderId: ID | null) => {
      const m = Meetings.update(id, { folder_id: folderId ?? null });
      bus.emit('meeting_updated', m);
      return m;
    },
    start: async (id: ID) => {
      await services.deepgram?.startForMeeting(id);
      // Mic + system-audio capture are driven by the renderer (WebAudio +
      // getDisplayMedia loopback). The renderer calls
      // window.audio.sendStart('mic'|'system', …) which routes here via the
      // audio capture service.
    },
    stop: async (id: ID) => {
      await services.deepgram?.stopForMeeting(id);
      const ended = Meetings.update(id, { ended_at: new Date().toISOString() });
      bus.emit('meeting_ended', ended);
      // Also emit meeting_updated so the renderer (which subscribes to that
      // channel) refreshes the Live badge / control bar.
      bus.emit('meeting_updated', ended);
      bus.emit('automation_trigger', { trigger: 'meeting_ended', meetingId: id });
      // Generate notes asynchronously.
      services.ai?.generateNoteAsync(id).catch(() => undefined);
    },
    pause: async (id: ID) => {
      await services.deepgram?.pauseForMeeting(id);
      const m = Meetings.get(id);
      if (m) bus.emit('meeting_updated', m);
    },
    /**
     * Re-open an ended meeting so the user can continue capturing into the
     * same note. Honors the single-live invariant: any other live meeting
     * is stopped first. Returns the updated meeting.
     */
    reopen: async (id: ID) => {
      const target = Meetings.get(id);
      if (!target) throw new Error('Meeting not found: ' + id);
      // Stop any other meeting that is currently live.
      const otherLive = Meetings.list().filter((x) => !x.ended_at && x.id !== id);
      for (const old of otherLive) {
        try {
          await services.deepgram?.stopForMeeting(old.id);
        } catch {
          /* ignore */
        }
        const ended = Meetings.update(old.id, { ended_at: new Date().toISOString() });
        bus.emit('meeting_ended', ended);
        bus.emit('meeting_updated', ended);
        bus.emit('automation_trigger', { trigger: 'meeting_ended', meetingId: old.id });
        services.ai?.generateNoteAsync(old.id).catch(() => undefined);
      }
      // Clear ended_at and re-open Deepgram. setting ended_at to null in
      // sqlite-land — Meetings.update accepts the patch directly.
      const reopened = Meetings.update(id, { ended_at: null });
      try {
        await services.deepgram?.startForMeeting(id);
      } catch (err) {
        // Deepgram failed (no key, hard-stop reached) — keep the meeting open
        // anyway so the user can still type raw notes; surface the error.
        bus.emit('notification', {
          kind: 'transcription_started',
          title: 'Resume continued — transcription unavailable',
          body: (err as Error).message,
          meetingId: id,
        });
      }
      bus.emit('meeting_started', reopened);
      bus.emit('meeting_updated', reopened);
      return reopened;
    },
    resume: async (id: ID) => {
      await services.deepgram?.resumeForMeeting(id);
      const m = Meetings.get(id);
      if (m) bus.emit('meeting_updated', m);
    },
    setPrivacy: async (id: ID, mode: any) => {
      const m = Meetings.update(id, { privacy_mode: mode });
      if (mode === 'private') await services.deepgram?.stopForMeeting(id);
      bus.emit('meeting_updated', m);
    },
    deleteLastSeconds: async (id: ID, seconds: number) => {
      const chunks = TranscriptChunks.listByMeeting(id);
      if (!chunks.length) return;
      const last = chunks[chunks.length - 1];
      const cutoff = last.end_time - seconds;
      TranscriptChunks.deleteRange(id, cutoff, last.end_time);
    },
    getRawNotes: (id: ID) => Meetings.get(id)?.raw_notes ?? '',
    setRawNotes: (id: ID, md: string) => {
      const m = Meetings.update(id, { raw_notes: md });
      bus.emit('meeting_updated', m);
    },
  });

  // -------- transcript --------
  registerDomain('transcript', {
    listChunks: (id: ID) => TranscriptChunks.listByMeeting(id),
    highlight: (chunkId: ID, on: boolean) => TranscriptChunks.setHighlighted(chunkId, on),
    delete: (chunkId: ID) => TranscriptChunks.softDelete(chunkId),
    renameSpeaker: (meetingId: ID, speakerId: string, name: string, persist: boolean) => {
      TranscriptChunks.renameSpeaker(meetingId, speakerId, name);
      if (persist) services.deepgram?.persistSpeakerName(speakerId, name);
    },
  });

  // -------- notes --------
  registerDomain('notes', {
    get: (meetingId: ID) => GeneratedNotes.get(meetingId),
    generate: async (meetingId: ID, opts: any) => {
      const note = await services.ai!.generateNote(meetingId, opts);
      bus.emit('note_updated', note);
      return note;
    },
    regenerateSection: async (meetingId: ID, section: string) => {
      const note = await services.ai!.regenerateSection(meetingId, section);
      bus.emit('note_updated', note);
      return note;
    },
    transform: async (meetingId: ID, kind: any) => {
      const note = await services.ai!.transformNote(meetingId, kind);
      bus.emit('note_updated', note);
      return note;
    },
  });

  // -------- action items --------
  registerDomain('actionItems', {
    list: (filter: any) => ActionItems.list(filter),
    update: (id: ID, patch: any) => ActionItems.update(id, patch),
    delete: (id: ID) => ActionItems.delete(id),
    syncTo: async (id: ID, integration: any) => services.actionItemSync?.syncOne(id, integration),
  });

  // -------- people / companies / projects / folders --------
  registerDomain('people', {
    list: () => People.list(),
    get: (id: ID) => People.get(id),
    upsert: (p: any) => People.upsert(p),
    delete: (id: ID) => People.delete(id),
    meetings: (id: ID) => Meetings.list({ person_id: id }),
    buildProfile: async (id: ID) => services.ai?.buildPersonProfile(id) ?? '',
  });
  registerDomain('companies', {
    list: () => Companies.list(),
    get: (id: ID) => Companies.get(id),
    upsert: (c: any) => Companies.upsert(c),
    delete: (id: ID) => Companies.delete(id),
    meetings: (id: ID) => Meetings.list({ company_id: id }),
    buildProfile: async (id: ID) => services.ai?.buildCompanyProfile(id) ?? '',
  });
  registerDomain('projects', {
    list: () => Projects.list(),
    get: (id: ID) => Projects.get(id),
    upsert: (p: any) => Projects.upsert(p),
    delete: (id: ID) => Projects.delete(id),
    meetings: (id: ID) => Meetings.list({ project_id: id }),
  });
  registerDomain('folders', {
    list: () => Folders.list(),
    upsert: (f: any) => Folders.upsert(f),
    delete: (id: ID) => Folders.delete(id),
  });

  // -------- templates --------
  registerDomain('templates', {
    list: () => Templates.list(),
    get: (id: ID) => Templates.get(id),
    upsert: (t: any) => Templates.upsert(t),
    delete: (id: ID) => Templates.delete(id),
    pickForMeeting: (id: ID) => services.templates?.pickForMeeting(id) ?? null,
  });

  // -------- automations --------
  registerDomain('automations', {
    list: () => Automations.list(),
    upsert: (r: any) => Automations.upsert(r),
    delete: (id: ID) => Automations.delete(id),
    runOnce: async (ruleId: ID, meetingId: ID) => services.automations?.runOnce(ruleId, meetingId),
  });

  // -------- chat --------
  registerDomain('chat', {
    threads: () => ChatThreads.list(),
    thread: (id: ID) => ChatThreads.get(id),
    newThread: (scope: ChatScope, title?: string) =>
      ChatThreads.upsert({ title: title ?? defaultThreadTitle(scope), scope, messages: [] }),
    send: async (threadId: ID, message: string) => services.ai!.chatSend(threadId, message),
    delete: (id: ID) => ChatThreads.delete(id),
  });

  // -------- drive --------
  registerDomain('drive', {
    status: () => services.drive?.status() ?? { connected: false },
    connect: async () => services.drive!.connect(),
    disconnect: async () => services.drive!.disconnect(),
    syncMeeting: async (id: ID, formats: any) => services.drive!.syncMeeting(id, formats),
    resyncAll: async () => services.drive!.resyncAll(),
    openInDrive: async (id: ID) => services.drive!.openInDrive(id),
  });

  // -------- gmail --------
  registerDomain('gmail', {
    status: () => services.gmail?.status() ?? { connected: false },
    connect: async () => services.gmail!.connect(),
    draftFollowUp: async (id: ID, kind: any) => services.gmail!.draftFollowUp(id, kind),
  });

  // -------- calendar --------
  registerDomain('calendar', {
    status: () => services.calendar?.status() ?? { connected: false },
    connect: async () => services.calendar!.connect(),
    upcoming: async () => services.calendar!.upcoming(),
    forNow: async () => services.calendar!.forNow(),
    refresh: async () => services.calendar!.refresh(),
  });

  // -------- settings --------
  registerDomain('settings', {
    get: () => getSettings(),
    update: (patch: Partial<Settings>) => {
      const s = saveSettings(patch);
      bus.emit('settings_changed', s);
      return s;
    },
    reset: () => {
      const { DEFAULT_SETTINGS } = require('../db');
      const s = saveSettings(DEFAULT_SETTINGS);
      bus.emit('settings_changed', s);
      return s;
    },
  });

  // -------- integrations --------
  registerDomain('integrations', {
    list: () => Integrations.list(),
    setEnabled: (kind: any, enabled: boolean) => Integrations.setStatus(kind, { enabled }),
    setConfig: (kind: any, config: Record<string, unknown>) =>
      Integrations.setStatus(kind, { config }),
    authorize: async (kind: any) => {
      switch (kind) {
        case 'google_drive':
        case 'google_calendar':
        case 'gmail':
        case 'google_contacts':
        case 'google_tasks':
          return services.googleAuth!.authorize(kind);
        default:
          return { ok: false, error: 'Authorize not yet implemented for ' + kind };
      }
    },
    disconnect: async (kind: any) => {
      switch (kind) {
        case 'google_drive':
        case 'google_calendar':
        case 'gmail':
        case 'google_contacts':
        case 'google_tasks':
          await services.googleAuth?.disconnect();
          return;
        default:
          Integrations.setStatus(kind, { status: 'disconnected', account_email: undefined });
      }
    },
  });

  // -------- search --------
  registerDomain('search', {
    meetings: (q: string, limit: number) => Meetings.search(q, limit ?? 25),
    semantic: async (q: string, scope?: ChatScope) =>
      services.ai?.semanticSearch(q, scope) ?? [],
  });

  // -------- detection --------
  registerDomain('detection', {
    current: () => services.detection?.current() ?? null,
    ignoreOnce: (detected?: any) => services.detection?.ignoreOnce(detected),
    alwaysStartFor: (rule: any) => DetectionRules.alwaysStart.add(rule),
    alwaysIgnore: (rule: any) => DetectionRules.ignore.add(rule),
  });
}

function findMainWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((win) => {
      if (win.isDestroyed()) return false;
      const url = win.webContents.getURL();
      return !url.includes('#/floating') && !url.includes('#/detection-overlay');
    }) ?? null
  );
}

function findDetectionOverlayWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((win) => {
      if (win.isDestroyed()) return false;
      return win.webContents.getURL().includes('#/detection-overlay');
    }) ?? null
  );
}

function defaultThreadTitle(scope: ChatScope): string {
  switch (scope.kind) {
    case 'all': return 'All meetings';
    case 'meeting': return 'Single meeting chat';
    case 'meetings': return `${scope.meeting_ids.length} meetings`;
    case 'person': return 'Person chat';
    case 'company': return 'Company chat';
    case 'project': return 'Project chat';
    case 'folder': return 'Folder chat';
    case 'date_range': return `${scope.from} → ${scope.to}`;
  }
}

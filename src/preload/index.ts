/**
 * Preload bridge. Exposes window.api with the typed IPC surface.
 * Single multiplexed invoke channel + dedicated push channels.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type API } from '@shared/types/ipc';

function invoke<T>(domain: string, method: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(IPC.invoke, { domain, method, args }) as Promise<T>;
}

function makeDomain<T extends object>(name: string, methods: (keyof T)[]): T {
  const out = {} as any;
  for (const m of methods) {
    out[m as string] = (...args: unknown[]) => invoke(name, m as string, ...args);
  }
  return out;
}

const subscribe = <T,>(channel: string, cb: (e: T) => void) => {
  const h = (_e: unknown, p: T) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

const api: API = {
  app: makeDomain('app', ['ready', 'showMainWindow', 'openMeeting', 'showFloatingWidget', 'showCommandPalette', 'dismissDetectionOverlay', 'togglePrivateMode', 'exportAllData', 'deleteAllData', 'getKeyStatus', 'setKey', 'getPermissionStatus', 'openSystemSettings']),
  meetings: makeDomain('meetings', ['list', 'get', 'create', 'update', 'delete', 'move', 'start', 'stop', 'pause', 'resume', 'reopen', 'setPrivacy', 'deleteLastSeconds', 'getRawNotes', 'setRawNotes']),
  transcript: makeDomain('transcript', ['listChunks', 'highlight', 'delete', 'renameSpeaker']),
  notes: makeDomain('notes', ['get', 'generate', 'regenerateSection', 'transform']),
  actionItems: makeDomain('actionItems', ['list', 'update', 'delete', 'syncTo']),
  people: makeDomain('people', ['list', 'get', 'upsert', 'delete', 'meetings', 'buildProfile']),
  companies: makeDomain('companies', ['list', 'get', 'upsert', 'delete', 'meetings', 'buildProfile']),
  projects: makeDomain('projects', ['list', 'get', 'upsert', 'delete', 'meetings']),
  folders: makeDomain('folders', ['list', 'upsert', 'delete']),
  templates: makeDomain('templates', ['list', 'get', 'upsert', 'delete', 'pickForMeeting']),
  automations: makeDomain('automations', ['list', 'upsert', 'delete', 'runOnce']),
  chat: makeDomain('chat', ['threads', 'thread', 'newThread', 'send', 'delete']),
  drive: makeDomain('drive', ['status', 'connect', 'disconnect', 'syncMeeting', 'resyncAll', 'openInDrive']),
  gmail: makeDomain('gmail', ['status', 'connect', 'draftFollowUp']),
  calendar: makeDomain('calendar', ['status', 'connect', 'upcoming', 'forNow', 'refresh']),
  settings: makeDomain('settings', ['get', 'update', 'reset']),
  integrations: makeDomain('integrations', ['list', 'setEnabled', 'setConfig', 'authorize', 'disconnect']),
  search: makeDomain('search', ['meetings', 'semantic']),
  detection: makeDomain('detection', ['current', 'ignoreOnce', 'alwaysStartFor', 'alwaysIgnore']),
  events: {
    onTranscript: (cb) => subscribe(IPC.transcript, cb),
    onMeetingDetected: (cb) => subscribe(IPC.meetingDetected, cb),
    onMeetingUpdated: (cb) => subscribe(IPC.meetingUpdated, cb),
    onNoteUpdated: (cb) => subscribe(IPC.noteUpdated, cb),
    onSyncStatus: (cb) => subscribe(IPC.syncStatus, cb),
    onNotification: (cb) => subscribe(IPC.notification, cb),
    onSettingsChanged: (cb) => subscribe(IPC.settingsChanged, cb),
  },
};

contextBridge.exposeInMainWorld('api', api);

// Expose audio capture helpers — used by renderer to capture mic + display audio
// and stream PCM frames back to main via IPC.
contextBridge.exposeInMainWorld('audio', {
  sendChunk: (meetingId: string, channel: 'mic' | 'system', data: ArrayBuffer) =>
    ipcRenderer.send('pmos:audio:chunk', { meetingId, channel, data: Buffer.from(data) }),
  sendStart: (meetingId: string, channel: 'mic' | 'system', sampleRate: number) =>
    ipcRenderer.send('pmos:audio:start', { meetingId, channel, sampleRate }),
  sendEnd: (meetingId: string, channel: 'mic' | 'system') =>
    ipcRenderer.send('pmos:audio:end', { meetingId, channel }),
});

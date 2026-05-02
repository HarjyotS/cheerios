/**
 * IPC bridge. The renderer calls a single `pmos:invoke` channel with
 * { domain, method, args }; we route to the matching handler. Push streams
 * (transcript, detection, sync, …) go on their own channels.
 *
 * Handlers are registered by services via the `register()` helper below.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/types/ipc';
import { bus } from '../lib/event-bus';
import { log } from '../lib/logger';

const logger = log('ipc');

export type IpcHandler = (...args: any[]) => Promise<unknown> | unknown;

const handlers = new Map<string, IpcHandler>();

export function register(domain: string, method: string, handler: IpcHandler) {
  const key = `${domain}.${method}`;
  if (handlers.has(key)) {
    logger.warn(`Replacing IPC handler ${key}`);
  }
  handlers.set(key, handler);
}

export function registerDomain(domain: string, methods: Record<string, IpcHandler>) {
  for (const [m, fn] of Object.entries(methods)) register(domain, m, fn);
}

export function listMethods() {
  return [...handlers.keys()].sort();
}

export function initIpc() {
  ipcMain.handle(IPC.invoke, async (_evt, payload: { domain: string; method: string; args: any[] }) => {
    const key = `${payload.domain}.${payload.method}`;
    const fn = handlers.get(key);
    if (!fn) {
      logger.warn('Unknown IPC method', { key });
      throw new Error(`Unknown IPC method: ${key}`);
    }
    try {
      return await fn(...(payload.args ?? []));
    } catch (err) {
      logger.error('IPC handler error', { key, err: (err as Error).message });
      throw err;
    }
  });

  // Wire the event bus → renderer push channels.
  bus.on('transcript', (e) => broadcast(IPC.transcript, e));
  bus.on('meeting_detected', (d) => broadcast(IPC.meetingDetected, d));
  bus.on('meeting_updated', (m) => broadcast(IPC.meetingUpdated, m));
  bus.on('note_updated', (n) => broadcast(IPC.noteUpdated, n));
  bus.on('sync_status', (s) => broadcast(IPC.syncStatus, s));
  bus.on('notification', (n) => broadcast(IPC.notification, n));
  bus.on('settings_changed', (s) => broadcast(IPC.settingsChanged, s));
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

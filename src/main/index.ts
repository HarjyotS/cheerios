/**
 * Electron main entry. Boots services, creates windows, wires IPC.
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { cpSync, existsSync } from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { initDb } from './db';
import { initIpc } from './ipc';
import { registerAllHandlers } from './ipc/handlers';
import { bus } from './lib/event-bus';
import { log } from './lib/logger';
import { services } from './lib/service-registry';

import { AudioCaptureService } from './services/audio/audio-capture';
import { DeepgramStreamingService } from './services/deepgram/deepgram-service';
import { MeetingDetectionService } from './services/detection/detection-service';
import { MeetingStateDetector } from './services/detection/meeting-state';
import { AINoteEngine } from './services/ai/note-engine';
import { GoogleAuthManager } from './services/google/auth';
import { DriveSyncService } from './services/drive/drive-service';
import { GmailService } from './services/gmail/gmail-service';
import { CalendarService } from './services/calendar/calendar-service';
import { AutomationsEngine } from './services/automations/engine';
import { TemplatesService } from './services/templates/templates-service';
import { LocalApiServer } from './services/api/local-api';
import { McpServer } from './services/mcp/mcp-server';
import { NotificationsService } from './services/notifications/notifications';
import { ActionItemSyncService } from './services/action-items/sync';
import { RetentionService } from './services/retention/retention';
import { AppLockService } from './services/security/app-lock';
import { Privacy } from './services/privacy/privacy-service';
import { installDisplayMediaHandler } from './services/audio/display-media';

// Loopback system-audio on macOS 13+ goes through ScreenCaptureKit. We let
// Electron pick its defaults — disabling the picker breaks audio capture.

const logger = log('main');

let mainWindow: BrowserWindow | null = null;
let floatingWindow: BrowserWindow | null = null;
let detectionOverlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

app.setName('Cherios');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return mainWindow;
}

function migrateLegacyUserData(): void {
  const current = app.getPath('userData');
  const legacy = join(app.getPath('appData'), 'Personal Meeting OS');
  if (current === legacy || existsSync(current) || !existsSync(legacy)) return;
  try {
    cpSync(legacy, current, { recursive: true });
  } catch (err) {
    logger.warn('legacy userData migration failed', { err: String(err) });
  }
}

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    return floatingWindow;
  }
  floatingWindow = new BrowserWindow({
    width: 360,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const url = is.dev && process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/#/floating`
    : `file://${join(__dirname, '../renderer/index.html')}#/floating`;
  floatingWindow.loadURL(url);
  floatingWindow.on('ready-to-show', () => floatingWindow?.show());
  return floatingWindow;
}

function createDetectionOverlayWindow() {
  if (detectionOverlayWindow && !detectionOverlayWindow.isDestroyed()) {
    return detectionOverlayWindow;
  }

  detectionOverlayWindow = new BrowserWindow({
    width: 468,
    height: 78,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: false,
    title: 'Meeting detected',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  detectionOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  detectionOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const url = is.dev && process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/#/detection-overlay`
    : `file://${join(__dirname, '../renderer/index.html')}#/detection-overlay`;
  detectionOverlayWindow.loadURL(url);
  detectionOverlayWindow.on('closed', () => {
    detectionOverlayWindow = null;
  });
  return detectionOverlayWindow;
}

function positionDetectionOverlay(win: BrowserWindow) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  const [winWidth] = win.getSize();
  win.setPosition(x + width - winWidth - 18, y + 18, false);
}

function showDetectionOverlay() {
  const win = createDetectionOverlayWindow();
  positionDetectionOverlay(win);
  if (win.webContents.isLoading()) {
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      positionDetectionOverlay(win);
      win.showInactive();
    });
    return;
  }
  win.showInactive();
}

function hideDetectionOverlay() {
  if (detectionOverlayWindow && !detectionOverlayWindow.isDestroyed()) {
    detectionOverlayWindow.hide();
  }
}

function createTray() {
  // Use a 1x1 placeholder if no icon is shipped — the tray still works.
  const img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setTitle('🎙');
  refreshTrayMenu();
  bus.on('settings_changed', refreshTrayMenu);
  bus.on('meeting_started', refreshTrayMenu);
  bus.on('meeting_ended', refreshTrayMenu);
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Start Quick Note', click: () => mainWindow?.webContents.send('pmos:cmd:new_quick_note') },
    { label: 'Pause Transcription', click: () => bus.emit('notification', { kind: 'tray', title: 'Pause requested' }) },
    { label: 'Stop Transcription', click: () => bus.emit('notification', { kind: 'tray', title: 'Stop requested' }) },
    { type: 'separator' },
    { label: 'Open Current Meeting', click: () => mainWindow?.show() },
    { label: 'Open Recent Notes', click: () => mainWindow?.show() },
    { label: 'Open Action Items', click: () => mainWindow?.webContents.send('pmos:cmd:show_actions') },
    { label: 'Search All Notes', click: () => mainWindow?.webContents.send('pmos:cmd:search') },
    { type: 'separator' },
    { label: 'Toggle Private Mode', click: () => bus.emit('notification', { kind: 'tray', title: 'Private mode toggled' }) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function registerGlobalShortcuts() {
  // Spec §27 keyboard shortcuts. They forward to the renderer as commands.
  const send = (cmd: string) => () => mainWindow?.webContents.send(`pmos:cmd:${cmd}`);
  globalShortcut.register('Cmd+Shift+N', send('new_quick_note'));
  globalShortcut.register('Cmd+Shift+S', send('toggle_transcription'));
  globalShortcut.register('Cmd+Shift+P', send('pause_transcription'));
  globalShortcut.register('Cmd+Shift+A', send('add_action_item'));
  globalShortcut.register('Cmd+Shift+D', send('add_decision'));
  globalShortcut.register('Cmd+Shift+Q', send('add_quote'));
  globalShortcut.register('Cmd+Shift+F', send('search'));
  globalShortcut.register('Cmd+Shift+M', () => createFloatingWindow());
  globalShortcut.register('Cmd+Shift+Space', send('command_palette'));
  globalShortcut.register('Cmd+Shift+Backspace', send('delete_last_60s'));
}

async function bootServices() {
  services.audio = new AudioCaptureService();
  services.deepgram = new DeepgramStreamingService();
  services.googleAuth = new GoogleAuthManager();
  services.calendar = new CalendarService(services.googleAuth);
  services.drive = new DriveSyncService(services.googleAuth);
  services.gmail = new GmailService(services.googleAuth);
  services.detection = new MeetingDetectionService(services.calendar);
  services.meetingState = new MeetingStateDetector();
  services.ai = new AINoteEngine();
  services.templates = new TemplatesService();
  services.automations = new AutomationsEngine();
  services.actionItemSync = new ActionItemSyncService();
  services.retention = new RetentionService();
  services.notifications = new NotificationsService();
  services.appLock = new AppLockService();
  services.privacy = Privacy;
  services.localApi = new LocalApiServer();
  services.mcp = new McpServer();

  // Wire IPC audio plumbing (renderer captures audio with WebAudio and forwards
  // PCM chunks to main, where we tee into the active Deepgram stream).
  ipcMain.on('pmos:audio:start', (_e, p) => services.audio?.handleStart(p));
  ipcMain.on('pmos:audio:chunk', (_e, p) => services.audio?.handleChunk(p));
  ipcMain.on('pmos:audio:end', (_e, p) => services.audio?.handleEnd(p));

  // Start background services.
  await Promise.allSettled([
    services.detection?.start(),
    services.calendar?.start(),
    services.automations?.start(),
    services.notifications?.start(),
    services.retention?.start(),
    services.appLock?.start(),
    services.localApi?.start(),
    services.mcp?.start(),
  ]);
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.harjyot.cherios');
  app.on('browser-window-created', (_e, w) => optimizer.watchWindowShortcuts(w));

  migrateLegacyUserData();
  initDb();
  initIpc();
  registerAllHandlers();
  installDisplayMediaHandler();
  bus.on('meeting_detected', (d) => {
    if (!d) {
      hideDetectionOverlay();
      return;
    }
    logger.info('Meeting detected', { confidence: d.confidence, app: d.source_app });
    showDetectionOverlay();
  });

  await bootServices();

  createMainWindow();
  createTray();
  registerGlobalShortcuts();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

export { mainWindow, floatingWindow, detectionOverlayWindow };

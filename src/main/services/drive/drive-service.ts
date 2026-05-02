/**
 * Drive sync service.
 *
 * Spec §12. Each sync writes one Google Doc (always — that's the human-
 * readable view) plus any extra formats the user has asked for: markdown,
 * pdf, txt, json. Folder layout is governed by the folder strategy
 * (see folder-resolver). Folder ids for Companies/Projects are cached
 * back into the relevant DB rows so we don't re-list Drive on every sync.
 *
 * All errors are caught and reflected back via Meetings.update(drive_sync_status)
 * + bus.emit('sync_status', …). Privacy-flagged meetings are refused.
 */

import { shell } from 'electron';
import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import type { DriveExportFormat, ID, Meeting, Person, Project, Company } from '@shared/types/entities';
import type { GoogleAuthManager } from '../google/auth';
import {
  Meetings,
  GeneratedNotes,
  TranscriptChunks,
  People,
  Projects,
  Companies,
  Folders,
} from '@main/db/repositories';
import { getSettings } from '@main/db/index';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { renderMeetingMarkdown } from './markdown-renderer';
import {
  resolveFolderPath,
  ROOT_FOLDER,
  type FolderStrategy,
} from './folder-resolver';
import { uploadAsGoogleDoc } from './doc-formatter';

const logger = log('drive');

export class DriveSyncService {
  /**
   * folder-id cache keyed by full path string. Drive doesn't have a path
   * lookup so we walk the tree manually; caching keeps repeat syncs cheap.
   */
  private folderCache = new Map<string, string>();
  private syncQueue: Array<{ id: ID; formats?: DriveExportFormat[] }> = [];
  private syncing = false;

  constructor(private auth: GoogleAuthManager) {}

  status(): { connected: boolean; account?: string } {
    return { connected: this.auth.isConnected(), account: this.auth.account() };
  }

  async connect(): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    return this.auth.authorize('google_drive');
  }

  async disconnect(): Promise<void> {
    this.folderCache.clear();
    return this.auth.disconnect();
  }

  /**
   * Sync a single meeting. Honors privacy flags. Always writes a Google
   * Doc; additional formats follow the `formats` arg or settings default.
   */
  async syncMeeting(id: ID, formats?: DriveExportFormat[]): Promise<void> {
    const meeting = Meetings.get(id);
    if (!meeting) throw new Error('Meeting not found: ' + id);

    if (meeting.privacy_mode === 'private' || meeting.privacy_mode === 'local_only') {
      logger.info('refusing to sync private meeting', { id, privacy: meeting.privacy_mode });
      Meetings.update(id, { drive_sync_status: 'not_synced' });
      bus.emit('sync_status', { meetingId: id, status: 'skipped', error: 'private' });
      return;
    }

    const drive = await this.getDrive();
    if (!drive) {
      Meetings.update(id, { drive_sync_status: 'failed' });
      bus.emit('sync_status', { meetingId: id, status: 'failed', error: 'not connected' });
      throw new Error('Google Drive not connected');
    }

    Meetings.update(id, { drive_sync_status: 'syncing' });
    bus.emit('sync_status', { meetingId: id, status: 'syncing' });

    try {
      const settings = getSettings();
      const wantFormats = new Set<DriveExportFormat>(formats ?? settings.drive_export_formats ?? ['google_doc', 'markdown']);
      // Google Doc is mandatory — it's the human-readable view.
      wantFormats.add('google_doc');

      const note = GeneratedNotes.get(id);
      const chunks = TranscriptChunks.listByMeeting(id);
      const attendees = meeting.attendees.map((pid) => People.get(pid)).filter((x): x is Person => Boolean(x));
      const projects = meeting.project_ids.map((p) => Projects.get(p)).filter((x): x is Project => Boolean(x));
      const companies = meeting.company_ids.map((c) => Companies.get(c)).filter((x): x is Company => Boolean(x));

      // Resolve folder
      const strategy = (settings.drive_folder_strategy ?? 'hybrid') as FolderStrategy;
      const path = resolveFolderPath(strategy, { meeting, attendees, projects, companies });
      if (!path) {
        Meetings.update(id, { drive_sync_status: 'not_synced' });
        bus.emit('sync_status', { meetingId: id, status: 'skipped', error: 'private' });
        return;
      }

      const folderId = await this.ensureFolderPath(drive, path);

      // Cache folder id back onto Project / Company rows so the rest of
      // the app can deep-link to them.
      if (path[1] === 'Projects' && projects[0]) {
        if (projects[0].drive_folder_id !== folderId) Projects.upsert({ ...projects[0], drive_folder_id: folderId });
      } else if (path[1] === 'Companies' && companies[0]) {
        if (companies[0].drive_folder_id !== folderId) Companies.upsert({ ...companies[0], drive_folder_id: folderId });
      } else if (path[1] === 'People') {
        // People don't have a drive_folder_id column; we use the folders table.
        const f = Folders.upsert({ name: path[path.length - 1], drive_folder_id: folderId });
        void f;
      }

      // Build markdown once — reused for the .md export and as the source
      // for HTML conversion to Google Doc.
      const markdown = renderMeetingMarkdown({
        meeting,
        note,
        chunks,
        attendees,
        description: undefined,
      });

      const baseName = sanitizeFileName(`${formatDateForFile(meeting.started_at)} - ${meeting.title || 'Meeting'}`);
      const fileIds = { ...(meeting.drive_file_ids ?? {}) };

      // 1. Google Doc — always
      if (wantFormats.has('google_doc')) {
        const r = await uploadAsGoogleDoc({
          drive,
          name: baseName,
          parentFolderId: folderId,
          markdown,
          existingFileId: fileIds.google_doc,
        });
        fileIds.google_doc = r.fileId;
      }

      // 2. Markdown
      if (wantFormats.has('markdown')) {
        fileIds.markdown = await this.uploadOrUpdate(drive, {
          name: `${baseName}.md`,
          parentFolderId: folderId,
          mimeType: 'text/markdown',
          body: Buffer.from(markdown, 'utf-8'),
          existingFileId: fileIds.markdown,
        });
      }

      // 3. PDF — export the Google Doc that we just created/updated.
      if (wantFormats.has('pdf') && fileIds.google_doc) {
        const pdfBuf = await this.exportDocAsPdf(drive, fileIds.google_doc);
        fileIds.pdf = await this.uploadOrUpdate(drive, {
          name: `${baseName}.pdf`,
          parentFolderId: folderId,
          mimeType: 'application/pdf',
          body: pdfBuf,
          existingFileId: fileIds.pdf,
        });
      }

      // 4. JSON — structured payload, useful for power users.
      if (wantFormats.has('json')) {
        const json = JSON.stringify({ meeting, note, chunks }, null, 2);
        fileIds.json = await this.uploadOrUpdate(drive, {
          name: `${baseName}.json`,
          parentFolderId: folderId,
          mimeType: 'application/json',
          body: Buffer.from(json, 'utf-8'),
          existingFileId: fileIds.json,
        });
      }

      // 5. TXT — transcript only, ASCII-friendly.
      if (wantFormats.has('txt')) {
        const txt = chunks
          .filter((c) => c.is_final && !c.is_deleted)
          .map((c) => `[${formatSec(c.start_time)}] ${c.speaker_name ?? c.speaker_id ?? 'Speaker'}: ${c.text}`)
          .join('\n');
        fileIds.txt = await this.uploadOrUpdate(drive, {
          name: `${baseName}.txt`,
          parentFolderId: folderId,
          mimeType: 'text/plain',
          body: Buffer.from(txt, 'utf-8'),
          existingFileId: fileIds.txt,
        });
      }

      Meetings.update(id, {
        drive_sync_status: 'synced',
        drive_file_ids: fileIds,
      });
      bus.emit('sync_status', { meetingId: id, status: 'synced' });
      logger.info('synced', { id, folder: path.join('/'), files: Object.keys(fileIds) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('sync failed', { id, error: msg });
      Meetings.update(id, { drive_sync_status: 'failed' });
      bus.emit('sync_status', { meetingId: id, status: 'failed', error: msg });
      throw err;
    }
  }

  /**
   * Queue every non-synced meeting for re-sync. Runs in the background;
   * caller just gets the queue depth.
   */
  async resyncAll(): Promise<{ queued: number }> {
    const all = Meetings.list();
    const pending = all.filter((m) => m.drive_sync_status !== 'synced' && m.privacy_mode === 'normal');
    for (const m of pending) this.syncQueue.push({ id: m.id });
    void this.drainQueue();
    return { queued: pending.length };
  }

  async openInDrive(id: ID): Promise<void> {
    const m = Meetings.get(id);
    if (!m?.drive_file_ids?.google_doc) return;
    await shell.openExternal(`https://docs.google.com/document/d/${m.drive_file_ids.google_doc}/edit`);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async getDrive(): Promise<drive_v3.Drive | null> {
    const auth = await this.auth.getOAuth2Client();
    if (!auth) return null;
    return google.drive({ version: 'v3', auth });
  }

  private async drainQueue(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      while (this.syncQueue.length) {
        const next = this.syncQueue.shift()!;
        try { await this.syncMeeting(next.id, next.formats); } catch (e) { logger.warn('queue item failed', { id: next.id, error: String(e) }); }
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Walk a path top-down, creating folders where needed. Returns the id
   * of the deepest folder.
   */
  private async ensureFolderPath(drive: drive_v3.Drive, path: string[]): Promise<string> {
    let parent = 'root';
    let runningPath = '';
    for (const seg of path) {
      runningPath += '/' + seg;
      const cached = this.folderCache.get(runningPath);
      if (cached) {
        parent = cached;
        continue;
      }
      const id = await this.findOrCreateFolder(drive, seg, parent);
      this.folderCache.set(runningPath, id);
      parent = id;
    }
    return parent;
  }

  private async findOrCreateFolder(drive: drive_v3.Drive, name: string, parentId: string): Promise<string> {
    // Look for an existing folder with this name under the parent. We
    // scope the query to non-trashed folders only.
    const escaped = name.replace(/'/g, "\\'");
    const q = `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
    const list = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive' });
    if (list.data.files && list.data.files.length > 0 && list.data.files[0].id) {
      return list.data.files[0].id;
    }
    // Create — when parentId is 'root' we leave parents off so the folder
    // lands at the user's My Drive root.
    const requestBody: drive_v3.Schema$File = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentId !== 'root') requestBody.parents = [parentId];
    else requestBody.parents = ['root'];
    const created = await drive.files.create({ requestBody, fields: 'id' });
    if (!created.data.id) throw new Error(`Failed to create folder ${name}`);
    return created.data.id;
  }

  private async uploadOrUpdate(
    drive: drive_v3.Drive,
    args: {
      name: string;
      parentFolderId: string;
      mimeType: string;
      body: Buffer;
      existingFileId?: string;
    },
  ): Promise<string> {
    const stream = Readable.from(args.body);
    if (args.existingFileId) {
      const r = await drive.files.update({
        fileId: args.existingFileId,
        requestBody: { name: args.name },
        media: { mimeType: args.mimeType, body: stream },
        fields: 'id',
      });
      return r.data.id ?? args.existingFileId;
    }
    const r = await drive.files.create({
      requestBody: { name: args.name, parents: [args.parentFolderId] },
      media: { mimeType: args.mimeType, body: stream },
      fields: 'id',
    });
    if (!r.data.id) throw new Error(`Upload failed for ${args.name}`);
    return r.data.id;
  }

  private async exportDocAsPdf(drive: drive_v3.Drive, docId: string): Promise<Buffer> {
    const res = await drive.files.export(
      { fileId: docId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' },
    );
    // googleapis returns the raw body as the requested type; cast cleanly.
    return Buffer.from(res.data as ArrayBuffer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFileName(s: string): string {
  // Drive accepts almost anything in a filename, but we strip control chars
  // and trim long names so they don't blow past 255 bytes.
  const cleaned = s.replace(/[ -]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 200) || 'Meeting';
}

function formatDateForFile(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// Re-export ROOT_FOLDER so callers can reference the canonical name.
export { ROOT_FOLDER };

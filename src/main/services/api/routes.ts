/**
 * Local HTTP API routes (Express). Mounted by `LocalApiServer` once the
 * bearer-auth middleware has cleared the request. All read endpoints
 * delegate straight to the repositories; write/AI endpoints fan out
 * through the service registry.
 *
 * Spec §21.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  Meetings,
  TranscriptChunks,
  GeneratedNotes,
  ActionItems,
  People,
  Companies,
  Projects,
  ChatThreads,
} from '@main/db/repositories';
import { services } from '@main/lib/service-registry';
import { log } from '@main/lib/logger';
import type { ChatScope, GeneratedNote, Meeting, TranscriptChunk } from '@shared/types/entities';

const logger = log('local-api');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asyncRoute(
  handler: (req: Request, res: Response) => unknown | Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    try {
      const out = await handler(req, res);
      if (!res.headersSent) {
        if (out === undefined) res.status(204).end();
        else res.json(out);
      }
    } catch (err) {
      logger.error('route handler failed', { path: req.path, error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', message: String((err as Error).message ?? err) });
      }
    }
  };
}

function bad(res: Response, msg: string, code = 400): void {
  res.status(code).json({ error: 'bad_request', message: msg });
}

function pickStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return undefined;
}

function paramId(req: Request): string {
  const v = req.params.id;
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

// ---------------------------------------------------------------------------
// Markdown / JSON export helpers
// ---------------------------------------------------------------------------

function exportMarkdown(meeting: Meeting, note: GeneratedNote | null, chunks: TranscriptChunk[]): string {
  const lines: string[] = [];
  lines.push(`# ${meeting.title}`);
  lines.push('');
  lines.push(`*${meeting.started_at}${meeting.ended_at ? ' → ' + meeting.ended_at : ''}*`);
  lines.push('');
  if (note?.summary) {
    lines.push('## Summary');
    lines.push(note.summary);
    lines.push('');
  }
  for (const section of note?.sections ?? []) {
    lines.push(`## ${section.heading}`);
    lines.push(section.body);
    lines.push('');
  }
  if ((note?.action_items?.length ?? 0) > 0) {
    lines.push('## Action items');
    for (const a of note!.action_items) {
      const due = a.due_date ? ` (due ${a.due_date})` : '';
      const owner = a.owner ?? 'me';
      lines.push(`- [ ] ${a.task} — ${owner}${due}`);
    }
    lines.push('');
  }
  if ((note?.decisions?.length ?? 0) > 0) {
    lines.push('## Decisions');
    for (const d of note!.decisions) lines.push(`- ${d.text}`);
    lines.push('');
  }
  if (chunks.length) {
    lines.push('## Transcript');
    for (const c of chunks) {
      const speaker = c.speaker_name || c.speaker_id || 'Speaker';
      lines.push(`**${speaker}** (${c.start_time.toFixed(1)}s): ${c.text}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function buildApiRouter(): Router {
  const r = Router();

  // ---- Meetings ----------------------------------------------------------
  r.get(
    '/meetings',
    asyncRoute((req) => {
      const { from, to, project_id, person_id, company_id } = req.query;
      return Meetings.list({
        from: pickStr(from),
        to: pickStr(to),
        project_id: pickStr(project_id),
        person_id: pickStr(person_id),
        company_id: pickStr(company_id),
      });
    }),
  );

  r.get(
    '/meetings/:id',
    asyncRoute((req, res) => {
      const id = paramId(req);
      const m = Meetings.get(id);
      if (!m) return bad(res, 'meeting not found', 404);
      return m;
    }),
  );

  r.get(
    '/meetings/:id/transcript',
    asyncRoute((req, res) => {
      const id = paramId(req);
      const m = Meetings.get(id);
      if (!m) return bad(res, 'meeting not found', 404);
      return TranscriptChunks.listByMeeting(id);
    }),
  );

  r.get(
    '/meetings/:id/summary',
    asyncRoute((req, res) => {
      const id = paramId(req);
      const m = Meetings.get(id);
      if (!m) return bad(res, 'meeting not found', 404);
      return GeneratedNotes.get(id);
    }),
  );

  // ---- Entities ----------------------------------------------------------
  r.get('/people', asyncRoute(() => People.list()));
  r.get('/companies', asyncRoute(() => Companies.list()));
  r.get('/projects', asyncRoute(() => Projects.list()));

  // ---- Action items ------------------------------------------------------
  r.get(
    '/action-items',
    asyncRoute((req) => {
      const { status, person_id, company_id, project_id, due_before } = req.query;
      return ActionItems.list({
        status: pickStr(status),
        person_id: pickStr(person_id),
        company_id: pickStr(company_id),
        project_id: pickStr(project_id),
        due_before: pickStr(due_before),
      });
    }),
  );

  // ---- Search ------------------------------------------------------------
  r.post(
    '/search',
    asyncRoute((req, res) => {
      const { q, limit } = (req.body ?? {}) as { q?: string; limit?: number };
      if (!q || typeof q !== 'string') return bad(res, '`q` is required');
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 25;
      return Meetings.search(q, lim);
    }),
  );

  // ---- Chat --------------------------------------------------------------
  r.post(
    '/chat',
    asyncRoute(async (req, res) => {
      if (!services.ai) return bad(res, 'ai service unavailable', 503);
      const body = (req.body ?? {}) as {
        threadId?: string;
        scope?: ChatScope;
        message?: string;
      };
      if (!body.message || typeof body.message !== 'string') {
        return bad(res, '`message` is required');
      }
      let threadId = body.threadId;
      if (!threadId) {
        const scope: ChatScope = body.scope ?? { kind: 'all' };
        const t = ChatThreads.upsert({ title: 'API thread', scope, messages: [] });
        threadId = t.id;
      }
      const updated = await services.ai.chatSend(threadId, body.message);
      return { threadId, thread: updated };
    }),
  );

  // ---- Export ------------------------------------------------------------
  r.post(
    '/export',
    asyncRoute((req, res) => {
      const { meetingId, format } = (req.body ?? {}) as {
        meetingId?: string;
        format?: 'markdown' | 'json';
      };
      if (!meetingId) return bad(res, '`meetingId` is required');
      if (format !== 'markdown' && format !== 'json') {
        return bad(res, "`format` must be 'markdown' or 'json'");
      }
      const meeting = Meetings.get(meetingId);
      if (!meeting) return bad(res, 'meeting not found', 404);
      const note = GeneratedNotes.get(meetingId);
      const chunks = TranscriptChunks.listByMeeting(meetingId);
      if (format === 'json') {
        return { meeting, note, transcript: chunks };
      }
      const md = exportMarkdown(meeting, note, chunks);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
      return undefined;
    }),
  );

  // ---- Health ------------------------------------------------------------
  r.get('/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  return r;
}

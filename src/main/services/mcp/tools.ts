/**
 * MCP tool definitions. The tools are registered against either the
 * in-process HTTP+SSE server (see `mcp-server.ts`) or the standalone
 * stdio launcher (see `stdio-launcher.ts`).
 *
 * Most tools call straight into the repositories. AI-flavored tools
 * (`summarize_meetings`, `draft_followup`) fan out through the service
 * registry. Per-tool privacy gates from spec §21:
 *   - `mcp_disable_transcript_access` blocks `get_transcript`.
 *   - `mcp_disable_private_notes` filters out meetings whose
 *     `privacy_mode === 'private'` from list/search results.
 *
 * To register the stdio launcher with Claude Desktop, add the following
 * to `~/Library/Application Support/Claude/claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "cherios": {
 *         "command": "node",
 *         "args": ["/path/to/cherios/out/main/services/mcp/stdio-launcher.js"],
 *         "env": {
 *           "PMOS_LOCAL_API_URL": "http://127.0.0.1:47823",
 *           "PMOS_LOCAL_API_TOKEN": "<token printed at app start>"
 *         }
 *       }
 *     }
 *   }
 */
import { z } from 'zod';
import {
  Meetings,
  TranscriptChunks,
  ActionItems,
  People,
  Companies,
  Projects,
  ChatThreads,
} from '@main/db/repositories';
import { getSettings } from '@main/db';
import { services } from '@main/lib/service-registry';
import type { Meeting, ChatScope } from '@shared/types/entities';

// ---------------------------------------------------------------------------
// Privacy filters
// ---------------------------------------------------------------------------

function filterPrivacy<T extends { privacy_mode?: string }>(items: T[]): T[] {
  if (!getSettings().mcp_disable_private_notes) return items;
  return items.filter((m) => m.privacy_mode !== 'private');
}

function isHidden(m: Meeting | null | undefined): boolean {
  if (!m) return true;
  if (!getSettings().mcp_disable_private_notes) return false;
  return m.privacy_mode === 'private';
}

// ---------------------------------------------------------------------------
// Tool schema definitions (zod) — also serve as JSON-schema for clients.
// ---------------------------------------------------------------------------

export const ToolSchemas = {
  search_meetings: {
    q: z.string().min(1).describe('Free-text query, FTS5 syntax allowed.'),
    limit: z.number().int().positive().max(100).optional(),
  },
  get_meeting: {
    id: z.string().describe('Meeting ID (mtg_*).'),
  },
  get_transcript: {
    id: z.string().describe('Meeting ID (mtg_*).'),
  },
  get_action_items: {
    status: z.enum(['open', 'in_progress', 'done', 'archived']).optional(),
    person: z.string().optional().describe('Owner person ID.'),
    company: z.string().optional().describe('Company ID.'),
  },
  search_person: {
    name: z.string().min(1),
  },
  search_company: {
    name: z.string().min(1),
  },
  search_project: {
    name: z.string().min(1),
  },
  summarize_meetings: {
    meetingIds: z.array(z.string()).min(1),
    prompt: z.string().optional(),
  },
  draft_followup: {
    meetingId: z.string(),
    kind: z
      .enum([
        'thank_you',
        'sales',
        'investor',
        'research',
        'recruiting',
        'recap',
        'intro',
      ])
      .optional(),
  },
} as const;

// ---------------------------------------------------------------------------
// Tool handlers — pure functions over repos / services. Returning a JSON
// object is fine; the dispatcher in mcp-server.ts wraps it as MCP content.
// ---------------------------------------------------------------------------

export const ToolHandlers = {
  async search_meetings(args: { q: string; limit?: number }) {
    const lim = args.limit ?? 25;
    const hits = Meetings.search(args.q, Math.min(lim, 100));
    const filtered = getSettings().mcp_disable_private_notes
      ? hits.filter((h) => h.meeting.privacy_mode !== 'private')
      : hits;
    return filtered.map((h) => ({
      id: h.meeting.id,
      title: h.meeting.title,
      started_at: h.meeting.started_at,
      snippet: h.snippet,
    }));
  },

  async get_meeting(args: { id: string }) {
    const m = Meetings.get(args.id);
    if (isHidden(m)) return { error: 'not_found_or_private' };
    return m;
  },

  async get_transcript(args: { id: string }) {
    if (getSettings().mcp_disable_transcript_access) {
      return { error: 'Disabled by user' };
    }
    const m = Meetings.get(args.id);
    if (isHidden(m)) return { error: 'not_found_or_private' };
    return TranscriptChunks.listByMeeting(args.id);
  },

  async get_action_items(args: {
    status?: string;
    person?: string;
    company?: string;
  }) {
    return ActionItems.list({
      status: args.status,
      person_id: args.person,
      company_id: args.company,
    });
  },

  async search_person(args: { name: string }) {
    const needle = args.name.toLowerCase();
    return People.list().filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.email ?? '').toLowerCase().includes(needle),
    );
  },

  async search_company(args: { name: string }) {
    const needle = args.name.toLowerCase();
    return Companies.list().filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        (c.domain ?? '').toLowerCase().includes(needle),
    );
  },

  async search_project(args: { name: string }) {
    const needle = args.name.toLowerCase();
    return Projects.list().filter((p) => p.name.toLowerCase().includes(needle));
  },

  async summarize_meetings(args: { meetingIds: string[]; prompt?: string }) {
    if (!services.ai) return { error: 'ai_unavailable' };
    // Filter out private meetings up front so we never feed them to the AI
    // when the privacy gate is on.
    const allowed = args.meetingIds.filter((id) => {
      const m = Meetings.get(id);
      return m && !isHidden(m);
    });
    if (allowed.length === 0) return { error: 'no_accessible_meetings' };
    const scope: ChatScope = { kind: 'meetings', meeting_ids: allowed };
    const thread = ChatThreads.upsert({
      title: 'MCP summary',
      scope,
      messages: [],
    });
    const updated = await services.ai.chatSend(
      thread.id,
      args.prompt ?? 'Summarize these meetings as a concise digest.',
    );
    return { threadId: thread.id, thread: updated };
  },

  async draft_followup(args: { meetingId: string; kind?: string }) {
    if (!services.gmail) return { error: 'gmail_unavailable' };
    const m = Meetings.get(args.meetingId);
    if (isHidden(m)) return { error: 'not_found_or_private' };
    const kind = (args.kind ?? 'recap') as
      | 'thank_you'
      | 'sales'
      | 'investor'
      | 'research'
      | 'recruiting'
      | 'recap'
      | 'intro';
    return services.gmail.draftFollowUp(args.meetingId, kind);
  },
} as const;

export type ToolName = keyof typeof ToolHandlers;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  search_meetings: 'Full-text search across meeting titles, raw notes, and summaries.',
  get_meeting: 'Fetch a single meeting by id, including attendees and metadata.',
  get_transcript: 'Fetch transcript chunks for a meeting (gated by mcp_disable_transcript_access).',
  get_action_items: 'List action items, optionally filtered by status/person/company.',
  search_person: 'Find people by name or email substring.',
  search_company: 'Find companies by name or domain substring.',
  search_project: 'Find projects by name substring.',
  summarize_meetings:
    'Run an AI summary across one or more meetings, optionally guided by a custom prompt.',
  draft_followup:
    'Draft a Gmail follow-up email for a meeting (thank_you / sales / investor / research / recruiting / recap / intro).',
};

// Re-export filter helper for tests / sibling modules.
export { filterPrivacy };

/**
 * Standalone MCP stdio launcher. Designed to be invoked by Claude
 * Desktop (or any other MCP host that speaks stdio) as a child
 * process. It does NOT touch the local SQLite database directly —
 * instead, it proxies tool calls to the running Electron app over the
 * loopback HTTP API. That keeps a single source of truth and lets the
 * desktop app's privacy gates apply uniformly.
 *
 * Configuration via env vars:
 *   PMOS_LOCAL_API_URL    e.g. http://127.0.0.1:47823 (default)
 *   PMOS_LOCAL_API_TOKEN  bearer token printed at app start
 *
 * Register with Claude Desktop in
 * `~/Library/Application Support/Claude/claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "cherios": {
 *         "command": "node",
 *         "args": ["/path/to/cherios/out/main/services/mcp/stdio-launcher.js"],
 *         "env": {
 *           "PMOS_LOCAL_API_URL": "http://127.0.0.1:47823",
 *           "PMOS_LOCAL_API_TOKEN": "<token>"
 *         }
 *       }
 *     }
 *   }
 *
 * This file is intentionally dependency-light: only `@modelcontextprotocol/sdk`
 * and `zod`. It uses the Node 18+ global `fetch`, so no extra HTTP client.
 */
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process.env.PMOS_LOCAL_API_URL ?? 'http://127.0.0.1:47823').replace(/\/+$/, '');
const TOKEN = process.env.PMOS_LOCAL_API_TOKEN ?? '';

if (!TOKEN) {
  // Stay alive but every tool will return an error — this lets the host
  // surface a useful message instead of a hard crash.
  // eslint-disable-next-line no-console
  console.error('[pmos-mcp] PMOS_LOCAL_API_TOKEN is not set; tool calls will fail.');
}

interface ApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | undefined>;
}

async function api(path: string, opts: ApiOptions = {}): Promise<unknown> {
  const qs = opts.query
    ? '?' +
      Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const url = `${BASE_URL}${path}${qs}`;
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function wrap(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function main() {
  const sdk = new SdkMcpServer(
    { name: 'cherios-stdio', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Cast through `any` so we tolerate SDK shape drift across versions.
  const reg = (sdk as unknown as {
    tool: (
      name: string,
      desc: string,
      shape: Record<string, z.ZodTypeAny>,
      cb: (args: any) => Promise<any>,
    ) => void;
  }).tool.bind(sdk);

  reg(
    'search_meetings',
    'Full-text search across meeting titles, raw notes, and summaries.',
    { q: z.string().min(1), limit: z.number().int().positive().max(100).optional() },
    async (a) => wrap(await api('/search', { method: 'POST', body: { q: a.q, limit: a.limit } })),
  );

  reg(
    'get_meeting',
    'Fetch a single meeting by id.',
    { id: z.string() },
    async (a) => wrap(await api(`/meetings/${encodeURIComponent(a.id)}`)),
  );

  reg(
    'get_transcript',
    'Fetch transcript chunks for a meeting (gated by mcp_disable_transcript_access).',
    { id: z.string() },
    async (a) => wrap(await api(`/meetings/${encodeURIComponent(a.id)}/transcript`)),
  );

  reg(
    'get_action_items',
    'List action items, optionally filtered.',
    {
      status: z.enum(['open', 'in_progress', 'done', 'archived']).optional(),
      person: z.string().optional(),
      company: z.string().optional(),
    },
    async (a) =>
      wrap(
        await api('/action-items', {
          query: { status: a.status, person_id: a.person, company_id: a.company },
        }),
      ),
  );

  reg(
    'search_person',
    'Find people by name or email substring.',
    { name: z.string().min(1) },
    async (a) => {
      const all = (await api('/people')) as Array<{ name: string; email?: string }>;
      const needle = a.name.toLowerCase();
      return wrap(
        all.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            (p.email ?? '').toLowerCase().includes(needle),
        ),
      );
    },
  );

  reg(
    'search_company',
    'Find companies by name or domain substring.',
    { name: z.string().min(1) },
    async (a) => {
      const all = (await api('/companies')) as Array<{ name: string; domain?: string }>;
      const needle = a.name.toLowerCase();
      return wrap(
        all.filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.domain ?? '').toLowerCase().includes(needle),
        ),
      );
    },
  );

  reg(
    'search_project',
    'Find projects by name substring.',
    { name: z.string().min(1) },
    async (a) => {
      const all = (await api('/projects')) as Array<{ name: string }>;
      const needle = a.name.toLowerCase();
      return wrap(all.filter((p) => p.name.toLowerCase().includes(needle)));
    },
  );

  reg(
    'summarize_meetings',
    'Run an AI summary across one or more meetings.',
    { meetingIds: z.array(z.string()).min(1), prompt: z.string().optional() },
    async (a) =>
      wrap(
        await api('/chat', {
          method: 'POST',
          body: {
            scope: { kind: 'meetings', meeting_ids: a.meetingIds },
            message: a.prompt ?? 'Summarize these meetings as a concise digest.',
          },
        }),
      ),
  );

  // Drafting follow-ups isn't exposed on the local API today; surface a
  // clear message so the host shows something actionable. (The
  // in-process MCP server has direct access via the service registry.)
  reg(
    'draft_followup',
    'Draft a Gmail follow-up (only available via the in-process MCP server).',
    {
      meetingId: z.string(),
      kind: z
        .enum(['thank_you', 'sales', 'investor', 'research', 'recruiting', 'recap', 'intro'])
        .optional(),
    },
    async () =>
      wrap({
        error:
          'draft_followup is only available via the in-process MCP server (HTTP+SSE). Configure that endpoint to use this tool.',
      }),
  );

  const transport = new StdioServerTransport();
  await sdk.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pmos-mcp] fatal:', err);
  process.exit(1);
});

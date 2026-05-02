/**
 * In-process MCP server (HTTP + SSE transport). Spec §21.
 *
 * Exposes the same tools as the stdio launcher but speaks the SSE
 * transport so the SDK's `connect(transport)` lifecycle is reused. The
 * server listens on `127.0.0.1:<local_api_port + 1>` (default 47824)
 * with a separate bearer token from the local HTTP API
 * (`SECRET_KEYS.mcpToken`).
 *
 * The server is reactive to `bus.on('settings_changed')`: flipping
 * `mcp_enabled` starts/stops it without an app restart. It is safe to
 * call `start()` and `stop()` multiple times — both are idempotent.
 */
import express, { type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { ensureToken, bearerAuth } from '../api/auth';
import { SECRET_KEYS } from '@main/lib/secrets';
import {
  ToolSchemas,
  ToolHandlers,
  TOOL_DESCRIPTIONS,
  type ToolName,
} from './tools';
import type { Settings } from '@shared/types/entities';

const logger = log('mcp');
const HOST = '127.0.0.1';

/**
 * Wrap a tool handler so its return value is shaped as an MCP
 * `CallToolResult`. The SDK is strict about the response shape — text
 * content with the JSON-stringified payload is the safest default.
 */
function wrapToolResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export class McpServer {
  private app: Express | null = null;
  private http: HttpServer | null = null;
  private sdk: SdkMcpServer | null = null;
  private transport: SSEServerTransport | null = null;
  private running = false;
  private starting = false;
  private boundPort = 0;
  private token: string | null = null;
  private settingsListener: ((s: Settings) => void) | null = null;

  async start(): Promise<void> {
    if (!this.settingsListener) {
      this.settingsListener = (s: Settings) => {
        void this.applySettings(s);
      };
      bus.on('settings_changed', this.settingsListener);
    }
    await this.applySettings(getSettings());
  }

  async stop(): Promise<void> {
    if (this.settingsListener) {
      bus.off('settings_changed', this.settingsListener);
      this.settingsListener = null;
    }
    await this.shutdown();
  }

  isRunning(): boolean {
    return this.running;
  }

  port(): number {
    return this.boundPort;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async applySettings(s: Settings): Promise<void> {
    const desired = !!s.mcp_enabled;
    const desiredPort = (s.local_api_port || 47823) + 1;
    if (desired && (!this.running || this.boundPort !== desiredPort)) {
      if (this.running) await this.shutdown();
      await this.boot(desiredPort);
    } else if (!desired && this.running) {
      await this.shutdown();
    }
  }

  private buildSdkServer(): SdkMcpServer {
    const sdk = new SdkMcpServer(
      { name: 'cherios', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    // Register every tool. The SDK's `tool(name, schema, cb)` overload
    // accepts a Zod raw shape (i.e. a plain object of zod types).
    const register = <K extends ToolName>(name: K) => {
      const schema = ToolSchemas[name] as Record<string, z.ZodTypeAny>;
      const handler = ToolHandlers[name] as (args: unknown) => Promise<unknown>;
      // The SDK types are noisy across major versions; cast through `any`
      // at the registration boundary, but keep the handler typed.
      (sdk as unknown as {
        tool: (
          n: string,
          desc: string,
          shape: Record<string, z.ZodTypeAny>,
          cb: (args: unknown) => Promise<unknown>,
        ) => void;
      }).tool(
        name,
        TOOL_DESCRIPTIONS[name],
        schema,
        async (args: unknown) => {
          try {
            const result = await handler(args ?? {});
            return wrapToolResult(result);
          } catch (err) {
            logger.error('tool failed', { name, error: String(err) });
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Tool ${name} failed: ${(err as Error).message ?? String(err)}`,
                },
              ],
            };
          }
        },
      );
    };

    (Object.keys(ToolHandlers) as ToolName[]).forEach(register);
    return sdk;
  }

  private async boot(port: number): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      this.token = await ensureToken(SECRET_KEYS.mcpToken);

      const app = express();
      app.disable('x-powered-by');
      // No body-parser for /messages — the SDK's transport reads the raw
      // body itself. JSON parsing is fine for everything else.
      app.use((req, res, next) => {
        if (req.path === '/messages') return next();
        return express.json({ limit: '2mb' })(req, res, next);
      });

      app.use((req, res, next) => {
        const host = (req.headers.host ?? '').split(':')[0];
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
          res.status(403).json({ error: 'forbidden_host' });
          return;
        }
        next();
      });

      app.use(bearerAuth(() => this.token));

      // Build the SDK server up front. We support a single concurrent
      // session — sufficient for a personal desktop tool. New SSE
      // connections replace the prior one.
      this.sdk = this.buildSdkServer();

      app.get('/sse', async (_req, res) => {
        try {
          // Tear down any prior session before opening a new one.
          await this.closeTransport();
          const transport = new SSEServerTransport('/messages', res);
          this.transport = transport;
          if (!this.sdk) this.sdk = this.buildSdkServer();
          await this.sdk.connect(transport);
        } catch (err) {
          logger.error('sse connect failed', { error: String(err) });
          if (!res.headersSent) res.status(500).end();
        }
      });

      app.post('/messages', async (req, res) => {
        const t = this.transport;
        if (!t) {
          res.status(409).json({ error: 'no_active_session' });
          return;
        }
        try {
          await t.handlePostMessage(req, res);
        } catch (err) {
          logger.error('message handling failed', { error: String(err) });
          if (!res.headersSent) res.status(500).end();
        }
      });

      app.get('/health', (_req, res) => {
        res.json({ ok: true, ts: new Date().toISOString() });
      });

      app.use((_req, res) => {
        res.status(404).json({ error: 'not_found' });
      });

      this.app = app;
      this.http = await new Promise<HttpServer>((resolve, reject) => {
        const srv = app.listen(port, HOST, () => resolve(srv));
        srv.once('error', reject);
      });
      this.boundPort = port;
      this.running = true;
      logger.info(`MCP server listening on http://${HOST}:${port}/sse`);
      logger.info(`MCP token: ${this.token} (key: ${SECRET_KEYS.mcpToken})`);
    } catch (err) {
      logger.error('failed to start', { error: String(err) });
      this.running = false;
      this.app = null;
      this.http = null;
      this.sdk = null;
    } finally {
      this.starting = false;
    }
  }

  private async closeTransport(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    if (!t) return;
    try {
      await t.close();
    } catch {
      // best effort
    }
  }

  private async shutdown(): Promise<void> {
    await this.closeTransport();
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) {
      try {
        await sdk.close();
      } catch {
        // best effort
      }
    }
    const srv = this.http;
    this.http = null;
    this.app = null;
    this.running = false;
    this.boundPort = 0;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
    logger.info('MCP server stopped');
  }
}

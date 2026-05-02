/**
 * Local HTTP API server. Spec §21.
 *
 * Listens on `127.0.0.1` only (loopback) — never on `0.0.0.0`. Off by
 * default; toggled via `settings.local_api_enabled`. Bearer auth with
 * a token persisted in the OS keychain (`SECRET_KEYS.localApiToken`).
 *
 * The server lifecycle is reactive: a single subscription to
 * `bus.on('settings_changed')` flips it on/off when the user toggles
 * the setting in the UI.
 */
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { ensureToken, bearerAuth } from './auth';
import { SECRET_KEYS } from '@main/lib/secrets';
import { buildApiRouter } from './routes';
import type { Settings } from '@shared/types/entities';

const logger = log('local-api');
const HOST = '127.0.0.1';

export class LocalApiServer {
  private app: Express | null = null;
  private server: Server | null = null;
  private running = false;
  private starting = false;
  private boundPort = 0;
  private token: string | null = null;
  private settingsListener: ((s: Settings) => void) | null = null;

  /**
   * Wire up the settings subscription and start if currently enabled.
   * Idempotent — safe to call repeatedly.
   */
  async start(): Promise<void> {
    if (!this.settingsListener) {
      this.settingsListener = (s: Settings) => {
        // Fire and forget — errors are logged by start/stop.
        void this.applySettings(s);
      };
      bus.on('settings_changed', this.settingsListener);
    }
    await this.applySettings(getSettings());
  }

  /**
   * Stop the server and remove the settings listener.
   */
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
    const desired = !!s.local_api_enabled;
    const desiredPort = s.local_api_port || 47823;
    if (desired && (!this.running || this.boundPort !== desiredPort)) {
      if (this.running) await this.shutdown();
      await this.boot(desiredPort);
    } else if (!desired && this.running) {
      await this.shutdown();
    }
  }

  private async boot(port: number): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      this.token = await ensureToken(SECRET_KEYS.localApiToken);

      const app = express();
      app.disable('x-powered-by');
      app.use(express.json({ limit: '2mb' }));

      // Reject any request whose Host header isn't loopback. Defense in
      // depth against DNS rebinding even though we're already bound to
      // 127.0.0.1.
      app.use((req, res, next) => {
        const host = (req.headers.host ?? '').split(':')[0];
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
          res.status(403).json({ error: 'forbidden_host' });
          return;
        }
        next();
      });

      app.use(bearerAuth(() => this.token));
      app.use('/', buildApiRouter());

      // Generic 404 — keeps responses JSON.
      app.use((_req, res) => {
        res.status(404).json({ error: 'not_found' });
      });

      this.app = app;
      this.server = await new Promise<Server>((resolve, reject) => {
        const srv = app.listen(port, HOST, () => resolve(srv));
        srv.once('error', reject);
      });
      this.boundPort = port;
      this.running = true;
      // One-off log line per spec — visible in dev console / log file.
      logger.info(`Local API listening on http://${HOST}:${port}`);
      logger.info(`Local API token: ${this.token} (key: ${SECRET_KEYS.localApiToken})`);
    } catch (err) {
      logger.error('failed to start', { error: String(err) });
      this.running = false;
      this.app = null;
      this.server = null;
    } finally {
      this.starting = false;
    }
  }

  private async shutdown(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.app = null;
    this.running = false;
    this.boundPort = 0;
    if (!srv) return;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
    logger.info('Local API stopped');
  }
}

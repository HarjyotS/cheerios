/**
 * Google OAuth manager.
 *
 * Implements the OAuth 2.0 Installed App flow against Google's accounts
 * server. Tokens are persisted via secrets.ts; the account email is stored
 * on the relevant Integration rows so the rest of the app can render
 * "Connected as harjyot@…".
 *
 * Flow:
 *   1. authorize() boots a temporary loopback HTTP server on a free port
 *      and opens the user's default browser to Google's consent screen.
 *   2. Google redirects back to http://127.0.0.1:<port>/callback?code=…&state=…
 *      The state is checked against a one-shot value to prevent CSRF.
 *   3. The code is exchanged for refresh + access tokens via google-auth-library.
 *   4. We fetch the userinfo email so each Integration row can display it.
 *   5. Tokens go into the keychain; integration rows get marked 'connected'.
 *
 * getOAuth2Client() always returns a client whose access token is fresh —
 * if the cached access token is missing or expired we refresh using the
 * stored refresh token. The library handles refresh internally once
 * setCredentials() is called with a refresh_token.
 */

import { shell } from 'electron';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Integration } from '@shared/types/entities';
import { getSecret, setSecret, deleteSecret, SECRET_KEYS } from '@main/lib/secrets';
import { Integrations } from '@main/db/repositories';
import { log } from '@main/lib/logger';

const logger = log('google-auth');

// All scopes we ever request. We always ask for the union so a single
// OAuth round-trip wires every google integration. The user can still
// disable individual integrations afterward.
const ALL_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/tasks',
  'openid',
  'email',
  'profile',
] as const;

// Integration kinds covered by a single Google account.
const GOOGLE_INTEGRATION_KINDS: Integration['kind'][] = [
  'google_drive',
  'google_calendar',
  'gmail',
  'google_contacts',
  'google_tasks',
];

// Two minutes — generous enough for a slow user, short enough to not leak
// a server forever.
const AUTH_TIMEOUT_MS = 120_000;

interface CachedTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number; // ms epoch
}

export class GoogleAuthManager {
  private cachedClient: OAuth2Client | null = null;
  private cachedEmail: string | undefined;
  private inflight: Promise<{ ok: true; account: string } | { ok: false; error: string }> | null = null;

  /**
   * Kick off the OAuth flow for one of the Google-backed integrations. If
   * tokens are already on disk we just verify them and short-circuit.
   * Concurrent calls share the same in-flight promise so multiple "Connect"
   * buttons can't race.
   */
  async authorize(kind: Integration['kind']): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runAuthorize(kind).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runAuthorize(kind: Integration['kind']): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    // Already connected? Just stamp the integration row and bail out.
    const existingRefresh = await getSecret(SECRET_KEYS.googleRefreshToken);
    const existingEmail = await getSecret(SECRET_KEYS.googleAccountEmail);
    if (existingRefresh && existingEmail) {
      this.cachedEmail = existingEmail;
      this.markIntegrationConnected(kind, existingEmail);
      return { ok: true, account: existingEmail };
    }

    const clientId = await getSecret(SECRET_KEYS.googleClientId);
    const clientSecret = await getSecret(SECRET_KEYS.googleClientSecret);
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        error: 'Set google.client_id and google.client_secret in the keychain. See README for OAuth setup.',
      };
    }

    const serverRef: { current: Server | null } = { current: null };
    try {
      const { code, redirectUri } = await this.runCallbackServer(clientId, (s) => { serverRef.current = s; });
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const { tokens } = await oauth2.getToken(code);

      if (!tokens.refresh_token) {
        // Without prompt=consent Google won't return a refresh_token on
        // re-auth. Tell the user to revoke and try again.
        return {
          ok: false,
          error: 'No refresh token received. Revoke this app at myaccount.google.com/permissions and reconnect.',
        };
      }

      oauth2.setCredentials(tokens);

      // Pull email so the UI can show "Connected as …".
      const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
      const userInfo = await oauth2Api.userinfo.get();
      const email = userInfo.data.email ?? 'unknown@google';

      await setSecret(SECRET_KEYS.googleRefreshToken, tokens.refresh_token);
      if (tokens.access_token) await setSecret(SECRET_KEYS.googleAccessToken, tokens.access_token);
      await setSecret(SECRET_KEYS.googleAccountEmail, email);

      // Cache the authorized client for the rest of the session.
      this.cachedClient = oauth2;
      this.cachedEmail = email;

      // Mark every Google integration as connected — a single OAuth grant
      // covers the entire suite.
      for (const k of GOOGLE_INTEGRATION_KINDS) {
        try { this.markIntegrationConnected(k, email); } catch (e) { logger.warn('integration not registered', { kind: k, error: String(e) }); }
      }

      logger.info('oauth complete', { email });
      return { ok: true, account: email };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('oauth failed', { error: msg });
      return { ok: false, error: msg };
    } finally {
      try { serverRef.current?.close(); } catch { /* noop */ }
    }
  }

  /**
   * Stand up a one-shot HTTP server on a free loopback port, build the
   * Google consent URL, open the browser, and resolve when the redirect
   * arrives (or reject on timeout).
   */
  private runCallbackServer(
    clientId: string,
    onServer: (s: Server) => void,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = randomBytes(16).toString('hex');
      let redirectUri = '';
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => reject(new Error('OAuth timed out — no callback received within 2 minutes')));
      }, AUTH_TIMEOUT_MS);
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (!req.url) {
          res.writeHead(400).end('bad request');
          return;
        }
        if (!req.url.startsWith('/callback')) {
          // Browsers love to ask for /favicon.ico — drop it.
          res.writeHead(404).end('not found');
          return;
        }
        const u = new URL(req.url, 'http://127.0.0.1');
        const gotState = u.searchParams.get('state');
        const gotCode = u.searchParams.get('code');
        const gotErr = u.searchParams.get('error');

        if (gotErr) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(htmlPage('Authorization failed', gotErr));
          finish(() => reject(new Error('Google denied authorization: ' + gotErr)));
          return;
        }
        if (!gotState || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(htmlPage('Authorization failed', 'state mismatch'));
          finish(() => reject(new Error('OAuth state mismatch')));
          return;
        }
        if (!gotCode) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(htmlPage('Authorization failed', 'missing code'));
          finish(() => reject(new Error('OAuth code missing')));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          htmlPage('You can close this tab', 'Cherios is now connected to your Google account.'),
        );
        finish(() => resolve({ code: gotCode, redirectUri }));
      });

      server.on('error', (err) => finish(() => reject(err)));
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        redirectUri = `http://127.0.0.1:${addr.port}/callback`;

        const oauth2 = new google.auth.OAuth2(clientId, '', redirectUri);
        const url = oauth2.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent', // force refresh_token return
          scope: [...ALL_SCOPES],
          state,
        });
        onServer(server);
        shell.openExternal(url).catch((e) => logger.warn('shell.openExternal failed', { error: String(e) }));
      });
    });
  }

  /**
   * Returns a configured OAuth2Client whose access token is current. If
   * we don't have a refresh token, returns null.
   */
  async getOAuth2Client(): Promise<OAuth2Client | null> {
    if (this.cachedClient) {
      // google-auth-library refreshes automatically on API calls when
      // the access token is stale, but we proactively check.
      try {
        const t = await this.cachedClient.getAccessToken();
        if (t.token) return this.cachedClient;
      } catch (e) {
        logger.warn('cached client invalid; rebuilding', { error: String(e) });
        this.cachedClient = null;
      }
    }

    const clientId = await getSecret(SECRET_KEYS.googleClientId);
    const clientSecret = await getSecret(SECRET_KEYS.googleClientSecret);
    const refreshToken = await getSecret(SECRET_KEYS.googleRefreshToken);
    if (!clientId || !clientSecret || !refreshToken) return null;

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    const cached: CachedTokens = {
      refresh_token: refreshToken,
      access_token: (await getSecret(SECRET_KEYS.googleAccessToken)) ?? undefined,
    };
    oauth2.setCredentials(cached);

    // Persist refreshed access tokens whenever the library rotates them.
    oauth2.on('tokens', (t) => {
      if (t.access_token) setSecret(SECRET_KEYS.googleAccessToken, t.access_token).catch(() => { /* noop */ });
      if (t.refresh_token) setSecret(SECRET_KEYS.googleRefreshToken, t.refresh_token).catch(() => { /* noop */ });
    });

    this.cachedClient = oauth2;
    return oauth2;
  }

  async getAccessToken(): Promise<string | null> {
    const client = await this.getOAuth2Client();
    if (!client) return null;
    try {
      const t = await client.getAccessToken();
      return t.token ?? null;
    } catch {
      return null;
    }
  }

  isConnected(): boolean {
    // We rely on a synchronous check — getSecret is async, but the
    // common case is "we cached the email at startup". If callers need
    // a stronger check they should `await getAccessToken()`.
    return Boolean(this.cachedEmail);
  }

  account(): string | undefined {
    return this.cachedEmail;
  }

  /** Hydrate cached email at app start so isConnected() works synchronously. */
  async hydrate(): Promise<void> {
    const email = await getSecret(SECRET_KEYS.googleAccountEmail);
    if (email) this.cachedEmail = email;
  }

  async disconnect(): Promise<void> {
    try {
      const client = await this.getOAuth2Client();
      if (client) {
        try { await client.revokeCredentials(); } catch (e) { logger.warn('revoke failed', { error: String(e) }); }
      }
    } finally {
      await deleteSecret(SECRET_KEYS.googleRefreshToken);
      await deleteSecret(SECRET_KEYS.googleAccessToken);
      await deleteSecret(SECRET_KEYS.googleAccountEmail);
      this.cachedClient = null;
      this.cachedEmail = undefined;
      for (const kind of GOOGLE_INTEGRATION_KINDS) {
        try {
          Integrations.setStatus(kind, { status: 'disconnected', account_email: undefined, error_message: null });
        } catch { /* row missing — ignore */ }
      }
    }
  }

  private markIntegrationConnected(kind: Integration['kind'], email: string) {
    Integrations.setStatus(kind, {
      status: 'connected',
      enabled: true,
      account_email: email,
      error_message: null,
    });
  }
}

function htmlPage(title: string, body: string): string {
  // Plain, dependency-free HTML. The user only sees this for a second.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px -apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d10;color:#e7e9ee}
.card{padding:24px 28px;background:#13161b;border:1px solid #1f2329;border-radius:12px;max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#9aa3af}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Secret storage. Tries macOS Keychain via keytar; falls back to a simple
 * encrypted file under userData if keytar isn't available (e.g. on first
 * boot before native deps are rebuilt).
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const SERVICE = 'cherios';
const LEGACY_SERVICE = 'personal-meeting-os';

let keytarMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  keytarMod = require('keytar');
} catch {
  keytarMod = null;
}

function fallbackPath(): string {
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'secrets.bin');
}

function readFallback(): Record<string, string> {
  const p = fallbackPath();
  if (!existsSync(p)) return {};
  try {
    const buf = readFileSync(p);
    if (safeStorage.isEncryptionAvailable()) {
      const txt = safeStorage.decryptString(buf);
      return JSON.parse(txt) as Record<string, string>;
    } else {
      return JSON.parse(buf.toString('utf-8')) as Record<string, string>;
    }
  } catch {
    return {};
  }
}

function writeFallback(map: Record<string, string>) {
  const p = fallbackPath();
  const txt = JSON.stringify(map);
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(p, safeStorage.encryptString(txt));
  } else {
    writeFileSync(p, txt, 'utf-8');
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (keytarMod) {
    try {
      await keytarMod.setPassword(SERVICE, key, value);
      return;
    } catch {
      // fall through
    }
  }
  const map = readFallback();
  map[key] = value;
  writeFallback(map);
}

export async function getSecret(key: string): Promise<string | null> {
  if (keytarMod) {
    try {
      return (await keytarMod.getPassword(SERVICE, key)) ?? (await keytarMod.getPassword(LEGACY_SERVICE, key)) ?? null;
    } catch {
      // fall through
    }
  }
  const map = readFallback();
  return map[key] ?? null;
}

export async function deleteSecret(key: string): Promise<void> {
  if (keytarMod) {
    try {
      await keytarMod.deletePassword(SERVICE, key);
      await keytarMod.deletePassword(LEGACY_SERVICE, key).catch(() => undefined);
      return;
    } catch {
      // fall through
    }
  }
  const map = readFallback();
  delete map[key];
  writeFallback(map);
}

export const SECRET_KEYS = {
  deepgramApiKey: 'deepgram.api_key',
  openaiApiKey: 'openai.api_key',
  googleClientId: 'google.client_id',
  googleClientSecret: 'google.client_secret',
  googleRefreshToken: 'google.refresh_token',
  googleAccessToken: 'google.access_token',
  googleAccountEmail: 'google.account_email',
  slackToken: 'slack.token',
  notionToken: 'notion.token',
  linearToken: 'linear.token',
  todoistToken: 'todoist.token',
  asanaToken: 'asana.token',
  webhookSecrets: 'webhook.secrets', // json
  localApiToken: 'localapi.token',
  mcpToken: 'mcp.token',
  appLockHash: 'applock.hash',
} as const;

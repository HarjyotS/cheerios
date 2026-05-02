/**
 * Webhook poster — small POST helper using the global fetch.
 *
 * If a per-URL secret is configured under SECRET_KEYS.webhookSecrets (a JSON
 * object keyed by webhook URL), the helper signs the body with HMAC-SHA256
 * and includes it as `X-PMOS-Signature: sha256=<hex>` and a millisecond
 * timestamp as `X-PMOS-Timestamp` so the receiver can guard against replays.
 */
import { createHmac } from 'node:crypto';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { log } from '@main/lib/logger';

const logger = log('automations:webhook');

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

let secretsCache: Record<string, string> | null = null;
let secretsCacheLoadedAt = 0;
const SECRETS_TTL_MS = 30_000;

async function getWebhookSecrets(): Promise<Record<string, string>> {
  const now = Date.now();
  if (secretsCache && now - secretsCacheLoadedAt < SECRETS_TTL_MS) return secretsCache;
  try {
    const raw = await getSecret(SECRET_KEYS.webhookSecrets);
    secretsCache = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch (err) {
    logger.warn('failed to read webhook secrets', { err: String(err) });
    secretsCache = {};
  }
  secretsCacheLoadedAt = now;
  return secretsCache;
}

/**
 * Invalidate the in-process secrets cache. Call after rotating the key.
 */
export function invalidateWebhookSecretsCache(): void {
  secretsCache = null;
  secretsCacheLoadedAt = 0;
}

export async function post(url: string, body: unknown): Promise<WebhookResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  const payload = JSON.stringify(body ?? {});
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'pmos-automations/1.0',
  };

  const secrets = await getWebhookSecrets();
  const secret = secrets[url];
  if (secret) {
    const ts = Date.now().toString();
    const signature = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    headers['X-PMOS-Timestamp'] = ts;
    headers['X-PMOS-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: payload });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('webhook returned non-2xx', { url, status: res.status, body: text.slice(0, 200) });
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    logger.error('webhook POST failed', { url, err: String(err) });
    return { ok: false, error: String(err) };
  }
}

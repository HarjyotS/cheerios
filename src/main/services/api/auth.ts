/**
 * Bearer-token authentication middleware for the local HTTP API and the
 * MCP HTTP+SSE transport. The expected token is generated on first start
 * and stored in the OS keychain (see `secrets.ts`).
 *
 * Spec §21 — every request to either server must carry a valid
 * `Authorization: Bearer <token>` header. Missing/invalid → 401.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getSecret, setSecret, SECRET_KEYS } from '@main/lib/secrets';

type SecretKey =
  | typeof SECRET_KEYS.localApiToken
  | typeof SECRET_KEYS.mcpToken;

/**
 * Read the token from the keychain. If absent, generate a fresh one and
 * persist it. Returns the token string.
 *
 * Tokens are 32 bytes of crypto-random hex (256 bits of entropy).
 */
export async function ensureToken(key: SecretKey): Promise<string> {
  const existing = await getSecret(key);
  if (existing && existing.length >= 32) return existing;
  const fresh = randomBytes(32).toString('hex');
  await setSecret(key, fresh);
  return fresh;
}

/**
 * Constant-time string compare. Avoids leaking the secret via timing
 * side channels. Returns false on length mismatch.
 */
export function safeEq(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Express middleware factory. The token is read lazily through `getToken`
 * so that callers can swap it out (e.g. on settings reset) without
 * rebuilding the middleware chain.
 */
export function bearerAuth(getToken: () => string | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = getToken();
    if (!expected) {
      res.status(503).json({ error: 'auth_unavailable' });
      return;
    }
    const header = req.header('authorization') || req.header('Authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    const presented = header.slice(7).trim();
    if (!safeEq(presented, expected)) {
      res.status(401).json({ error: 'invalid_bearer_token' });
      return;
    }
    next();
  };
}

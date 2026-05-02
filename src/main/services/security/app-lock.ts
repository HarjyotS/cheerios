/**
 * App Lock service (spec §23). Locks the app behind Touch ID (preferred)
 * or a PIN/passphrase fallback after a configurable inactivity window.
 *
 * Storage: the PIN is never stored in the clear. We hash it via scrypt
 * into a string of the form `scrypt$<saltHex>$<derivedHex>` and persist
 * it in the keychain (or encrypted fallback) under SECRET_KEYS.appLockHash.
 *
 * Locking model:
 *   - Lock decision is purely in-memory. We expose isLocked() and emit
 *     `lock` / `unlock` events on the bus so the renderer can mount a
 *     fullscreen overlay.
 *   - We auto-lock after `settings.app_lock_inactivity_minutes` of the
 *     main window being blurred. The timer resets on focus.
 *   - We also auto-lock on system suspend (powerMonitor) and screen lock.
 */
import { app, BrowserWindow, powerMonitor, systemPreferences } from 'electron';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import { getSecret, setSecret, deleteSecret, SECRET_KEYS } from '@main/lib/secrets';
import { TouchId } from './touch-id';

const logger = log('app-lock');

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

function deriveScrypt(pin: string, salt: Buffer, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(pin.normalize('NFKC'), salt, keyLen, { N: SCRYPT_N }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await deriveScrypt(pin, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  try {
    const derived = await deriveScrypt(pin, salt, expected.length);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch (err) {
    logger.warn('scrypt verify failed', { err: String(err) });
    return false;
  }
}

export interface UnlockResult {
  ok: boolean;
  reason?: 'wrong_pin' | 'no_pin_set' | 'disabled' | 'rate_limited';
}

export class AppLockService {
  private locked = false;
  private inactivityTimer: NodeJS.Timeout | null = null;
  private lastBlurAt: number | null = null;
  private failedAttempts = 0;
  private rateLimitedUntil = 0;
  private started = false;

  // Event handlers we keep references to so stop() can detach them.
  private readonly onBlur = () => this.handleBlur();
  private readonly onFocus = () => this.handleFocus();
  private readonly onSuspend = () => this.lock('system_suspend');
  private readonly onScreenLock = () => this.lock('screen_locked');

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    app.on('browser-window-blur', this.onBlur);
    app.on('browser-window-focus', this.onFocus);
    powerMonitor.on('suspend', this.onSuspend);
    try {
      // 'lock-screen' is macOS/Windows only; safe to attach unconditionally.
      powerMonitor.on('lock-screen' as never, this.onScreenLock);
    } catch {
      // ignore on platforms that don't expose it
    }

    // If the app starts with locking enabled and a PIN configured, lock
    // immediately so the user authenticates before seeing notes.
    const settings = getSettings();
    if (settings.app_lock_enabled && (await this.isConfigured())) {
      this.lock('startup');
    }

    logger.info('AppLock started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    app.off('browser-window-blur', this.onBlur);
    app.off('browser-window-focus', this.onFocus);
    powerMonitor.off('suspend', this.onSuspend);
    try {
      powerMonitor.off('lock-screen' as never, this.onScreenLock);
    } catch {
      // ignore
    }
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** Has the user configured a PIN at all? */
  async isConfigured(): Promise<boolean> {
    const stored = await getSecret(SECRET_KEYS.appLockHash);
    return Boolean(stored);
  }

  /** Set or replace the PIN. Existing PIN is overwritten unconditionally. */
  async setPin(newPin: string): Promise<void> {
    if (!newPin || newPin.length < 4) {
      throw new Error('PIN must be at least 4 characters.');
    }
    const hash = await hashPin(newPin);
    await setSecret(SECRET_KEYS.appLockHash, hash);
    logger.info('App lock PIN updated');
  }

  /** Clear the PIN entirely (also disables the lock). */
  async clearPin(): Promise<void> {
    await deleteSecret(SECRET_KEYS.appLockHash);
    this.markUnlocked();
  }

  /**
   * Attempt to unlock with a PIN.
   * Includes a small exponential-ish backoff after repeated failures
   * to mitigate trivial brute force on a stolen device.
   */
  async unlockWithPin(input: string): Promise<UnlockResult> {
    if (!getSettings().app_lock_enabled) {
      this.markUnlocked();
      return { ok: true, reason: 'disabled' };
    }
    if (Date.now() < this.rateLimitedUntil) {
      return { ok: false, reason: 'rate_limited' };
    }
    const stored = await getSecret(SECRET_KEYS.appLockHash);
    if (!stored) return { ok: false, reason: 'no_pin_set' };
    const ok = await verifyPin(input, stored);
    if (ok) {
      this.failedAttempts = 0;
      this.markUnlocked();
      return { ok: true };
    }
    this.failedAttempts += 1;
    if (this.failedAttempts >= 5) {
      // 30s cool-down after 5 wrong tries; doubles for each subsequent batch.
      const cooldownMs = 30_000 * Math.pow(2, Math.floor((this.failedAttempts - 5) / 5));
      this.rateLimitedUntil = Date.now() + cooldownMs;
      logger.warn('App lock rate-limited', { cooldownMs });
    }
    return { ok: false, reason: 'wrong_pin' };
  }

  /** Try Touch ID; resolves true if authentication succeeded. */
  async unlockWithTouchId(reason = 'Unlock Cherios'): Promise<boolean> {
    if (!getSettings().app_lock_enabled) {
      this.markUnlocked();
      return true;
    }
    const ok = await TouchId.prompt(reason);
    if (ok) {
      this.failedAttempts = 0;
      this.markUnlocked();
    }
    return ok;
  }

  /**
   * Generic entrypoint used by the IPC handler. With no input, simply
   * clears the locked flag (assumes prior auth, e.g. Touch ID success).
   * With a string input, treats it as a PIN.
   */
  async unlock(input?: string): Promise<UnlockResult | boolean> {
    if (input === undefined) {
      this.markUnlocked();
      return true;
    }
    return this.unlockWithPin(input);
  }

  private markUnlocked(): void {
    if (!this.locked) return;
    this.locked = false;
    // We piggyback on the 'notification' bus channel — the renderer
    // listens for kind:'unlock' to dismiss the lock overlay. Same
    // pattern used by lock() below for the inverse.
    bus.emit('notification', { kind: 'unlock', title: 'App unlocked' });
  }

  /** Force-lock immediately. Reason is logged for diagnostics. */
  lock(reason: string = 'manual'): void {
    if (this.locked) return;
    if (!getSettings().app_lock_enabled) return;
    this.locked = true;
    logger.info('App locked', { reason });
    bus.emit('notification', { kind: 'lock', title: 'App locked', body: reason });
  }

  // -------------------------------------------------------------------
  // Inactivity tracking
  // -------------------------------------------------------------------
  private handleBlur(): void {
    if (!getSettings().app_lock_enabled) return;
    this.lastBlurAt = Date.now();
    this.scheduleInactivityLock();
  }

  private handleFocus(): void {
    this.lastBlurAt = null;
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private scheduleInactivityLock(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    const minutes = Math.max(0, getSettings().app_lock_inactivity_minutes ?? 15);
    if (minutes <= 0) return;
    const ms = minutes * 60_000;
    this.inactivityTimer = setTimeout(() => {
      // Only lock if we're still blurred — a focus event will have
      // cleared the timer otherwise.
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused) this.lock('inactivity');
    }, ms);
  }

  /**
   * Surface for the IPC layer / renderer: "is Touch ID even an option?"
   * Used to render the right unlock UI.
   */
  touchIdAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      return Boolean(
        (systemPreferences as unknown as { canPromptTouchID?: () => boolean })
          .canPromptTouchID?.()
      );
    } catch {
      return false;
    }
  }
}

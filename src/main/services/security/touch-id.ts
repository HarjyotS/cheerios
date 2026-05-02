/**
 * Touch ID — best-effort wrapper over Electron's `systemPreferences` API.
 * On macOS we try the native biometric prompt; on every other OS, or
 * when the API is unavailable (e.g. Touch ID not enrolled), we report
 * unsupported and the caller falls back to the PIN flow.
 *
 * We deliberately don't add a native module dependency for this. The
 * Electron-provided path is good enough for a personal tool.
 */
import { systemPreferences } from 'electron';
import { log } from '@main/lib/logger';

const logger = log('touch-id');

export const TouchId = {
  /**
   * Whether macOS will accept a Touch ID prompt right now (correct OS,
   * the API is exposed, and at least one fingerprint is enrolled).
   */
  isAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      const fn = (systemPreferences as unknown as {
        canPromptTouchID?: () => boolean;
      }).canPromptTouchID;
      if (typeof fn !== 'function') return false;
      return Boolean(fn.call(systemPreferences));
    } catch (err) {
      logger.warn('canPromptTouchID threw', { err: String(err) });
      return false;
    }
  },

  /**
   * Trigger the biometric prompt. Resolves true on success, false on
   * cancel/denial. If the platform doesn't support Touch ID, resolves
   * false and the caller should treat it as "fall through to PIN".
   */
  async prompt(reason: string): Promise<boolean> {
    if (!TouchId.isAvailable()) return false;
    try {
      const fn = (systemPreferences as unknown as {
        promptTouchID?: (reason: string) => Promise<void>;
      }).promptTouchID;
      if (typeof fn !== 'function') return false;
      await fn.call(systemPreferences, reason);
      return true;
    } catch (err) {
      logger.info('Touch ID prompt rejected', { err: String(err) });
      return false;
    }
  },
};

export type TouchIdModule = typeof TouchId;

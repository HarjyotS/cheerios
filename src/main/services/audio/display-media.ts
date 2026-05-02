/**
 * Wires `navigator.mediaDevices.getDisplayMedia({ audio: true })` for the
 * renderer. On macOS this uses Electron's loopback audio source, which
 * captures everything the user hears (Zoom, Meet, Teams, Slack, …) without
 * requiring a virtual audio device or a Swift native helper.
 *
 * The renderer asks for screen audio; we satisfy the request with the first
 * available screen source (we only use the audio — the video frame is
 * ignored). Permissions: macOS Screen Recording permission is required the
 * first time getDisplayMedia is called.
 */
import { session, desktopCapturer } from 'electron';
import { log } from '../../lib/logger';

const logger = log('display-media');

let installed = false;

export function installDisplayMediaHandler() {
  if (installed) return;
  installed = true;

  // The handler signature was added in Electron 30. On older Electron the
  // call is a no-op and the renderer will get a getDisplayMedia error.
  const sess = session.defaultSession;
  if (typeof (sess as any).setDisplayMediaRequestHandler !== 'function') {
    logger.warn('setDisplayMediaRequestHandler not supported on this Electron version');
    return;
  }

  (sess as any).setDisplayMediaRequestHandler(
    async (
      _request: unknown,
      callback: (
        streams:
          | { video?: { id: string; name: string }; audio?: 'loopback' | 'loopbackWithMute' | { id: string; name: string } }
          | Record<string, never>
      ) => void,
    ) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          fetchWindowIcons: false,
          thumbnailSize: { width: 0, height: 0 },
        });
        const screen = sources[0];
        if (!screen) {
          logger.warn('No screen source available for getDisplayMedia');
          callback({});
          return;
        }
        // 'loopback' captures system audio output — exactly what the spec calls
        // for system-audio capture. The video is required by the API contract
        // but we discard it in the renderer.
        callback({
          video: { id: screen.id, name: screen.name },
          audio: 'loopback',
        });
      } catch (err) {
        logger.error('Display-media handler failed', { err: String(err) });
        callback({});
      }
    },
  );

  logger.info('getDisplayMedia handler installed');
}

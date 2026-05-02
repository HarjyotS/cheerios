/**
 * Always-on-top meeting detection overlay.
 * Runs in its own frameless BrowserWindow so it can appear above other apps.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectedMeeting } from '@shared/types/entities';
import { audioController } from '../audio/AudioController';
import { sourceAppLabel } from '../lib/format';

export function DetectionOverlay() {
  const [detection, setDetection] = useState<DetectedMeeting | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const captureMeetingIdRef = useRef<string | null>(null);

  const dismiss = useCallback(() => {
    if (detection) window.api.detection.ignoreOnce(detection).catch(() => undefined);
    window.api.app.dismissDetectionOverlay().catch(() => undefined);
  }, [detection]);

  useEffect(() => {
    document.documentElement.classList.add('overlay-window-root');
    document.body.classList.add('overlay-window-body');
    return () => {
      document.documentElement.classList.remove('overlay-window-root');
      document.body.classList.remove('overlay-window-body');
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    window.api.detection.current().then((cur) => {
      if (!stopped) setDetection(cur);
    }).catch(() => undefined);
    const offDetected = window.api.events.onMeetingDetected((next) => {
      setDetection(next);
      setMenuOpen(false);
      if (!next) window.api.app.dismissDetectionOverlay().catch(() => undefined);
    });
    const offMeeting = window.api.events.onMeetingUpdated((meeting) => {
      const captureMeetingId = captureMeetingIdRef.current;
      if (!captureMeetingId || meeting.id !== captureMeetingId || !meeting.ended_at) return;
      audioController.stopAllForMeeting(captureMeetingId).catch(() => undefined);
      captureMeetingIdRef.current = null;
    });
    return () => {
      stopped = true;
      offDetected();
      offMeeting();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const takeNotes = useCallback(async () => {
    if (!detection || busy) return;
    setBusy(true);
    try {
      await audioController.stopAnyActive();
      const meeting = await window.api.meetings.create({
        title: detection.title || 'Meeting',
        source_app: detection.source_app,
        detection_confidence: detection.confidence,
        privacy_mode: 'normal',
      });
      captureMeetingIdRef.current = meeting.id;
      await window.api.meetings.start(meeting.id).catch(() => undefined);

      await audioController.startMicForMeeting(meeting.id).catch((err) => {
        console.warn('Mic start failed', err);
      });

      window.api.app.openMeeting(meeting.id).catch(() => undefined);
      window.api.app.dismissDetectionOverlay().catch(() => undefined);
      setBusy(false);
    } catch (err) {
      console.error('Failed to start detected meeting', err);
      setBusy(false);
    }
  }, [busy, detection]);

  const ignoreApp = useCallback(async () => {
    if (!detection) return;
    await window.api.detection.alwaysIgnore({ source_app: detection.source_app }).catch(() => undefined);
    window.api.app.dismissDetectionOverlay().catch(() => undefined);
  }, [detection]);

  const alwaysStart = useCallback(async () => {
    if (!detection) return;
    await window.api.detection.alwaysStartFor({ source_app: detection.source_app }).catch(() => undefined);
    await takeNotes();
  }, [detection, takeNotes]);

  if (!detection) return null;

  const app = appLabel(detection);

  return (
    <div className="meeting-detection-overlay" role="dialog" aria-label="Meeting detected">
      <div className="meeting-overlay-grip" aria-hidden="true" />
      <div className="meeting-overlay-copy">
        <div className="meeting-overlay-title">Meeting detected</div>
        <div className="meeting-overlay-app" title={app}>{app}</div>
      </div>
      <div className="meeting-overlay-action">
        <button className="meeting-overlay-primary" onClick={takeNotes} disabled={busy}>
          <span className="meeting-overlay-mark" aria-hidden="true" />
          <span>{busy ? 'Starting...' : 'Start note'}</span>
        </button>
        <button
          className="meeting-overlay-menu-button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Meeting detection options"
          aria-expanded={menuOpen}
        >
          <span aria-hidden="true">...</span>
        </button>
      </div>
      {menuOpen && (
        <div className="meeting-overlay-menu" role="menu">
          <button onClick={dismiss} role="menuitem">Dismiss</button>
          <button onClick={ignoreApp} role="menuitem">Ignore app</button>
          <button onClick={alwaysStart} role="menuitem" disabled={busy}>Always start</button>
        </div>
      )}
    </div>
  );
}

function appLabel(d: DetectedMeeting): string {
  const fallback = d.signals.process_name?.trim();
  if (d.source_app === 'unknown' && fallback) return fallback;
  return sourceAppLabel(d.source_app);
}

/**
 * Floating detection toast shown on the right side whenever the detection
 * service spots an external meeting (mic active in another app, or a
 * known meeting app foregrounded). One click → start a note that resumes
 * later if needed; one click → dismiss for the rest of this session.
 *
 * Design rules:
 *   - Never shows while a meeting is already live in our app — the
 *     detection-service already suppresses the event in that case, but the
 *     UI guards too so a stale store value can't surface a stuck toast.
 *   - Per-session dismiss: dismissing the same source app within 5 minutes
 *     hides the toast for that source.
 *   - Click-through to detection rules (ignore-once / always-start / always-
 *     ignore) lives on the toast itself so the user never has to dig into
 *     settings to silence a particular app.
 */
import { useEffect, useRef, useState } from 'react';
import type { DetectedMeeting } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';
import { audioController } from '../audio/AudioController';
import { sourceAppLabel } from '../lib/format';

const SNOOZE_MS = 5 * 60 * 1000;

export function DetectionToast() {
  const detection = useStore((s) => s.detection);
  const meetings = useStore((s) => s.meetings);
  const settings = useStore((s) => s.settings);
  const liveExists = meetings.some((m) => !m.ended_at);

  // Per-session snooze map: source_app → epoch-ms-until.
  const snoozedRef = useRef<Map<string, number>>(new Map());
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);

  // Periodically tick to expire snoozes so the toast can re-appear.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (!detection) return null;
  if (liveExists) return null;
  if (detection.confidence === 'low' && !settings?.show_low_confidence_detection) return null;
  const snoozeUntil = snoozedRef.current.get(detection.source_app);
  if (snoozeUntil && snoozeUntil > Date.now()) return null;

  const start = async () => {
    setBusy(true);
    try {
      await audioController.stopAnyActive();
      const m = await window.api.meetings.create({
        title: detection.title || 'Meeting',
        source_app: detection.source_app,
        privacy_mode: 'normal',
      });
      window.api.meetings.start(m.id).catch(() => undefined);
      audioController.startMicForMeeting(m.id).catch((err) =>
        console.warn('Mic start failed', err),
      );
      navigate('/meeting/' + m.id);
    } catch (err) {
      alert(`Couldn't start a meeting: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    snoozedRef.current.set(detection.source_app, Date.now() + SNOOZE_MS);
    window.api.detection.ignoreOnce(detection).catch(() => undefined);
    // Force a re-render so the toast disappears; the store still holds
    // the detection but our local snooze hides it.
    force((n) => n + 1);
  };

  const alwaysIgnore = async () => {
    snoozedRef.current.set(detection.source_app, Date.now() + 24 * 60 * 60 * 1000);
    try {
      await window.api.detection.alwaysIgnore({ source_app: detection.source_app });
    } catch (err) {
      console.warn('alwaysIgnore failed', err);
    }
    force((n) => n + 1);
  };

  const alwaysStart = async () => {
    try {
      await window.api.detection.alwaysStartFor({ source_app: detection.source_app });
    } catch (err) {
      console.warn('alwaysStartFor failed', err);
    }
    await start();
  };

  return (
    <div className="detection-toast" role="dialog">
      <div className="detection-toast-head">
        <span className="rec-dot" />
        <span className="detection-toast-title">{prompt(detection)}</span>
      </div>
      <div className="detection-toast-body">
        {detection.title && <div className="detection-toast-meeting">{detection.title}</div>}
        <div className="muted small">
          {appLabel(detection)} · {detection.confidence} confidence
        </div>
      </div>
      <div className="detection-toast-actions">
        <button className="primary" onClick={start} disabled={busy}>
          {busy ? 'Starting...' : 'Start note'}
        </button>
        <button onClick={dismiss}>Not now</button>
      </div>
      <div className="detection-toast-secondary">
        <button className="link" onClick={alwaysStart} disabled={busy}>
          Always start for {appLabel(detection)}
        </button>
        <span className="muted">·</span>
        <button className="link" onClick={alwaysIgnore}>Never for this app</button>
      </div>
    </div>
  );
}

function appLabel(d: DetectedMeeting): string {
  const fallback = d.signals.process_name?.trim();
  if (d.source_app === 'unknown' && fallback) return fallback;
  return sourceAppLabel(d.source_app);
}

function prompt(d: DetectedMeeting): string {
  const app = appLabel(d);
  if (d.confidence === 'high') return `Meeting detected in ${app}`;
  if (d.confidence === 'medium') return `Looks like a meeting in ${app}`;
  return `Mic active in ${app}`;
}

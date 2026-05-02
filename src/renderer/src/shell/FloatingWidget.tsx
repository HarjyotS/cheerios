/**
 * Floating widget. Always-on-top mini meeting controller.
 * Polls window.api.meetings.list() for an active meeting and exposes the
 * essential live-meeting controls.
 */
import { useEffect, useState, useCallback } from 'react';
import type { Meeting } from '@shared/types/entities';
import { formatDuration } from '../lib/format';

function elapsedSeconds(startedAt?: string | null): number {
  if (!startedAt) return 0;
  const t = new Date(startedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export function FloatingWidget() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);

  // Refresh meeting state and tick the timer every second.
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const list = await window.api.meetings.list();
        if (stopped) return;
        // Active meeting: ended_at is null
        const active = list.find((m) => !m.ended_at) ?? null;
        setMeeting(active);
      } catch {
        if (!stopped) setMeeting(null);
      }
    };
    refresh();
    const t = setInterval(() => {
      setTick((n) => n + 1);
      // Re-poll every 5s for state changes
      if (Date.now() % 5000 < 1000) refresh();
    }, 1000);

    // Subscribe to meeting updates so we react instantly to start/stop.
    let off: (() => void) | null = null;
    try {
      off = window.api.events.onMeetingUpdated((m) => {
        if (m.ended_at) {
          // If the active meeting ended, refetch
          refresh();
        } else {
          setMeeting(m);
        }
      });
    } catch {
      /* noop */
    }

    return () => {
      stopped = true;
      clearInterval(t);
      if (off) off();
    };
  }, []);

  const handlePause = useCallback(async () => {
    if (!meeting) return;
    try {
      if (paused) await window.api.meetings.resume(meeting.id);
      else await window.api.meetings.pause(meeting.id);
      setPaused((p) => !p);
    } catch {
      /* noop */
    }
  }, [meeting, paused]);

  const handleStop = useCallback(async () => {
    if (!meeting) return;
    try {
      await window.api.meetings.stop(meeting.id);
    } catch {
      /* noop */
    }
  }, [meeting]);

  const deleteLast60 = useCallback(async () => {
    if (!meeting) return;
    try {
      await window.api.meetings.deleteLastSeconds(meeting.id, 60);
    } catch {
      /* noop */
    }
  }, [meeting]);

  const openFullNote = useCallback(() => {
    if (!meeting) {
      window.api.app.showMainWindow().catch(() => undefined);
      return;
    }
    window.api.app.showMainWindow().catch(() => undefined);
    // Navigate the main window — best-effort: location for this widget is its own.
    // The main window has its own router; we cannot directly nav into it from here
    // without IPC. Showing the window is enough; user can click the meeting.
  }, [meeting]);

  if (!meeting) {
    return (
      <div className="floating-widget">
        <div className="head">
          <div className="title muted">No active meeting</div>
        </div>
        <div className="controls">
          <button onClick={() => window.api.app.showMainWindow().catch(() => undefined)}>
            Open Cherios
          </button>
        </div>
      </div>
    );
  }

  // Suppress unused tick warning by referencing it
  void tick;

  const seconds = elapsedSeconds(meeting.started_at);

  return (
    <div className="floating-widget">
      <div className="head">
        <div className="row gap-8" style={{ minWidth: 0 }}>
          {!paused && <span className="rec-dot" />}
          <span className="title" title={meeting.title}>
            {meeting.title}
          </span>
        </div>
        <span className="timer">{formatDuration(seconds)}</span>
      </div>
      <div className="controls">
        <button onClick={handlePause} title={paused ? 'Resume' : 'Pause'}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={handleStop} title="Stop meeting">
          Stop
        </button>
        <button onClick={deleteLast60} title="Delete last 60s">
          Last 60s
        </button>
        <button onClick={openFullNote} title="Open full note">
          Open
        </button>
      </div>
    </div>
  );
}

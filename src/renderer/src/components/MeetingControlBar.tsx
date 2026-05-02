/**
 * Live meeting control bar — shown in MeetingView while the meeting is running.
 * Both mic and system audio can run simultaneously; each has an independent
 * indicator + toggle.
 */
import { useEffect, useState } from 'react';
import type { Meeting } from '@shared/types/entities';
import { audioController } from '../audio/AudioController';

export function MeetingControlBar({ meeting }: { meeting: Meeting }) {
  const [paused, setPaused] = useState(false);
  const [micActive, setMicActive] = useState(() => audioController.isMicActive(meeting.id));
  const [sysActive, setSysActive] = useState(() => audioController.isSystemActive(meeting.id));
  const [busy, setBusy] = useState(false);
  const [permError, setPermError] = useState<{ kind: 'mic' | 'screen'; message: string } | null>(null);

  // Poll the audio controller a few times per second so the UI reflects
  // captures that were started by the new-note flow before this component
  // mounted.
  useEffect(() => {
    const tick = () => {
      setMicActive(audioController.isMicActive(meeting.id));
      setSysActive(audioController.isSystemActive(meeting.id));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [meeting.id]);

  // One-shot mic permission preflight so the banner shows even if the user
  // never clicks "Start mic".
  useEffect(() => {
    (async () => {
      try {
        const s = await window.api.app.getPermissionStatus();
        if (s.microphone === 'denied') {
          setPermError({ kind: 'mic', message: 'Microphone permission was denied. Grant it in System Settings.' });
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const startMic = async () => {
    setBusy(true);
    setPermError(null);
    try {
      await audioController.startMicForMeeting(meeting.id);
      setMicActive(true);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'permission-denied') {
        setPermError({ kind: 'mic', message: e.message });
      } else {
        alert(`Mic capture failed: ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  };
  const stopMic = async () => {
    try { await audioController.stopMicForMeeting(meeting.id); } finally { setMicActive(false); }
  };

  const startSystem = async () => {
    setBusy(true);
    setPermError(null);
    try {
      const status = await window.api.app.getPermissionStatus();
      if (status.screen !== 'granted') {
        setPermError({
          kind: 'screen',
          message:
            status.screen === 'denied'
              ? 'Screen Recording permission was denied. Grant it in System Settings, then fully quit and reopen the app.'
              : "Screen Recording permission isn't granted yet. macOS will prompt you — accept it, then fully quit and reopen the app.",
        });
        return;
      }
      await audioController.startSystemForMeeting(meeting.id);
      setSysActive(true);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'permission-denied' || /denied/i.test(e.message) || /starting capture/i.test(e.message)) {
        setPermError({
          kind: 'screen',
          message:
            'macOS blocked system-audio capture. Open System Settings → Privacy & Security → Screen Recording, enable Electron, then fully quit and reopen the app.',
        });
      } else {
        alert(`System audio failed: ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  };
  const stopSystem = async () => {
    try { await audioController.stopSystemForMeeting(meeting.id); } finally { setSysActive(false); }
  };

  const togglePause = async () => {
    try {
      if (paused) await window.api.meetings.resume(meeting.id);
      else await window.api.meetings.pause(meeting.id);
      setPaused(!paused);
    } catch (err) {
      console.error(err);
    }
  };
  const stop = async () => {
    try {
      await audioController.stopAllForMeeting(meeting.id);
      setMicActive(false);
      setSysActive(false);
      await window.api.meetings.stop(meeting.id);
    } catch (err) {
      console.error(err);
    }
  };
  const deleteLast60 = () => window.api.meetings.deleteLastSeconds(meeting.id, 60).catch(console.error);

  return (
    <div className="control-bar-wrap">
      <div className="recording-status">
        {!paused && <span className="rec-dot" />}
        <span>
          {paused ? 'Paused' : 'Recording'} - {micActive ? 'mic on' : 'mic off'} - {sysActive ? 'system audio on' : 'system audio off'} - AI notes generate after stop.
        </span>
      </div>
      <div className="control-bar">
        <SourceToggle
          label="Mic"
          active={micActive}
          onStart={startMic}
          onStop={stopMic}
          disabled={busy}
        />
        <SourceToggle
          label="System audio"
          active={sysActive}
          onStart={startSystem}
          onStop={stopSystem}
          disabled={busy}
          hint="Capture everything you hear (Zoom/Meet/Teams + apps)"
        />
        <div className="control-divider" />
        <button className="control-action" onClick={togglePause} title={paused ? 'Resume recording' : 'Pause recording'}>
          <span className={`control-icon ${paused ? 'play' : 'pause'}`} aria-hidden="true" />
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="control-action danger" onClick={stop} title="Stop and generate notes">
          <span className="control-icon stop" aria-hidden="true" />
          Stop
        </button>
        <button className="control-action" onClick={deleteLast60} title="Delete last 60s of transcript">
          <span className="control-icon delete" aria-hidden="true" />
          Last 60s
        </button>
      </div>

      {permError && (
        <div className="perm-banner">
          <div className="perm-banner-text">
            <strong>{permError.kind === 'screen' ? 'Screen Recording permission needed' : 'Microphone permission needed'}</strong>
            <div className="muted small">{permError.message}</div>
          </div>
          <div className="row gap-8">
            <button
              className="primary"
              onClick={() => window.api.app.openSystemSettings(permError.kind === 'screen' ? 'screen' : 'microphone')}
            >
              Open System Settings
            </button>
            <button onClick={() => setPermError(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceToggle({
  label,
  active,
  onStart,
  onStop,
  disabled,
  hint,
}: {
  label: string;
  active: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={active ? onStop : onStart}
      disabled={disabled}
      title={hint ?? (active ? `Stop capturing ${label.toLowerCase()}` : `Start capturing ${label.toLowerCase()}`)}
      className={active ? 'source-toggle on' : 'source-toggle off'}
    >
      <span className={`dot ${active ? 'live' : ''}`} />
      {label}
      <span className="state">{active ? 'on' : 'off'}</span>
    </button>
  );
}

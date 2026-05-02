import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { isToday, formatTime, sourceAppLabel, todayBounds } from '../lib/format';
import { DetectionPrompt } from '../components/DetectionPrompt';
import { audioController } from '../audio/AudioController';
import { MeetingListRow } from '../components/MeetingListRow';
import { navigate } from '../lib/router';

function defaultMeetingTitle(): string {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `Quick note · ${date}, ${time}`;
}

export function TodayView() {
  const meetings = useStore((s) => s.meetings);
  const upcoming = useStore((s) => s.upcoming);
  const refreshMeetings = useStore((s) => s.actions.refreshMeetings);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    refreshMeetings();
  }, [refreshMeetings]);

  const today = useMemo(() => meetings.filter((m) => isToday(m.started_at)), [meetings]);
  const todayEvents = useMemo(() => {
    const { from, to } = todayBounds();
    return upcoming.filter((e) => e.starts_at >= from && e.starts_at <= to);
  }, [upcoming]);

  const startNewMeeting = async () => {
    setStarting(true);
    try {
      // Tear down any captures from a previous meeting before creating a new one.
      await audioController.stopAnyActive();

      const m = await window.api.meetings.create({
        title: defaultMeetingTitle(),
        source_app: 'unknown',
        privacy_mode: 'normal',
      });
      // Start mic capture first. System audio is an explicit secondary toggle
      // inside the meeting view so headphone output is not disturbed on start.
      window.api.meetings.start(m.id).catch(() => undefined);
      audioController.startMicForMeeting(m.id).catch((err) => {
        console.warn('Mic start failed', err);
      });
      navigate('/meeting/' + m.id);
    } catch (err) {
      alert(`Couldn't start a meeting: ${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <div className="content-header">
        <h1>Today</h1>
        <div className="actions">
          <button className="primary" onClick={startNewMeeting} disabled={starting}>
            {starting ? 'Starting...' : 'Start note'}
          </button>
        </div>
      </div>
      <div className="content-body col gap-16">
        <DetectionPrompt />

        {today.length === 0 && todayEvents.length === 0 && (
          <div className="empty-state">
            <h3>Nothing happening yet</h3>
            <p>
              Click <strong>Start note</strong> to start recording now, or join a Zoom/Meet/Teams call -
              detection will offer to start a note automatically.
            </p>
          </div>
        )}

        <section>
          <h3>On your calendar</h3>
          {todayEvents.length === 0 && <div className="muted small">Nothing on today.</div>}
          {todayEvents.map((e) => (
            <div className="card" key={e.id} style={{ marginBottom: 8 }}>
              <div className="row between">
                <div className="col">
                  <div className="card-title">{e.title}</div>
                  <div className="muted small">
                    {formatTime(e.starts_at)}–{formatTime(e.ends_at)}
                    {e.meeting_app_hint && <> · {sourceAppLabel(e.meeting_app_hint)}</>}
                  </div>
                </div>
                {e.meeting_link && (
                  <a href={e.meeting_link} target="_blank" rel="noreferrer">Join</a>
                )}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h3>Today's notes</h3>
          {today.length === 0 && <div className="muted small">No meetings recorded today.</div>}
          {today.map((m) => (
            <MeetingListRow key={m.id} meeting={m} />
          ))}
        </section>
      </div>
    </>
  );
}

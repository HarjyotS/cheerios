import { useEffect, useState } from 'react';
import type { Meeting } from '@shared/types/entities';
import { MeetingHeader } from '../components/MeetingHeader';
import { MeetingTabs, type TabKey } from '../components/MeetingTabs';
import { MeetingControlBar } from '../components/MeetingControlBar';
import { AINotesTab } from '../components/AINotesTab';
import { RawNotesTab } from '../components/RawNotesTab';
import { TranscriptTab } from '../components/TranscriptTab';
import { ChatTab } from '../components/ChatTab';
import { TasksTab } from '../components/TasksTab';
import { ExportsTab } from '../components/ExportsTab';
import { audioController } from '../audio/AudioController';
import { formatDuration } from '../lib/format';
import { useStore } from '../store/store';

export function MeetingView({ meetingId }: { meetingId: string }) {
  const advanced = useStore((s) => Boolean(s.settings?.advanced_labs_enabled));
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [tab, setTab] = useState<TabKey>('ai');
  const [err, setErr] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.api.meetings.get(meetingId).then((m) => {
      if (!cancelled) setMeeting(m);
    }).catch((e) => setErr(String(e)));
    const off = window.api.events.onMeetingUpdated((m) => {
      if (m.id === meetingId) setMeeting(m);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [meetingId]);

  useEffect(() => {
    if (!advanced && tab === 'chat') setTab('ai');
  }, [advanced, tab]);

  const resume = async () => {
    if (!meeting) return;
    setResuming(true);
    try {
      // Stop any captures left from a previous meeting before reopening.
      await audioController.stopAnyActive();
      const reopened = await window.api.meetings.reopen(meeting.id);
      setMeeting(reopened);
      // Resume with mic first. System audio remains an explicit in-note toggle.
      audioController.startMicForMeeting(reopened.id).catch((err) => {
        console.warn('Mic start failed', err);
      });
    } catch (err) {
      alert(`Couldn't resume: ${(err as Error).message}`);
    } finally {
      setResuming(false);
    }
  };

  if (err) return <div className="content-body"><div className="error">{err}</div></div>;
  if (!meeting) return <div className="content-body muted">Loading…</div>;

  const live = !meeting.ended_at;

  return (
    <div className="meeting-view">
      {/* Sticky region: title + control bar + tabs */}
      <div className="meeting-fixed">
        <div className="content-header">
          <h1 style={{ visibility: 'hidden' }}>·</h1>
        </div>
        <div className="meeting-fixed-inner">
          <MeetingHeader meeting={meeting} />
          {live ? (
            <MeetingControlBar meeting={meeting} />
          ) : (
            <ResumeBanner
              endedAt={meeting.ended_at!}
              startedAt={meeting.started_at}
              onResume={resume}
              busy={resuming}
            />
          )}
          <MeetingTabs active={tab} onChange={setTab} advanced={advanced} />
        </div>
      </div>

      {/* Scrollable region: tab body */}
      <div className="meeting-scroll">
        <div className="meeting-tab-body">
          {tab === 'ai' && <AINotesTab meetingId={meeting.id} />}
          {tab === 'raw' && <RawNotesTab meetingId={meeting.id} />}
          {tab === 'transcript' && <TranscriptTab meetingId={meeting.id} />}
          {tab === 'chat' && advanced && <ChatTab meetingId={meeting.id} />}
          {tab === 'tasks' && <TasksTab meetingId={meeting.id} />}
          {tab === 'exports' && <ExportsTab meeting={meeting} />}
        </div>
      </div>
    </div>
  );
}

function ResumeBanner({
  endedAt,
  startedAt,
  onResume,
  busy,
}: {
  endedAt: string;
  startedAt: string;
  onResume: () => void;
  busy: boolean;
}) {
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  return (
    <div className="resume-banner">
      <div className="col">
        <div className="resume-banner-title">Note ended</div>
        <div className="muted small">
          Captured {formatDuration(seconds)} · ended{' '}
          {new Date(endedAt).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
      </div>
      <button className="primary" onClick={onResume} disabled={busy} title="Re-open this note and continue capturing">
        {busy ? 'Resuming...' : 'Resume'}
      </button>
    </div>
  );
}

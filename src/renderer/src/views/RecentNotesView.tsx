import { useEffect } from 'react';
import { useStore } from '../store/store';
import { MeetingListRow } from '../components/MeetingListRow';

export function RecentNotesView() {
  const meetings = useStore((s) => s.meetings);
  const refresh = useStore((s) => s.actions.refreshMeetings);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <div className="content-header">
        <h1>Recent notes</h1>
        <div className="actions">
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>
      <div className="content-body">
        {meetings.length === 0 && (
          <div className="empty-state">
            <h3>No meetings yet</h3>
            <p>Click <strong>Start note</strong> on Today, or use <span className="kbd">Cmd+Shift+N</span>.</p>
          </div>
        )}
        {meetings.map((m) => (
          <MeetingListRow key={m.id} meeting={m} />
        ))}
      </div>
    </>
  );
}

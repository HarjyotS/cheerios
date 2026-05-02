import { useEffect } from 'react';
import { useStore } from '../store/store';
import { formatDateTime, sourceAppLabel } from '../lib/format';

export function UpcomingView() {
  const upcoming = useStore((s) => s.upcoming);
  const refreshUpcoming = useStore((s) => s.actions.refreshUpcoming);

  useEffect(() => {
    refreshUpcoming();
    window.api.calendar.refresh().catch(() => undefined);
  }, [refreshUpcoming]);

  return (
    <>
      <div className="content-header">
        <h1>Upcoming</h1>
        <div className="actions">
          <button onClick={() => window.api.calendar.refresh().then(refreshUpcoming)}>Refresh</button>
          <button onClick={() => window.api.calendar.connect().then(refreshUpcoming)}>Connect Calendar</button>
        </div>
      </div>
      <div className="content-body">
        {upcoming.length === 0 && <div className="muted small">No upcoming events.</div>}
        {upcoming.map((e) => (
          <div className="card" key={e.id} style={{ marginBottom: 8 }}>
            <div className="row between">
              <div className="col">
                <div className="card-title">{e.title}</div>
                <div className="muted small">
                  {formatDateTime(e.starts_at)} → {formatDateTime(e.ends_at)}
                  {e.meeting_app_hint && <> · {sourceAppLabel(e.meeting_app_hint)}</>}
                </div>
                {e.attendees?.length > 0 && (
                  <div className="row gap-8 small" style={{ marginTop: 6 }}>
                    {e.attendees.slice(0, 6).map((a, i) => (
                      <span key={i} className="chip">{a.name ?? a.email}</span>
                    ))}
                  </div>
                )}
              </div>
              {e.meeting_link && (
                <a href={e.meeting_link} target="_blank" rel="noreferrer">Join</a>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

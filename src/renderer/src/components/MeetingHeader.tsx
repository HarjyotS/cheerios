import { useEffect, useRef, useState } from 'react';
import type { Meeting } from '@shared/types/entities';
import { formatDateTime, sourceAppLabel } from '../lib/format';
import { useStore } from '../store/store';

export function MeetingHeader({ meeting }: { meeting: Meeting }) {
  const people = useStore((s) => s.people);
  const sync = useStore((s) => s.syncStatuses)[meeting.id];

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Stay in sync when the upstream meeting changes (e.g. an edit on another device)
  useEffect(() => {
    if (!editing) setTitle(meeting.title);
  }, [meeting.title, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    const next = title.trim() || meeting.title;
    setEditing(false);
    if (next === meeting.title) return;
    try {
      // Once the user types a title, it's no longer a placeholder — the AI
      // engine should not overwrite it.
      await window.api.meetings.update(meeting.id, { title: next, title_is_auto: false });
    } catch (err) {
      console.error('Rename failed', err);
      setTitle(meeting.title);
    }
  };

  const attendees = meeting.attendees
    .map((id) => people.find((p) => p.id === id))
    .filter(Boolean) as Array<{ name: string }>;

  const isLive = !meeting.ended_at;

  return (
    <div className="meeting-header">
      <div className="row between">
        <div className="col" style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              ref={inputRef}
              className="title-edit"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') {
                  setTitle(meeting.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <h2
              className="title"
              onClick={() => setEditing(true)}
              title="Click to rename"
            >
              {meeting.title}
            </h2>
          )}
          <div className="row gap-12 small muted">
            <span>{formatDateTime(meeting.started_at)}</span>
            <span>· {sourceAppLabel(meeting.source_app)}</span>
            {isLive && <span className="badge live">● Live</span>}
            {meeting.privacy_mode !== 'normal' && (
              <span className={`badge ${meeting.privacy_mode === 'private' ? 'private' : 'local'}`}>
                {meeting.privacy_mode}
              </span>
            )}
            {meeting.drive_sync_status === 'synced' && <span className="badge synced">Drive synced</span>}
            {sync && sync.status === 'failed' && <span className="badge private">Drive sync failed</span>}
          </div>
          {attendees.length > 0 && (
            <div className="row gap-8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {attendees.map((a, i) => (
                <span key={i} className="chip">{a.name}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

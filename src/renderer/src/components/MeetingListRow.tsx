/**
 * Reusable meeting list row used by Today and Recent Notes (legacy).
 * Click body to open. Hover actions can rename or delete. Drag the row onto
 * a folder in the Notes view to move it.
 */
import { useEffect, useRef, useState } from 'react';
import type { Meeting } from '@shared/types/entities';
import { formatDateTime, sourceAppLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useStore } from '../store/store';

export function MeetingListRow({ meeting }: { meeting: Meeting }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const refresh = useStore((s) => s.actions.refreshMeetings);

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
      await window.api.meetings.update(meeting.id, { title: next, title_is_auto: false });
    } catch {
      setTitle(meeting.title);
    }
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete note "${meeting.title}"? This cannot be undone.`)) return;
    try {
      await window.api.meetings.delete(meeting.id);
      refresh();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  };

  const onRowClick = () => {
    if (editing) return;
    navigate('/meeting/' + meeting.id);
  };

  return (
    <div
      className="list-row"
      onClick={onRowClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pmos-meeting', meeting.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            ref={inputRef}
            className="row-title-edit"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
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
          <div className="title">{meeting.title}</div>
        )}
        <div className="meta">
          {formatDateTime(meeting.started_at)} · {sourceAppLabel(meeting.source_app)}
        </div>
      </div>
      <div className="row gap-8">
        {!meeting.ended_at && <span className="badge live">live</span>}
        {meeting.privacy_mode !== 'normal' && (
          <span className={`badge ${meeting.privacy_mode === 'private' ? 'private' : 'local'}`}>
            {meeting.privacy_mode}
          </span>
        )}
        {meeting.drive_sync_status === 'synced' && <span className="badge synced">drive</span>}
        <button className="row-icon-action rename" onClick={startEdit} title="Rename" aria-label="Rename" />
        <button className="row-icon-action delete" onClick={onDelete} title="Delete" aria-label="Delete" />
      </div>
    </div>
  );
}

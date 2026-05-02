import { useEffect, useState } from 'react';
import type { ActionItem, ID } from '@shared/types/entities';

const TARGETS = ['google_tasks', 'todoist', 'linear', 'notion', 'asana', 'apple_reminders'] as const;

export function TasksTab({ meetingId }: { meetingId: ID }) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const reload = async () => {
    const all = await window.api.actionItems.list();
    setItems(all.filter((a) => a.meeting_id === meetingId));
  };
  useEffect(() => {
    reload();
  }, [meetingId]);

  const updateStatus = (id: ID, status: ActionItem['status']) => {
    window.api.actionItems.update(id, { status }).then(reload).catch(console.error);
  };
  const sync = (id: ID, target: typeof TARGETS[number]) => {
    window.api.actionItems.syncTo(id, target).then(reload).catch((e) => alert(`Sync failed: ${e?.message ?? e}`));
  };

  if (items.length === 0) {
    return <div className="muted">No action items yet. Generate AI notes to extract them.</div>;
  }

  return (
    <div className="tasks-tab">
      {items.map((a) => (
        <div key={a.id} className={`task ${a.status}`}>
          <div className="row gap-8">
            <input
              type="checkbox"
              checked={a.status === 'done'}
              onChange={(e) => updateStatus(a.id, e.target.checked ? 'done' : 'open')}
            />
            <span className={a.status === 'done' ? 'strike' : ''}>{a.task}</span>
            <span className="muted small">— {a.owner}</span>
            {a.due_date && <span className="badge">{a.due_date.slice(0, 10)}</span>}
            <span className={`badge ${a.priority}`}>{a.priority}</span>
          </div>
          <div className="row gap-8 small muted">
            Sync:
            {TARGETS.map((t) => (
              <button key={t} onClick={() => sync(a.id, t)} title={`Push to ${t}`}>
                {a.external_ids?.[t] ? 'synced ' : ''}{t.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

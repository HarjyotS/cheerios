import { useEffect, useMemo, useState } from 'react';
import type { ActionItem } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';

type FilterKey = 'today' | 'upcoming' | 'overdue' | 'all' | 'open' | 'waiting' | 'done';

export function ActionItemsView() {
  const items = useStore((s) => s.actionItems);
  const refresh = useStore((s) => s.actions.refreshActionItems);
  const [filter, setFilter] = useState<FilterKey>('open');

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => applyFilter(items, filter), [items, filter]);

  const toggle = (a: ActionItem) => {
    const next = a.status === 'done' ? 'open' : 'done';
    window.api.actionItems.update(a.id, { status: next }).then(refresh).catch(console.error);
  };

  return (
    <>
      <div className="content-header">
        <h1>Action items</h1>
        <div className="actions row gap-8">
          {(['open', 'today', 'upcoming', 'overdue', 'waiting', 'done', 'all'] as FilterKey[]).map((f) => (
            <button key={f} className={filter === f ? 'primary' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="content-body">
        {filtered.length === 0 && <div className="muted">Nothing here.</div>}
        {filtered.map((a) => (
          <div key={a.id} className="list-row">
            <input
              type="checkbox"
              checked={a.status === 'done'}
              onChange={() => toggle(a)}
            />
            <div className="col" style={{ flex: 1 }} onClick={() => navigate('/meeting/' + a.meeting_id)}>
              <div className={`title ${a.status === 'done' ? 'strike' : ''}`}>{a.task}</div>
              <div className="meta">
                {a.owner} {a.due_date && <>· due {a.due_date.slice(0, 10)}</>} · priority {a.priority}
              </div>
            </div>
            <span className={`badge ${a.priority}`}>{a.priority}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function applyFilter(items: ActionItem[], filter: FilterKey): ActionItem[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  switch (filter) {
    case 'all':
      return items;
    case 'open':
      return items.filter((a) => a.status === 'open' || a.status === 'in_progress');
    case 'today':
      return items.filter((a) => a.due_date && a.due_date.slice(0, 10) === today && a.status !== 'done');
    case 'upcoming':
      return items.filter((a) => a.due_date && a.due_date >= now.toISOString() && a.status !== 'done');
    case 'overdue':
      return items.filter((a) => a.due_date && a.due_date < now.toISOString() && a.status !== 'done');
    case 'waiting':
      return items.filter((a) => a.status === 'waiting');
    case 'done':
      return items.filter((a) => a.status === 'done');
  }
}

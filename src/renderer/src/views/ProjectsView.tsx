import { useEffect, useState } from 'react';
import type { Meeting, Project } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';
import { formatDateTime, sourceAppLabel } from '../lib/format';

export function ProjectsView({ selectedId }: { selectedId?: string } = {}) {
  const projects = useStore((s) => s.projects);
  const refresh = useStore((s) => s.actions.refreshProjects);
  const [selected, setSelected] = useState<Project | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const target = selectedId ? projects.find((p) => p.id === selectedId) ?? null : null;
    setSelected(target);
    if (target) {
      window.api.projects.meetings(target.id).then(setMeetings).catch(() => setMeetings([]));
    } else {
      setMeetings([]);
    }
  }, [selectedId, projects]);

  const create = async () => {
    if (!newName.trim()) return;
    await window.api.projects.upsert({ name: newName.trim() });
    setNewName('');
    setCreating(false);
    refresh();
  };

  return (
    <>
      <div className="content-header">
        <h1>Projects</h1>
        <div className="actions">
          {!creating ? (
            <button className="primary" onClick={() => setCreating(true)}>+ Project</button>
          ) : (
            <span className="row gap-8">
              <input autoFocus placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
              <button onClick={create}>Save</button>
              <button onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
            </span>
          )}
        </div>
      </div>
      <div className="split-view">
        <div className="split-list">
          {projects.length === 0 && <div className="muted small" style={{ padding: 16 }}>No projects yet.</div>}
          {projects.map((p) => (
            <div
              key={p.id}
              className={`list-row ${selected?.id === p.id ? 'selected' : ''}`}
              onClick={() => navigate('/projects/' + p.id)}
            >
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{p.name}</div>
                {p.description && <div className="meta">{p.description}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {selected ? (
            <div className="col gap-16">
              <div>
                <h2>{selected.name}</h2>
                {selected.description && <div className="muted small">{selected.description}</div>}
              </div>
              {selected.ai_summary && (
                <section className="card"><pre className="md">{selected.ai_summary}</pre></section>
              )}
              <section>
                <h3>Meetings</h3>
                {meetings.length === 0 && <div className="muted small">No meetings yet.</div>}
                {meetings.map((m) => (
                  <div key={m.id} className="list-row" onClick={() => navigate('/meeting/' + m.id)}>
                    <div className="col">
                      <div className="title">{m.title}</div>
                      <div className="meta">{formatDateTime(m.started_at)} · {sourceAppLabel(m.source_app)}</div>
                    </div>
                  </div>
                ))}
              </section>
            </div>
          ) : (
            <div className="muted">Select a project on the left.</div>
          )}
        </div>
      </div>
    </>
  );
}

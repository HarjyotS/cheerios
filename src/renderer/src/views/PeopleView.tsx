import { useEffect, useState } from 'react';
import type { Meeting, Person } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';
import { formatDateTime, sourceAppLabel } from '../lib/format';

export function PeopleView({ selectedId }: { selectedId?: string } = {}) {
  const people = useStore((s) => s.people);
  const refresh = useStore((s) => s.actions.refreshPeople);

  const [selected, setSelected] = useState<Person | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [profile, setProfile] = useState<string>('');
  const [loadingProfile, setLoadingProfile] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const target = selectedId ? people.find((p) => p.id === selectedId) ?? null : null;
    setSelected(target);
    if (target) {
      window.api.people.meetings(target.id).then(setMeetings).catch(() => setMeetings([]));
      setProfile(target.ai_profile ?? '');
    } else {
      setMeetings([]);
      setProfile('');
    }
  }, [selectedId, people]);

  const buildProfile = async () => {
    if (!selected) return;
    setLoadingProfile(true);
    try {
      const md = await window.api.people.buildProfile(selected.id);
      setProfile(md);
    } catch (e) {
      alert(`Profile failed: ${(e as Error).message}`);
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <>
      <div className="content-header">
        <h1>People</h1>
        <div className="actions">
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>
      <div className="split-view">
        <div className="split-list">
          {people.length === 0 && <div className="muted small" style={{ padding: 16 }}>No people yet.</div>}
          {people.map((p) => (
            <div
              key={p.id}
              className={`list-row ${selected?.id === p.id ? 'selected' : ''}`}
              onClick={() => navigate('/people/' + p.id)}
            >
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{p.name}</div>
                <div className="meta">{p.email ?? p.role ?? ''}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {selected ? (
            <div className="col gap-16">
              <div className="row between">
                <div className="col">
                  <h2>{selected.name}</h2>
                  <div className="muted small">{selected.email}</div>
                </div>
                <button onClick={buildProfile} disabled={loadingProfile}>
                  {loadingProfile ? 'Building…' : 'Rebuild profile'}
                </button>
              </div>
              {profile && (
                <section className="card">
                  <pre className="md">{profile}</pre>
                </section>
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
            <div className="muted">Select a person on the left.</div>
          )}
        </div>
      </div>
    </>
  );
}

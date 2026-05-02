import { useEffect, useState } from 'react';
import type { Company, Meeting } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';
import { formatDateTime, sourceAppLabel } from '../lib/format';

export function CompaniesView({ selectedId }: { selectedId?: string } = {}) {
  const companies = useStore((s) => s.companies);
  const refresh = useStore((s) => s.actions.refreshCompanies);
  const [selected, setSelected] = useState<Company | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [profile, setProfile] = useState('');
  const [loadingProfile, setLoadingProfile] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const target = selectedId ? companies.find((c) => c.id === selectedId) ?? null : null;
    setSelected(target);
    if (target) {
      window.api.companies.meetings(target.id).then(setMeetings).catch(() => setMeetings([]));
      setProfile(target.ai_profile ?? '');
    } else {
      setMeetings([]);
      setProfile('');
    }
  }, [selectedId, companies]);

  const buildProfile = async () => {
    if (!selected) return;
    setLoadingProfile(true);
    try {
      setProfile(await window.api.companies.buildProfile(selected.id));
    } catch (e) {
      alert(`Profile failed: ${(e as Error).message}`);
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <>
      <div className="content-header">
        <h1>Companies</h1>
      </div>
      <div className="split-view">
        <div className="split-list">
          {companies.length === 0 && <div className="muted small" style={{ padding: 16 }}>No companies yet.</div>}
          {companies.map((c) => (
            <div
              key={c.id}
              className={`list-row ${selected?.id === c.id ? 'selected' : ''}`}
              onClick={() => navigate('/companies/' + c.id)}
            >
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{c.name}</div>
                <div className="meta">{c.domain ?? ''}</div>
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
                  {selected.website && <a href={selected.website} target="_blank" rel="noreferrer" className="muted small">{selected.website}</a>}
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
            <div className="muted">Select a company on the left.</div>
          )}
        </div>
      </div>
    </>
  );
}

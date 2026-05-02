import { useState } from 'react';
import type { Meeting } from '@shared/types/entities';
import { navigate } from '../lib/router';
import { formatDateTime, sourceAppLabel } from '../lib/format';

export function SearchView() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ meeting: Meeting; snippet: string; score?: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'fts' | 'semantic'>('fts');

  const run = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'fts') {
        const r = await window.api.search.meetings(q, 50);
        setResults(r);
      } else {
        const r = await window.api.search.semantic(q);
        setResults(r);
      }
    } catch (err) {
      alert(`Search failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="content-header">
        <h1>Search</h1>
        <div className="actions row gap-8">
          <button className={mode === 'fts' ? 'primary' : ''} onClick={() => setMode('fts')}>Keyword</button>
          <button className={mode === 'semantic' ? 'primary' : ''} onClick={() => setMode('semantic')}>Semantic</button>
        </div>
      </div>
      <div className="content-body">
        <div className="row gap-8">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === 'fts' ? 'Search title / notes / summary' : 'Ask a question across all meetings'}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            style={{ flex: 1 }}
            autoFocus
          />
          <button className="primary" onClick={run} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
        </div>
        <div style={{ marginTop: 16 }}>
          {results.length === 0 && <div className="muted small">No results.</div>}
          {results.map(({ meeting, snippet, score }) => (
            <div key={meeting.id} className="list-row" onClick={() => navigate('/meeting/' + meeting.id)}>
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{meeting.title}</div>
                <div className="meta">
                  {formatDateTime(meeting.started_at)} · {sourceAppLabel(meeting.source_app)}
                  {score != null && <> · score {score.toFixed(2)}</>}
                </div>
                <div className="small muted" dangerouslySetInnerHTML={{ __html: snippet }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import type { ChatThread } from '@shared/types/entities';
import { formatDateTime } from '../lib/format';

export function ChatView() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [active, setActive] = useState<ChatThread | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const list = await window.api.chat.threads();
    setThreads(list);
    if (!active && list.length) setActive(list[0]);
  };
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  const newThread = async () => {
    const t = await window.api.chat.newThread({ kind: 'all' }, 'All meetings');
    setThreads([t, ...threads]);
    setActive(t);
  };

  const send = async () => {
    if (!active || !input.trim()) return;
    setBusy(true);
    try {
      const updated = await window.api.chat.send(active.id, input);
      setActive(updated);
      setThreads(threads.map((t) => (t.id === updated.id ? updated : t)));
      setInput('');
    } catch (err) {
      alert(`Chat failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="content-header">
        <h1>Chat</h1>
        <div className="actions">
          <button className="primary" onClick={newThread}>+ New thread</button>
        </div>
      </div>
      <div className="split-view">
        <div className="split-list">
          {threads.length === 0 && <div className="muted small" style={{ padding: 16 }}>No threads yet.</div>}
          {threads.map((t) => (
            <div key={t.id} className={`list-row ${active?.id === t.id ? 'selected' : ''}`} onClick={() => setActive(t)}>
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{t.title}</div>
                <div className="meta">{formatDateTime(t.updated_at)}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail" style={{ display: 'flex', flexDirection: 'column' }}>
          {active ? (
            <div className="chat-tab" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div className="messages" style={{ flex: 1 }}>
                {active.messages.map((m) => (
                  <div key={m.id} className={`message ${m.role}`}>
                    <div className="role muted small">{m.role}</div>
                    <div className="content">{m.content}</div>
                  </div>
                ))}
              </div>
              <div className="composer">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={2}
                  placeholder="Ask anything across your meetings…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button className="primary" onClick={send} disabled={busy || !input.trim()}>{busy ? 'Thinking…' : 'Send'}</button>
              </div>
            </div>
          ) : (
            <div className="muted">Pick a thread or create a new one.</div>
          )}
        </div>
      </div>
    </>
  );
}

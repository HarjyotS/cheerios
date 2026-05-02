import { useEffect, useState } from 'react';
import type { ChatThread, ID } from '@shared/types/entities';

export function ChatTab({ meetingId }: { meetingId: ID }) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const threads = await window.api.chat.threads();
      const existing = threads.find(
        (t) => t.scope.kind === 'meeting' && t.scope.meeting_id === meetingId,
      );
      if (cancelled) return;
      if (existing) setThread(existing);
      else {
        const t = await window.api.chat.newThread({ kind: 'meeting', meeting_id: meetingId }, 'About this meeting');
        if (!cancelled) setThread(t);
      }
    })().catch((e) => setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const send = async () => {
    if (!thread || !input.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await window.api.chat.send(thread.id, input);
      setThread(updated);
      setInput('');
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-tab">
      <div className="messages">
        {thread?.messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            <div className="role muted small">{m.role}</div>
            <div className="content">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div className="citations small muted">
                {m.citations.map((c, i) => (
                  <div key={i}>↳ {c.quote ?? c.meeting_id}</div>
                ))}
              </div>
            )}
          </div>
        ))}
        {thread?.messages.length === 0 && (
          <div className="muted">Ask anything about this meeting.</div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this meeting…"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" onClick={send} disabled={busy || !input.trim()}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </div>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

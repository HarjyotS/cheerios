import { useEffect, useState, type ReactNode } from 'react';
import type { GeneratedNote, ID } from '@shared/types/entities';
import { useStore } from '../store/store';

export function AINotesTab({ meetingId }: { meetingId: ID }) {
  const meeting = useStore((s) => s.meetings.find((m) => m.id === meetingId));
  const advanced = useStore((s) => Boolean(s.settings?.advanced_labs_enabled));
  const [note, setNote] = useState<GeneratedNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transcriptCount, setTranscriptCount] = useState<number | null>(null);

  const load = async () => {
    try {
      const n = await window.api.notes.get(meetingId);
      setNote(n);
      const chunks = await window.api.transcript.listChunks(meetingId).catch(() => []);
      setTranscriptCount(chunks.filter((c) => !c.is_deleted && c.text.trim()).length);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    load();
    const off = window.api.events.onNoteUpdated((n) => {
      if (n.meeting_id === meetingId) setNote(n);
    });
    return () => off();
  }, [meetingId]);

  const generate = async () => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    try {
      const n = await window.api.notes.generate(meetingId);
      setNote(n);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  const transform = async (kind: any) => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    try {
      const n = await window.api.notes.transform(meetingId, kind);
      setNote(n);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  const copyNotes = async () => {
    if (!note) return;
    setErr(null);
    try {
      await navigator.clipboard.writeText(noteToMarkdown(note));
      setNotice('Copied notes.');
    } catch (e) {
      setErr(`Copy failed: ${(e as Error).message}`);
    }
  };

  const exportNotes = async () => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    try {
      await window.api.drive.syncMeeting(meetingId, ['google_doc', 'markdown']);
      setNotice('Export started. Check the Exports tab for Drive status.');
    } catch (e) {
      setErr(`Export failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  if (!note) {
    const isKeyMissing = err && /OPENAI_API_KEY|openai\.api_key|api key/i.test(err);
    const hasSourceText = Boolean(transcriptCount && transcriptCount > 0) || Boolean(meeting?.raw_notes?.trim());
    const copy = isKeyMissing
      ? 'AI notes need an OpenAI API key. Add one in Settings, then come back and retry.'
      : !hasSourceText
        ? 'No transcript or raw notes were captured yet. Start mic capture, speak for a moment, then retry.'
        : meeting?.ended_at
          ? 'Generating notes usually starts after stop. If it did not finish, retry from the transcript below.'
          : 'Stop the meeting to auto-generate, or generate now from the current transcript and raw notes.';
    return (
      <div className="ai-notes empty" aria-busy={loading}>
        <h3>No AI notes yet</h3>
        <p className="ai-notes-empty-copy">{copy}</p>
        <button className="primary ai-notes-generate" onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : err ? 'Retry notes' : 'Generate notes'}
        </button>
        {err && <div className="error ai-notes-empty-error">{err}</div>}
      </div>
    );
  }

  return (
    <div className="ai-notes">
      <div className="row gap-8 toolbar">
        <button onClick={generate} disabled={loading}>{loading ? 'Working...' : 'Regenerate'}</button>
        <button onClick={() => transform('study_notes')} disabled={loading}>Study notes</button>
        <button onClick={() => transform('follow_up_email')} disabled={loading}>Follow-up email</button>
        <button onClick={copyNotes} disabled={loading}>Copy notes</button>
        <button onClick={exportNotes} disabled={loading}>Export</button>
        {advanced && <button onClick={() => transform('shorter')} disabled={loading}>Shorter</button>}
        {advanced && <button onClick={() => transform('detailed')} disabled={loading}>More detail</button>}
        {advanced && <button onClick={() => transform('action_items_only')} disabled={loading}>Action items only</button>}
        {advanced && <button onClick={() => transform('product_spec')} disabled={loading}>Product spec</button>}
      </div>
      {err && <div className="error small">{err}</div>}
      {notice && <div className="notice small">{notice}</div>}
      {note.summary?.trim() && (
        <section className="ai-notes-summary">
          <MarkdownOutline text={note.summary} />
        </section>
      )}
      {note.sections?.length > 0 && (
        <section className="ai-notes-sections">
          {note.sections.map((s, i) => (
            <article className="ai-note-section" key={i}>
              <h3 className="ai-note-section-heading">{s.heading}</h3>
              <MarkdownOutline text={s.body} />
            </article>
          ))}
        </section>
      )}
      {note.decisions?.length > 0 && (
        <section>
          <h3>Decisions</h3>
          <ul>
            {note.decisions.map((d, i) => (
              <li key={i}>{d.text}</li>
            ))}
          </ul>
        </section>
      )}
      {note.action_items?.length > 0 && (
        <section>
          <h3>Action items</h3>
          <ul className="action-list">
            {note.action_items.map((a, i) => (
              <li key={i}>
                <span>{a.task}</span>
                <span className="muted small"> — {a.owner}{a.due_date ? ` (due ${a.due_date.slice(0, 10)})` : ''}</span>
                {a.priority && <span className={`badge`}>{a.priority}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {note.open_questions?.length > 0 && (
        <section>
          <h3>Open questions</h3>
          <ul>{note.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </section>
      )}
      {note.risks?.length > 0 && (
        <section>
          <h3>Risks</h3>
          <ul>{note.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}
      {note.quotes?.length > 0 && (
        <section>
          <h3>Quotes</h3>
          {note.quotes.map((q, i) => (
            <blockquote key={i}>“{q.text}” — <span className="muted small">{q.speaker}</span></blockquote>
          ))}
        </section>
      )}
      {note.follow_up_email && (
        <section>
          <h3>Follow-up email</h3>
          <MarkdownOutline text={note.follow_up_email} />
        </section>
      )}
      {note.personal_reminders?.length > 0 && (
        <section>
          <h3>Personal reminders</h3>
          <ul>{note.personal_reminders.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function noteToMarkdown(note: GeneratedNote): string {
  const lines: string[] = [];
  if (note.summary?.trim()) {
    lines.push(note.summary.trim(), '');
  }
  for (const section of note.sections ?? []) {
    if (!section.heading?.trim() && !section.body?.trim()) continue;
    if (section.heading?.trim()) lines.push(`## ${section.heading.trim()}`);
    if (section.body?.trim()) lines.push(section.body.trim());
    lines.push('');
  }
  if (note.decisions?.length) {
    lines.push('## Decisions');
    for (const d of note.decisions) lines.push(`- ${d.text}`);
    lines.push('');
  }
  if (note.action_items?.length) {
    lines.push('## Action items');
    for (const a of note.action_items) {
      const owner = a.owner ? ` - ${a.owner}` : '';
      const due = a.due_date ? ` (due ${a.due_date.slice(0, 10)})` : '';
      lines.push(`- ${a.task}${owner}${due}`);
    }
    lines.push('');
  }
  if (note.open_questions?.length) {
    lines.push('## Open questions');
    for (const q of note.open_questions) lines.push(`- ${q}`);
    lines.push('');
  }
  if (note.risks?.length) {
    lines.push('## Risks');
    for (const r of note.risks) lines.push(`- ${r}`);
    lines.push('');
  }
  if (note.follow_up_email?.trim()) {
    lines.push('## Follow-up email', note.follow_up_email.trim(), '');
  }
  return lines.join('\n').trim();
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: BulletNode[] };

interface FlatBullet {
  indent: number;
  text: string;
}

interface BulletNode {
  text: string;
  children: BulletNode[];
}

function MarkdownOutline({ text }: { text?: string | null }) {
  const blocks = parseMarkdownOutline(text ?? '');
  if (blocks.length === 0) return null;

  return (
    <div className="md-outline">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const Heading = block.level <= 2 ? 'h4' : 'h5';
          return <Heading key={i}>{renderInlineMarkdown(block.text)}</Heading>;
        }
        if (block.type === 'list') {
          return <BulletList key={i} items={block.items} />;
        }
        return <p key={i}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function parseMarkdownOutline(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let bullets: FlatBullet[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };

  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push({ type: 'list', items: buildBulletTree(bullets) });
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      flushBullets();
      continue;
    }

    const heading = line.match(/^(#{1,5})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushBullets();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*•]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      bullets.push({
        indent: bullet[1].replace(/\t/g, '  ').length,
        text: bullet[2].trim(),
      });
      continue;
    }

    flushBullets();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushBullets();
  return blocks;
}

function buildBulletTree(flat: FlatBullet[]): BulletNode[] {
  const root: BulletNode = { text: '', children: [] };
  const stack: Array<{ indent: number; node: BulletNode }> = [{ indent: -1, node: root }];

  for (const item of flat) {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const node: BulletNode = { text: item.text, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: item.indent, node });
  }

  return root.children;
}

function BulletList({ items }: { items: BulletNode[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>
          <span>{renderInlineMarkdown(item.text)}</span>
          {item.children.length > 0 && <BulletList items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

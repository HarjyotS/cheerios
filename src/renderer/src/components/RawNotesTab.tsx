import { useEffect, useRef, useState } from 'react';
import type { ID } from '@shared/types/entities';

const SLASH_COMMANDS: Array<{ slug: string; expand: string }> = [
  { slug: '/action', expand: '- [ ] ' },
  { slug: '/decision', expand: '**Decision:** ' },
  { slug: '/question', expand: '**Q:** ' },
  { slug: '/risk', expand: '**Risk:** ' },
  { slug: '/quote', expand: '> ' },
  { slug: '/followup', expand: '**Follow up:** ' },
  { slug: '/idea', expand: '**Idea:** ' },
  { slug: '/objection', expand: '**Objection:** ' },
  { slug: '/bug', expand: '**Bug:** ' },
  { slug: '/feature', expand: '**Feature:** ' },
  { slug: '/customer-pain', expand: '**Customer pain:** ' },
];

export function RawNotesTab({ meetingId }: { meetingId: ID }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const debounce = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.meetings.getRawNotes(meetingId).then((s) => {
      if (!cancelled) setText(s ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let v = e.target.value;
    // Slash command expansion: when user types a slash command followed by space, replace with the expansion.
    for (const sc of SLASH_COMMANDS) {
      const target = sc.slug + ' ';
      if (v.endsWith(target)) {
        v = v.slice(0, -target.length) + sc.expand;
        break;
      }
    }
    setText(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSaving(true);
      try {
        await window.api.meetings.setRawNotes(meetingId, v);
      } finally {
        setSaving(false);
      }
    }, 400);
  };

  const insertCapture = (prefix: string) => {
    setText((t) => (t.endsWith('\n') || t.length === 0 ? t : t + '\n') + prefix);
  };

  return (
    <div className="raw-notes">
      <div className="row gap-8 toolbar">
        <button onClick={() => insertCapture('- [ ] ')}>+ Action</button>
        <button onClick={() => insertCapture('**Decision:** ')}>+ Decision</button>
        <button onClick={() => insertCapture('> ')}>+ Quote</button>
        <button onClick={() => insertCapture('**Q:** ')}>+ Question</button>
        <button onClick={() => insertCapture('**Follow up:** ')}>+ Follow-up</button>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Saved'}
        </span>
      </div>
      <textarea
        className="raw-editor"
        value={text}
        onChange={onChange}
        placeholder={`Type away. Slash commands: ${SLASH_COMMANDS.map((s) => s.slug).join(', ')}`}
      />
    </div>
  );
}

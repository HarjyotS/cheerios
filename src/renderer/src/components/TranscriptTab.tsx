import { useEffect, useRef, useState } from 'react';
import type { ID, TranscriptChunk } from '@shared/types/entities';
import { useTranscriptStore } from '../store/transcript-store';
import { formatDuration } from '../lib/format';

// Stable empty-array reference so the selector below doesn't return a fresh
// [] on every render (which would trip zustand's reference equality check
// and cause an infinite re-render loop).
const EMPTY_CHUNKS: readonly TranscriptChunk[] = Object.freeze([]);

export function TranscriptTab({ meetingId }: { meetingId: ID }) {
  // Selector returns the actual array or undefined — never a fresh [].
  const finalsRaw = useTranscriptStore((s) => s.finalsByMeeting[meetingId]);
  const finals = (finalsRaw ?? EMPTY_CHUNKS) as TranscriptChunk[];
  const interim = useTranscriptStore((s) => s.interimByMeeting[meetingId]);
  const loadInitial = useTranscriptStore((s) => s.loadInitial);
  const removeChunk = useTranscriptStore((s) => s.removeChunk);
  const highlightChunk = useTranscriptStore((s) => s.highlightChunk);
  const renameLocal = useTranscriptStore((s) => s.renameSpeaker);

  useEffect(() => {
    loadInitial(meetingId);
  }, [meetingId, loadInitial]);

  // Auto-scroll to the newest chunk as long as the user hasn't manually
  // scrolled up. We attach the sentinel after the last chunk and call
  // scrollIntoView on every render that adds a new chunk.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickyBottomRef = useRef(true);
  const visibleCount = finals.filter((c) => !c.is_deleted).length + (interim ? 1 : 0);
  useEffect(() => {
    if (!stickyBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [visibleCount, interim?.text]);

  // Detect manual scroll-up: when the user scrolls so the bottom isn't in
  // view, stop sticking. When they scroll back to the bottom, resume.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyBottomRef.current = distanceFromBottom < 80;
  };

  return (
    <div className="transcript-tab" onScroll={onScroll}>
      {finals.filter((c) => !c.is_deleted).map((c) => (
        <ChunkRow
          key={c.id}
          chunk={c}
          onDelete={() => {
            removeChunk(c.id);
            window.api.transcript.delete(c.id).catch(console.error);
          }}
          onHighlight={(on) => {
            highlightChunk(c.id, on);
            window.api.transcript.highlight(c.id, on).catch(console.error);
          }}
          onRename={(name, persist) => {
            if (!c.speaker_id) return;
            renameLocal(meetingId, c.speaker_id, name);
            window.api.transcript.renameSpeaker(meetingId, c.speaker_id, name, persist).catch(console.error);
          }}
        />
      ))}
      {interim && (
        <div className="chunk interim">
          <div className="speaker muted">{interim.speakerId ?? '…'}</div>
          <div className="text muted italic">{interim.text}</div>
        </div>
      )}
      {finals.length === 0 && !interim && (
        <div className="muted">No transcript yet. Start the mic to begin transcribing.</div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function ChunkRow({
  chunk,
  onDelete,
  onHighlight,
  onRename,
}: {
  chunk: TranscriptChunk;
  onDelete: () => void;
  onHighlight: (on: boolean) => void;
  onRename: (name: string, persist: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chunk.speaker_name ?? chunk.speaker_id ?? 'Speaker');
  const [persist, setPersist] = useState(false);

  return (
    <div className={`chunk ${chunk.is_highlighted ? 'highlighted' : ''}`}>
      <div className="row gap-8 small muted">
        {!editing ? (
          <span className="speaker" onClick={() => setEditing(true)} title="Rename speaker">
            {chunk.speaker_name ?? chunk.speaker_id ?? 'Speaker'}
          </span>
        ) : (
          <span className="row gap-8">
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
            <label className="tiny">
              <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> remember
            </label>
            <button
              onClick={() => {
                onRename(name, persist);
                setEditing(false);
              }}
            >Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </span>
        )}
        <span>· {formatDuration(chunk.start_time)}</span>
        {chunk.confidence != null && <span>· {(chunk.confidence * 100).toFixed(0)}%</span>}
        <span style={{ marginLeft: 'auto' }} className="row gap-8">
          <button
            className={`row-icon-action highlight ${chunk.is_highlighted ? 'active' : ''}`}
            onClick={() => onHighlight(!chunk.is_highlighted)}
            title="Highlight"
            aria-label="Highlight"
          />
          <button className="row-icon-action delete" onClick={onDelete} title="Delete" aria-label="Delete" />
        </span>
      </div>
      <div className="text">{chunk.text}</div>
    </div>
  );
}

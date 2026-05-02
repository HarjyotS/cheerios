/**
 * Notes — a filesystem-style browser. Folders on the left (with nesting),
 * notes inside the selected folder on the right. Supports:
 *   - "All notes" view (flat list)
 *   - "Inbox" (notes with no folder)
 *   - Per-folder view
 *   - Creating / renaming / deleting folders (built-in folders are protected)
 *   - Drag a note onto a folder to move it
 *   - Single-click selects notes; double-click opens them
 */
import { useEffect, useMemo, useState } from 'react';
import type { Folder, Meeting } from '@shared/types/entities';
import { useStore } from '../store/store';
import { navigate, useRoute } from '../lib/router';
import { formatDateTime, sourceAppLabel } from '../lib/format';

type Selection =
  | { kind: 'all' }
  | { kind: 'inbox' }
  | { kind: 'folder'; id: string };

export function NotesView() {
  const folders = useStore((s) => s.folders);
  const meetings = useStore((s) => s.meetings);
  const refreshFolders = useStore((s) => s.actions.refreshFolders);
  const refreshMeetings = useStore((s) => s.actions.refreshMeetings);

  const route = useRoute();
  const initialSelection: Selection =
    route.path === '/notes/folder/:folderId' && route.params.folderId
      ? { kind: 'folder', id: route.params.folderId }
      : { kind: 'all' };

  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [creatingFolderUnder, setCreatingFolderUnder] = useState<string | null | false>(false);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    refreshFolders();
    refreshMeetings();
  }, [refreshFolders, refreshMeetings]);

  const filteredMeetings = useMemo(() => {
    switch (selection.kind) {
      case 'all':
        return meetings;
      case 'inbox':
        return meetings.filter((m) => !m.folder_id);
      case 'folder':
        return meetings.filter((m) => m.folder_id === selection.id);
    }
  }, [selection, meetings]);

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setCreatingFolderUnder(false);
      return;
    }
    const f = await window.api.folders.upsert({
      name,
      parent_id: typeof creatingFolderUnder === 'string' ? creatingFolderUnder : null,
    });
    setNewFolderName('');
    setCreatingFolderUnder(false);
    await refreshFolders();
    setSelection({ kind: 'folder', id: f.id });
  };

  const move = async (meetingId: string, folderId: string | null) => {
    try {
      await window.api.meetings.move(meetingId, folderId);
      refreshMeetings();
    } catch (err) {
      alert(`Move failed: ${(err as Error).message}`);
    }
  };

  const renameFolder = async (folder: Folder, name: string) => {
    if (!name.trim() || name === folder.name) return;
    await window.api.folders.upsert({ ...folder, name: name.trim() });
    refreshFolders();
  };

  const deleteFolder = async (folder: Folder) => {
    const childMeetings = meetings.filter((m) => m.folder_id === folder.id).length;
    const childFolders = folders.filter((f) => f.parent_id === folder.id).length;
    let confirmMsg = `Delete folder "${folder.name}"?`;
    if (childMeetings > 0 || childFolders > 0) {
      confirmMsg += `\n\n${childMeetings} note(s) and ${childFolders} sub-folder(s) inside will be moved to the inbox. The notes themselves are NOT deleted.`;
    }
    if (!confirm(confirmMsg)) return;
    await window.api.folders.delete(folder.id);
    await refreshFolders();
    await refreshMeetings();
    if (selection.kind === 'folder' && selection.id === folder.id) {
      setSelection({ kind: 'all' });
    }
  };

  const deleteMeeting = async (m: Meeting) => {
    if (!confirm(`Delete note "${m.title}"? This cannot be undone.`)) return;
    await window.api.meetings.delete(m.id);
    refreshMeetings();
  };

  const headerLabel =
    selection.kind === 'all'
      ? 'All notes'
      : selection.kind === 'inbox'
        ? 'Inbox'
        : folders.find((f) => f.id === selection.id)?.name ?? 'Folder';

  return (
    <>
      <div className="content-header notes-header">
        <div>
          <h1>{headerLabel}</h1>
          <div className="notes-header-meta">{filteredMeetings.length} notes</div>
        </div>
        <div className="actions">
          <button className="ghost" onClick={() => setCreatingFolderUnder(null)}>New folder</button>
        </div>
      </div>
      <div className="notes-shell">
        <FolderTree
          folders={folders}
          meetings={meetings}
          selection={selection}
          onSelect={setSelection}
          onMoveMeeting={move}
          onMoveFolderToInbox={async (m) => move(m.id, null)}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onCreateChild={(parentId) => setCreatingFolderUnder(parentId)}
          creatingUnder={creatingFolderUnder}
          newName={newFolderName}
          setNewName={setNewFolderName}
          onCommitNewFolder={createFolder}
          onCancelNewFolder={() => {
            setCreatingFolderUnder(false);
            setNewFolderName('');
          }}
        />
        <NoteList
          meetings={filteredMeetings}
          onOpen={(m) => navigate('/meeting/' + m.id)}
          onDelete={deleteMeeting}
          onMove={move}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Folder tree (left rail)
// ---------------------------------------------------------------------------

function FolderTree({
  folders,
  meetings,
  selection,
  onSelect,
  onMoveMeeting,
  onMoveFolderToInbox,
  onRenameFolder,
  onDeleteFolder,
  onCreateChild,
  creatingUnder,
  newName,
  setNewName,
  onCommitNewFolder,
  onCancelNewFolder,
}: {
  folders: Folder[];
  meetings: Meeting[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onMoveMeeting: (meetingId: string, folderId: string | null) => void;
  onMoveFolderToInbox: (m: Meeting) => void;
  onRenameFolder: (f: Folder, name: string) => void;
  onDeleteFolder: (f: Folder) => void;
  onCreateChild: (parentId: string | null) => void;
  creatingUnder: string | null | false;
  newName: string;
  setNewName: (s: string) => void;
  onCommitNewFolder: () => void;
  onCancelNewFolder: () => void;
}) {
  const childrenOf = (parentId: string | null) =>
    folders.filter((f) => (f.parent_id ?? null) === (parentId ?? null));

  const meetingsInFolder = (folderId: string) =>
    meetings.filter((m) => m.folder_id === folderId).length;

  // Drag-over state for visual highlight
  const [hoverDrop, setHoverDrop] = useState<string | 'inbox' | null>(null);

  const onDropMeeting = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const meetingId = e.dataTransfer.getData('application/x-pmos-meeting');
    if (meetingId) onMoveMeeting(meetingId, folderId);
    setHoverDrop(null);
  };
  const onDragOver = (e: React.DragEvent, key: string | 'inbox') => {
    if (Array.from(e.dataTransfer.types).includes('application/x-pmos-meeting')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setHoverDrop(key);
    }
  };
  const onDragLeave = () => setHoverDrop(null);

  const renderFolder = (folder: Folder, depth: number) => {
    const isActive = selection.kind === 'folder' && selection.id === folder.id;
    const count = meetingsInFolder(folder.id);
    const kids = childrenOf(folder.id);
    return (
      <div key={folder.id}>
        <FolderRow
          folder={folder}
          depth={depth}
          active={isActive}
          count={count}
          isDropTarget={hoverDrop === folder.id}
          onClick={() => onSelect({ kind: 'folder', id: folder.id })}
          onDragOver={(e) => onDragOver(e, folder.id)}
          onDragLeave={onDragLeave}
          onDrop={(e) => onDropMeeting(e, folder.id)}
          onRename={(name) => onRenameFolder(folder, name)}
          onDelete={() => onDeleteFolder(folder)}
          onCreateChild={() => onCreateChild(folder.id)}
        />
        {creatingUnder === folder.id && (
          <NewFolderInput
            depth={depth + 1}
            value={newName}
            onChange={setNewName}
            onCommit={onCommitNewFolder}
            onCancel={onCancelNewFolder}
          />
        )}
        {kids.map((k) => renderFolder(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="notes-tree">
      <div
        className={`folder-row ${selection.kind === 'all' ? 'active' : ''}`}
        onClick={() => onSelect({ kind: 'all' })}
      >
        <span className="folder-icon folder-icon-all" aria-hidden="true" />
        <span className="folder-name">All notes</span>
        <span className="folder-count">{meetings.length}</span>
      </div>
      <div
        className={`folder-row ${selection.kind === 'inbox' ? 'active' : ''} ${hoverDrop === 'inbox' ? 'drop-target' : ''}`}
        onClick={() => onSelect({ kind: 'inbox' })}
        onDragOver={(e) => onDragOver(e, 'inbox')}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDropMeeting(e, null)}
      >
        <span className="folder-icon folder-icon-inbox" aria-hidden="true" />
        <span className="folder-name">Inbox</span>
        <span className="folder-count">{meetings.filter((m) => !m.folder_id).length}</span>
      </div>
      <div className="folder-divider" />
      {childrenOf(null).map((f) => renderFolder(f, 0))}
      {creatingUnder === null && (
        <NewFolderInput
          depth={0}
          value={newName}
          onChange={setNewName}
          onCommit={onCommitNewFolder}
          onCancel={onCancelNewFolder}
        />
      )}
      {childrenOf(null).length === 0 && creatingUnder === false && (
        <div className="folder-empty">No folders yet. Use <strong>New folder</strong> to add one.</div>
      )}
    </div>
  );
}

function FolderRow({
  folder,
  depth,
  active,
  count,
  isDropTarget,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
  onCreateChild,
}: {
  folder: Folder;
  depth: number;
  active: boolean;
  count: number;
  isDropTarget: boolean;
  onClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onCreateChild: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  useEffect(() => {
    if (!editing) setName(folder.name);
  }, [editing, folder.name]);

  return (
    <div
      className={`folder-row ${active ? 'active' : ''} ${isDropTarget ? 'drop-target' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        } else if (e.key === 'F2') {
          e.preventDefault();
          setEditing(true);
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          onDelete();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="folder-icon folder-icon-folder" aria-hidden="true" />
      {editing ? (
        <input
          autoFocus
          className="folder-rename-input"
          value={name}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setEditing(false);
            onRename(name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditing(false);
              onRename(name);
            } else if (e.key === 'Escape') {
              setEditing(false);
              setName(folder.name);
            }
          }}
        />
      ) : (
        <span className="folder-name">{folder.name}</span>
      )}
      <span className="folder-count">{count}</span>
      <span
        className="folder-actions"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button className="row-icon-action add" title="New sub-folder" aria-label="New sub-folder" onClick={onCreateChild} />
        <button className="row-icon-action rename" title="Rename" aria-label="Rename" onClick={() => setEditing(true)} />
        <button className="row-icon-action delete" title="Delete" aria-label="Delete" onClick={onDelete} />
      </span>
    </div>
  );
}

function NewFolderInput({
  depth,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number;
  value: string;
  onChange: (s: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="folder-row new-folder" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="folder-icon folder-icon-folder" aria-hidden="true" />
      <input
        autoFocus
        className="folder-rename-input"
        placeholder="Folder name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit();
          else if (e.key === 'Escape') onCancel();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Note list (right pane)
// ---------------------------------------------------------------------------

function NoteList({
  meetings,
  onOpen,
  onDelete,
  onMove,
}: {
  meetings: Meeting[];
  onOpen: (m: Meeting) => void;
  onDelete: (m: Meeting) => void;
  onMove: (id: string, folderId: string | null) => void;
}) {
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNoteId && !meetings.some((m) => m.id === selectedNoteId)) {
      setSelectedNoteId(null);
    }
  }, [meetings, selectedNoteId]);

  if (meetings.length === 0) {
    return (
      <div className="notes-empty">
        <h3>No notes here</h3>
        <p>Drag a note in from another folder, or create a new note from Today.</p>
      </div>
    );
  }
  return (
    <div className="note-list">
      <div className="note-list-head">
        <span>{meetings.length} notes</span>
        <span>Latest first</span>
      </div>
      {meetings.map((m) => (
        <NoteRow
          key={m.id}
          meeting={m}
          selected={m.id === selectedNoteId}
          onSelect={() => setSelectedNoteId(m.id)}
          onOpen={onOpen}
          onDelete={onDelete}
          onMove={onMove}
        />
      ))}
    </div>
  );
}

function NoteRow({
  meeting,
  selected,
  onSelect,
  onOpen,
  onDelete,
}: {
  meeting: Meeting;
  selected: boolean;
  onSelect: () => void;
  onOpen: (m: Meeting) => void;
  onDelete: (m: Meeting) => void;
  onMove: (id: string, folderId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  useEffect(() => {
    if (!editing) setTitle(meeting.title);
  }, [meeting.title, editing]);

  const commitRename = async () => {
    const next = title.trim() || meeting.title;
    setEditing(false);
    if (next === meeting.title) return;
    try {
      await window.api.meetings.update(meeting.id, { title: next, title_is_auto: false });
    } catch {
      setTitle(meeting.title);
    }
  };

  return (
    <div
      className={`note-row ${selected ? 'selected' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pmos-meeting', meeting.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => {
        if (!editing) onSelect();
      }}
      onDoubleClick={() => {
        if (!editing) onOpen(meeting);
      }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen(meeting);
        } else if (e.key === 'F2') {
          e.preventDefault();
          setEditing(true);
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          onDelete(meeting);
        }
      }}
      role="button"
      tabIndex={0}
      aria-selected={selected}
    >
      <div className="note-row-icon" aria-hidden="true" />
      <div className="note-row-body">
        {editing ? (
          <input
            autoFocus
            className="row-title-edit"
            value={title}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') {
                setTitle(meeting.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div className="note-row-title">{meeting.title}</div>
        )}
        <div className="note-row-meta">
          {formatDateTime(meeting.started_at)} · {sourceAppLabel(meeting.source_app)}
        </div>
      </div>
      <div className="note-row-badges">
        {!meeting.ended_at && <span className="badge live">live</span>}
        {meeting.privacy_mode !== 'normal' && (
          <span className={`badge ${meeting.privacy_mode === 'private' ? 'private' : 'local'}`}>
            {meeting.privacy_mode}
          </span>
        )}
        {meeting.drive_sync_status === 'synced' && <span className="badge synced">drive</span>}
      </div>
      <div
        className="note-row-actions"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button className="row-icon-action rename" title="Rename" aria-label="Rename" onClick={() => setEditing(true)} />
        <button className="row-icon-action delete" title="Delete" aria-label="Delete" onClick={() => onDelete(meeting)} />
      </div>
    </div>
  );
}

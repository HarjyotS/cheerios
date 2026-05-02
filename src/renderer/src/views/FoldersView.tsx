import { useEffect, useState } from 'react';
import { useStore } from '../store/store';

export function FoldersView() {
  const folders = useStore((s) => s.folders);
  const refresh = useStore((s) => s.actions.refreshFolders);
  const [name, setName] = useState('');

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async () => {
    if (!name.trim()) return;
    await window.api.folders.upsert({ name: name.trim() });
    setName('');
    refresh();
  };

  const remove = async (id: string) => {
    await window.api.folders.delete(id);
    refresh();
  };

  return (
    <>
      <div className="content-header">
        <h1>Folders</h1>
      </div>
      <div className="content-body">
        <div className="row gap-8" style={{ marginBottom: 16 }}>
          <input placeholder="New folder name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="primary" onClick={create}>Create</button>
        </div>
        {folders.length === 0 && <div className="muted">No folders yet.</div>}
        {folders.map((f) => (
          <div key={f.id} className="list-row">
            <div className="col" style={{ flex: 1 }}>
              <div className="title">{f.name}</div>
              {f.drive_folder_id && <div className="meta">Drive id: {f.drive_folder_id}</div>}
            </div>
            <button className="danger" onClick={() => remove(f.id)}>Delete</button>
          </div>
        ))}
      </div>
    </>
  );
}

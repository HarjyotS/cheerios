import { useEffect, useState } from 'react';
import type { AutomationRule } from '@shared/types/entities';
import { useStore } from '../store/store';

export function AutomationsView() {
  const rules = useStore((s) => s.automations);
  const refresh = useStore((s) => s.actions.refreshAutomations);
  const [editing, setEditing] = useState<AutomationRule | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNew = () => {
    setEditing({
      id: '',
      name: 'New rule',
      trigger: 'meeting_notes_generated',
      conditions: [],
      actions: [],
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as AutomationRule);
  };

  const save = async (rule: AutomationRule) => {
    const saved = await window.api.automations.upsert(rule);
    setEditing(saved);
    refresh();
  };

  const remove = async (id: string) => {
    await window.api.automations.delete(id);
    setEditing(null);
    refresh();
  };

  return (
    <>
      <div className="content-header">
        <h1>Automations</h1>
        <div className="actions">
          <button className="primary" onClick={startNew}>+ Rule</button>
        </div>
      </div>
      <div className="split-view">
        <div className="split-list">
          {rules.length === 0 && <div className="muted small" style={{ padding: 16 }}>No rules yet.</div>}
          {rules.map((r) => (
            <div key={r.id} className={`list-row ${editing?.id === r.id ? 'selected' : ''}`} onClick={() => setEditing(r)}>
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{r.name}</div>
                <div className="meta">{r.trigger} · {r.enabled ? 'enabled' : 'disabled'}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {editing ? (
            <AutomationEditor rule={editing} onSave={save} onDelete={() => editing.id && remove(editing.id)} onChange={setEditing} />
          ) : (
            <div className="muted">Pick a rule or create a new one.</div>
          )}
        </div>
      </div>
    </>
  );
}

const TRIGGERS = [
  'meeting_created', 'meeting_ended', 'meeting_notes_generated',
  'action_item_detected', 'note_added_to_project',
  'person_detected', 'company_detected', 'keyword_detected', 'drive_sync_complete',
] as const;

function AutomationEditor({
  rule,
  onSave,
  onDelete,
  onChange,
}: {
  rule: AutomationRule;
  onSave: (r: AutomationRule) => void;
  onDelete: () => void;
  onChange: (r: AutomationRule) => void;
}) {
  return (
    <div className="col gap-16">
      <div className="row gap-8">
        <input
          value={rule.name}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
          placeholder="Rule name"
          style={{ flex: 1 }}
        />
        <label className="row gap-8 small">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          /> enabled
        </label>
      </div>
      <div className="col gap-8">
        <label>Trigger</label>
        <select value={rule.trigger} onChange={(e) => onChange({ ...rule, trigger: e.target.value as any })}>
          {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="col gap-8">
        <label>Conditions (JSON)</label>
        <textarea
          rows={6}
          value={JSON.stringify(rule.conditions, null, 2)}
          onChange={(e) => {
            try {
              onChange({ ...rule, conditions: JSON.parse(e.target.value) });
            } catch {
              // ignore until valid
            }
          }}
        />
      </div>
      <div className="col gap-8">
        <label>Actions (JSON)</label>
        <textarea
          rows={8}
          value={JSON.stringify(rule.actions, null, 2)}
          onChange={(e) => {
            try {
              onChange({ ...rule, actions: JSON.parse(e.target.value) });
            } catch {
              // ignore until valid
            }
          }}
        />
      </div>
      <div className="row gap-8">
        <button className="primary" onClick={() => onSave(rule)}>Save</button>
        {rule.id && <button className="danger" onClick={onDelete}>Delete</button>}
      </div>
    </div>
  );
}

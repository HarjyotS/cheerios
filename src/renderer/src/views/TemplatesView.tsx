import { useEffect, useState } from 'react';
import type { Template } from '@shared/types/entities';
import { useStore } from '../store/store';

export function TemplatesView() {
  const templates = useStore((s) => s.templates);
  const refresh = useStore((s) => s.actions.refreshTemplates);
  const [selected, setSelected] = useState<Template | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNew = () => {
    setSelected({
      id: '',
      name: 'New template',
      description: '',
      when_to_use: '',
      required_sections: ['Summary', 'Decisions', 'Action items'],
      optional_sections: [],
      formatting_rules: 'Concise bullets.',
      action_item_format: '- [ ] <task> — <owner>',
      follow_up_style: 'Brief recap.',
      auto_apply_rules: [],
      builtin: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setEditing(true);
  };

  return (
    <>
      <div className="content-header">
        <h1>Templates</h1>
        <div className="actions">
          <button className="primary" onClick={startNew}>+ Template</button>
        </div>
      </div>
      <div className="split-view">
        <div className="split-list">
          {templates.length === 0 && <div className="muted small" style={{ padding: 16 }}>No templates yet.</div>}
          {templates.map((t) => (
            <div
              key={t.id}
              className={`list-row ${selected?.id === t.id ? 'selected' : ''}`}
              onClick={() => { setSelected(t); setEditing(false); }}
            >
              <div className="col" style={{ flex: 1 }}>
                <div className="title">{t.name} {t.builtin && <span className="badge">built-in</span>}</div>
                <div className="meta">{t.description || t.when_to_use}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {selected ? (
            editing ? (
              <TemplateEditor
                template={selected}
                onSave={async (next) => {
                  const saved = await window.api.templates.upsert(next);
                  await refresh();
                  setSelected(saved);
                  setEditing(false);
                }}
                onCancel={() => {
                  setEditing(false);
                  if (!selected.id) setSelected(null);
                }}
              />
            ) : (
              <TemplateDetail
                template={selected}
                onEdit={() => setEditing(true)}
                onDelete={async () => {
                  if (!confirm(`Delete template "${selected.name}"?`)) return;
                  await window.api.templates.delete(selected.id);
                  await refresh();
                  setSelected(null);
                }}
              />
            )
          ) : (
            <div className="muted">Select a template to view it, or click <strong>+ Template</strong>.</div>
          )}
        </div>
      </div>
    </>
  );
}

function TemplateDetail({
  template,
  onEdit,
  onDelete,
}: {
  template: Template;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="col gap-16">
      <div className="row between">
        <div>
          <h2>{template.name}</h2>
          {template.builtin && <span className="badge">built-in</span>}
        </div>
        <div className="row gap-8">
          {!template.builtin && <button onClick={onEdit}>Edit</button>}
          {!template.builtin && <button className="danger" onClick={onDelete}>Delete</button>}
          {template.builtin && (
            <button onClick={onEdit} title="Built-in templates are read-only — use this to fork into a new editable copy">
              Fork
            </button>
          )}
        </div>
      </div>
      <div className="muted">{template.description}</div>
      <section>
        <h3>When to use</h3>
        <p>{template.when_to_use || '(no description)'}</p>
      </section>
      <section>
        <h3>Required sections</h3>
        <ul>{template.required_sections.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </section>
      {template.optional_sections.length > 0 && (
        <section>
          <h3>Optional sections</h3>
          <ul>{template.optional_sections.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
      )}
      <section>
        <h3>Formatting rules</h3>
        <pre className="md">{template.formatting_rules || '(default markdown bullets)'}</pre>
      </section>
      <section>
        <h3>Action item format</h3>
        <pre className="md">{template.action_item_format || '- [ ] <task> — <owner>'}</pre>
      </section>
      <section>
        <h3>Follow-up style</h3>
        <p>{template.follow_up_style || '(default)'}</p>
      </section>
      {template.auto_apply_rules.length > 0 && (
        <section>
          <h3>Auto-apply rules</h3>
          <pre className="md">{JSON.stringify(template.auto_apply_rules, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  onSave,
  onCancel,
}: {
  template: Template;
  onSave: (t: Template) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Template>(() => {
    // Forking a built-in: clone, drop id + builtin flag.
    if (template.builtin) {
      return { ...template, id: '', name: template.name + ' (copy)', builtin: false };
    }
    return { ...template };
  });
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<Template>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="col gap-16">
      <div className="row between">
        <h2>{template.builtin ? 'Fork built-in template' : template.id ? 'Edit template' : 'New template'}</h2>
        <div className="row gap-8">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={saving || !draft.name.trim()}
            onClick={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <label className="config-field">
        <div className="config-label">Name</div>
        <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label className="config-field">
        <div className="config-label">Description</div>
        <input value={draft.description} onChange={(e) => update({ description: e.target.value })} />
      </label>
      <label className="config-field">
        <div className="config-label">When to use</div>
        <input value={draft.when_to_use} onChange={(e) => update({ when_to_use: e.target.value })} />
      </label>
      <label className="config-field">
        <div className="config-label">Required sections (one per line)</div>
        <textarea
          rows={5}
          value={draft.required_sections.join('\n')}
          onChange={(e) => update({ required_sections: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
        />
      </label>
      <label className="config-field">
        <div className="config-label">Optional sections (one per line)</div>
        <textarea
          rows={4}
          value={draft.optional_sections.join('\n')}
          onChange={(e) => update({ optional_sections: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
        />
      </label>
      <label className="config-field">
        <div className="config-label">Formatting rules</div>
        <textarea
          rows={3}
          value={draft.formatting_rules}
          onChange={(e) => update({ formatting_rules: e.target.value })}
        />
      </label>
      <label className="config-field">
        <div className="config-label">Action item format</div>
        <input value={draft.action_item_format} onChange={(e) => update({ action_item_format: e.target.value })} />
      </label>
      <label className="config-field">
        <div className="config-label">Follow-up style</div>
        <input value={draft.follow_up_style} onChange={(e) => update({ follow_up_style: e.target.value })} />
      </label>
      <label className="config-field">
        <div className="config-label">Auto-apply rules (JSON)</div>
        <textarea
          rows={5}
          value={JSON.stringify(draft.auto_apply_rules, null, 2)}
          onChange={(e) => {
            try {
              update({ auto_apply_rules: JSON.parse(e.target.value) });
            } catch { /* ignore until valid */ }
          }}
        />
      </label>
    </div>
  );
}

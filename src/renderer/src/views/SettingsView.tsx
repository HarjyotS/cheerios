/**
 * Settings view. Renders all settings sections per spec §25.
 */
import { useEffect, useState } from 'react';
import type { Settings } from '@shared/types/entities';
import { useStore } from '../store/store';

type S = Settings;

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<S | null>(settings);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<string>('setup');

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (!draft) return <div className="content-body muted">Loading settings…</div>;

  const update = (patch: Partial<S>) => setDraft({ ...draft, ...patch });
  const save = async () => {
    setSaving(true);
    try {
      await window.api.settings.update(draft);
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    const fresh = await window.api.settings.reset();
    setDraft(fresh);
  };

  const SECTIONS = [
    { key: 'setup', label: 'Setup' },
    { key: 'recording', label: 'Recording' },
    { key: 'ai', label: 'AI Notes' },
    { key: 'calendar_drive', label: 'Calendar & Drive' },
    { key: 'privacy', label: 'Privacy' },
    { key: 'advanced', label: 'Advanced' },
  ];

  return (
    <>
      <div className="content-header">
        <h1>Settings</h1>
        <div className="actions">
          <button onClick={reset}>Reset</button>
          <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      <div className="settings-shell">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <div
              key={s.key}
              className={`settings-nav-item ${section === s.key ? 'active' : ''}`}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </div>
          ))}
        </nav>
        <div className="settings-body">
          {section === 'setup' && <SetupSection draft={draft} update={update} />}
          {section === 'recording' && (
            <>
              <DetectionSection draft={draft} update={update} />
              <TranscriptionSection draft={draft} update={update} advanced={draft.advanced_labs_enabled} />
            </>
          )}
          {section === 'ai' && <AISection draft={draft} update={update} />}
          {section === 'calendar_drive' && (
            <>
              <DriveSection draft={draft} update={update} advanced={draft.advanced_labs_enabled} />
              <IntegrationsSection mode="public" />
            </>
          )}
          {section === 'privacy' && <PrivacySection draft={draft} update={update} />}
          {section === 'advanced' && <AdvancedSection draft={draft} update={update} />}
        </div>
      </div>
    </>
  );
}

interface SP {
  draft: S;
  update: (p: Partial<S>) => void;
}

interface AdvancedSP extends SP {
  advanced?: boolean;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void) {
  return (
    <label className="row gap-8" style={{ padding: '6px 0' }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function num(label: string, value: number, onChange: (v: number) => void, suffix?: string) {
  return (
    <label className="row gap-8" style={{ padding: '6px 0' }}>
      <span style={{ minWidth: 240 }}>{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 100 }} />
      {suffix && <span className="muted small">{suffix}</span>}
    </label>
  );
}

function SetupSection({ draft, update }: SP) {
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<{ microphone: string; screen: string }>({
    microphone: 'unknown',
    screen: 'unknown',
  });

  const refresh = async () => {
    const [keys, perms] = await Promise.all([
      window.api.app.getKeyStatus().catch(() => ({})),
      window.api.app.getPermissionStatus().catch(() => ({ microphone: 'unknown', screen: 'unknown' })),
    ]);
    setKeyStatus(keys);
    setPermissions(perms);
  };

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  return (
    <>
      <div className="settings-section">
        <h3>Release setup</h3>
        <p>
          Public mode keeps the app focused on detecting meetings, recording mic audio,
          generating notes, search, and export. Labs features stay hidden until Advanced is enabled.
        </p>
        <div className="settings-status-grid">
          <StatusCard label="OpenAI" ok={Boolean(keyStatus.openai)} detail="Required for AI notes." />
          <StatusCard label="Deepgram" ok={Boolean(keyStatus.deepgram)} detail="Required for transcription." />
          <StatusCard label="Microphone" ok={permissions.microphone === 'granted'} detail={permissions.microphone} />
          <StatusCard label="Screen Recording" ok={permissions.screen === 'granted'} detail={`${permissions.screen} - optional`} />
        </div>
        <div className="row gap-8" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={refresh}>Refresh status</button>
          <button onClick={() => window.api.app.openSystemSettings('microphone')}>Open microphone settings</button>
          <button onClick={() => window.api.app.openSystemSettings('screen')}>Open screen settings</button>
        </div>
        {check('First-run setup completed', draft.setup_completed, (v) => update({ setup_completed: v }))}
      </div>
      <KeysSection mode="public" />
    </>
  );
}

function StatusCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="settings-status-card">
      <span className={`settings-status-dot ${ok ? 'ok' : 'warn'}`} />
      <div>
        <strong>{label}</strong>
        <span>{ok ? 'Ready' : detail}</span>
      </div>
    </div>
  );
}

function DetectionSection({ draft, update }: SP) {
  return (
    <div className="settings-section">
      <h3>Detect calls from</h3>
      {check('Zoom', draft.detect_zoom, (v) => update({ detect_zoom: v }))}
      {check('Google Meet', draft.detect_google_meet, (v) => update({ detect_google_meet: v }))}
      {check('Microsoft Teams', draft.detect_teams, (v) => update({ detect_teams: v }))}
      {check('Slack', draft.detect_slack, (v) => update({ detect_slack: v }))}
      {check('Webex', draft.detect_webex, (v) => update({ detect_webex: v }))}
      {check('Discord', draft.detect_discord, (v) => update({ detect_discord: v }))}
      {check('FaceTime', draft.detect_facetime, (v) => update({ detect_facetime: v }))}
      {check('Browser calls', draft.detect_browser_calls, (v) => update({ detect_browser_calls: v }))}

      <h3 style={{ marginTop: 24 }}>Auto-start</h3>
      <select
        value={draft.auto_start_mode}
        onChange={(e) => update({ auto_start_mode: e.target.value as S['auto_start_mode'] })}
      >
        <option value="never">Never</option>
        <option value="ask">Ask me every time</option>
        <option value="calendar">Calendar meetings only</option>
        <option value="known_apps">Known meeting apps</option>
        <option value="all">All detected calls</option>
      </select>

      <h3 style={{ marginTop: 24 }}>Auto-stop</h3>
      {check('Stop when call ends', draft.auto_stop_on_call_end, (v) => update({ auto_stop_on_call_end: v }))}
      {check('Stop when calendar event ends', draft.auto_stop_on_calendar_end, (v) => update({ auto_stop_on_calendar_end: v }))}
      {num('Stop after silence', draft.auto_stop_after_silence_minutes, (v) => update({ auto_stop_after_silence_minutes: v }), 'minutes')}
      {num('Max meeting duration', draft.max_meeting_duration_minutes, (v) => update({ max_meeting_duration_minutes: v }), 'minutes')}
    </div>
  );
}

function TranscriptionSection({ draft, update, advanced }: AdvancedSP) {
  return (
    <div className="settings-section">
      <h3>Deepgram</h3>
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Model</span>
        <select value={draft.deepgram_model} onChange={(e) => update({ deepgram_model: e.target.value as S['deepgram_model'] })}>
          <option value="nova-3">Nova-3 (best)</option>
          <option value="nova-2">Nova-2</option>
          <option value="enhanced">Enhanced (cheaper)</option>
        </select>
      </label>
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Language</span>
        <input value={draft.deepgram_language} onChange={(e) => update({ deepgram_language: e.target.value })} />
      </label>
      {check('Smart format', draft.deepgram_smart_format, (v) => update({ deepgram_smart_format: v }))}
      {check('Diarize', draft.deepgram_diarize, (v) => update({ deepgram_diarize: v }))}
      {check('Multi-channel (mic + system separately)', draft.deepgram_multichannel, (v) => update({ deepgram_multichannel: v }))}
      {check('Store audio (off by default)', draft.store_audio, (v) => update({ store_audio: v }))}

      {advanced && (
        <>
          <h3 style={{ marginTop: 24 }}>Usage caps</h3>
          {num('Daily limit', draft.daily_transcription_limit_minutes, (v) => update({ daily_transcription_limit_minutes: v }), 'minutes')}
          {num('Monthly soft warning', draft.monthly_transcription_warn_minutes, (v) => update({ monthly_transcription_warn_minutes: v }), 'minutes')}
          {num('Monthly hard stop', draft.monthly_transcription_hard_stop_minutes, (v) => update({ monthly_transcription_hard_stop_minutes: v }), 'minutes')}

          <h3 style={{ marginTop: 24 }}>Redaction (sensitive mode)</h3>
          <p className="muted small">Comma-separated. Examples: pii, numbers, emails, phone, credit_card</p>
          <input
            value={draft.deepgram_redact.join(',')}
            onChange={(e) => update({ deepgram_redact: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
            style={{ width: '100%' }}
          />
        </>
      )}
    </div>
  );
}

function AISection({ draft, update }: SP) {
  return (
    <div className="settings-section">
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Default note style</span>
        <select value={draft.default_note_style} onChange={(e) => update({ default_note_style: e.target.value as S['default_note_style'] })}>
          <option value="short">Short</option>
          <option value="medium">Medium</option>
          <option value="detailed">Detailed</option>
        </select>
      </label>
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Tone</span>
        <select value={draft.default_note_tone} onChange={(e) => update({ default_note_tone: e.target.value as S['default_note_tone'] })}>
          <option value="clean">Clean</option>
          <option value="direct">Direct</option>
          <option value="executive">Executive</option>
          <option value="casual">Casual</option>
          <option value="technical">Technical</option>
        </select>
      </label>
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Format</span>
        <select value={draft.default_note_format} onChange={(e) => update({ default_note_format: e.target.value as S['default_note_format'] })}>
          <option value="bullets">Bullets</option>
          <option value="narrative">Narrative</option>
          <option value="table">Table</option>
          {(draft.advanced_labs_enabled || draft.default_note_format === 'product_spec') && (
            <option value="product_spec">Product spec (Labs)</option>
          )}
          <option value="crm">CRM-style</option>
          <option value="research">Research notes</option>
        </select>
      </label>
      {check('Treat raw notes as priority signal', draft.raw_notes_priority, (v) => update({ raw_notes_priority: v }))}
      {check('Include previous-meeting context', draft.include_previous_meeting_context, (v) => update({ include_previous_meeting_context: v }))}
    </div>
  );
}

function DriveSection({ draft, update, advanced }: AdvancedSP) {
  return (
    <div className="settings-section">
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Sync mode</span>
        <select value={draft.drive_sync_mode} onChange={(e) => update({ drive_sync_mode: e.target.value as S['drive_sync_mode'] })}>
          <option value="off">Off</option>
          <option value="ask">Ask after each meeting</option>
          <option value="all">Sync all meetings</option>
          <option value="selected">Sync only selected</option>
        </select>
      </label>
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Folder strategy</span>
        <select value={draft.drive_folder_strategy} onChange={(e) => update({ drive_folder_strategy: e.target.value as S['drive_folder_strategy'] })}>
          <option value="date">By date</option>
          {(advanced || draft.drive_folder_strategy === 'project') && <option value="project">By project</option>}
          {(advanced || draft.drive_folder_strategy === 'person') && <option value="person">By person</option>}
          {(advanced || draft.drive_folder_strategy === 'company') && <option value="company">By company</option>}
          <option value="hybrid">Hybrid (recommended)</option>
        </select>
      </label>
      <div style={{ padding: '6px 0' }}>
        <span style={{ display: 'block', marginBottom: 4 }}>Export formats</span>
        {(['google_doc', 'markdown', 'pdf', 'json', 'txt'] as const).map((f) => (
          <label key={f} className="row gap-8" style={{ paddingLeft: 16 }}>
            <input
              type="checkbox"
              checked={draft.drive_export_formats.includes(f)}
              onChange={(e) => {
                const set = new Set(draft.drive_export_formats);
                if (e.target.checked) set.add(f); else set.delete(f);
                update({ drive_export_formats: [...set] });
              }}
            /> {f}
          </label>
        ))}
      </div>
      {advanced && check('Two-way sync (advanced)', draft.drive_two_way_sync, (v) => update({ drive_two_way_sync: v }))}
    </div>
  );
}

function PrivacySection({ draft, update }: SP) {
  return (
    <div className="settings-section">
      <label className="row gap-8" style={{ padding: '6px 0' }}>
        <span style={{ minWidth: 240 }}>Default privacy mode</span>
        <select value={draft.default_privacy_mode} onChange={(e) => update({ default_privacy_mode: e.target.value as S['default_privacy_mode'] })}>
          <option value="normal">Normal</option>
          <option value="private">Private</option>
          <option value="local_only">Local only</option>
          <option value="sensitive">Sensitive</option>
        </select>
      </label>
      {check('Hide sensitive meeting titles', draft.hide_sensitive_titles, (v) => update({ hide_sensitive_titles: v }))}
      {check('Hide notification previews', draft.hide_notification_previews, (v) => update({ hide_notification_previews: v }))}
      {check('Enable App Lock', draft.app_lock_enabled, (v) => update({ app_lock_enabled: v }))}
      {num('Lock after inactivity', draft.app_lock_inactivity_minutes, (v) => update({ app_lock_inactivity_minutes: v }), 'minutes')}
    </div>
  );
}

function RetentionSection({ draft, update }: SP) {
  return (
    <div className="settings-section">
      {check('Keep summaries forever', draft.keep_summaries_forever, (v) => update({ keep_summaries_forever: v }))}
      {num('Delete transcripts after', draft.delete_transcripts_after_days ?? 0, (v) => update({ delete_transcripts_after_days: v || null }), 'days (0 = keep forever)')}
      {num('Delete private meetings after', draft.delete_private_meetings_after_days ?? 0, (v) => update({ delete_private_meetings_after_days: v || null }), 'days')}
      <h3 style={{ marginTop: 24 }}>Danger zone</h3>
      <div className="row gap-8">
        <button onClick={() => window.api.app.exportAllData().then((r) => alert('Exported to ' + r.path))}>Export all data</button>
        <button className="danger" onClick={() => {
          if (confirm('Delete ALL local data? This cannot be undone.')) window.api.app.deleteAllData();
        }}>Delete all data</button>
      </div>
    </div>
  );
}

function ApiSection({ draft, update }: SP) {
  return (
    <div className="settings-section">
      <h3>Local HTTP API</h3>
      {check('Enable local API', draft.local_api_enabled, (v) => update({ local_api_enabled: v }))}
      {num('Port', draft.local_api_port, (v) => update({ local_api_port: v }))}
      <p className="muted small">Token is stored in your keychain (key: localapi.token). Check the app log on first start.</p>

      <h3 style={{ marginTop: 24 }}>MCP server</h3>
      {check('Enable MCP server', draft.mcp_enabled, (v) => update({ mcp_enabled: v }))}
      {check('Disable transcript access via MCP', draft.mcp_disable_transcript_access, (v) => update({ mcp_disable_transcript_access: v }))}
      {check('Hide private meetings from MCP', draft.mcp_disable_private_notes, (v) => update({ mcp_disable_private_notes: v }))}
    </div>
  );
}

function AdvancedSection({ draft, update }: SP) {
  return (
    <>
      <div className="settings-section">
        <h3>Advanced / Labs</h3>
        <p>
          Enables broader personal-knowledge features and lower-level configuration.
          Keep this off for the public meeting-notetaker experience.
        </p>
        {check('Show Advanced / Labs features', draft.advanced_labs_enabled, (v) => update({ advanced_labs_enabled: v }))}
      </div>
      {draft.advanced_labs_enabled && (
        <>
          <div className="settings-section">
            <h3>AI model</h3>
            <label className="row gap-8" style={{ padding: '6px 0' }}>
              <span style={{ minWidth: 240 }}>Model</span>
              <input value={draft.ai_model} onChange={(e) => update({ ai_model: e.target.value })} />
            </label>
            {check('Show lower-confidence mic-only detection prompts', draft.show_low_confidence_detection, (v) => update({ show_low_confidence_detection: v }))}
          </div>
          <KeysSection mode="advanced" />
          <IntegrationsSection mode="advanced" />
          <RetentionSection draft={draft} update={update} />
          <ApiSection draft={draft} update={update} />
        </>
      )}
    </>
  );
}

// Map kind → which extra config fields to expose (config is stored as JSON on the row).
const INTEGRATION_CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; placeholder?: string; hint?: string }>> = {
  linear: [
    { key: 'team_id', label: 'Team ID', placeholder: 'e.g. abcd1234-...', hint: 'Found in Linear settings → API. Leave blank to use the first team.' },
  ],
  notion: [
    { key: 'database_id', label: 'Database ID', placeholder: '32-char id', hint: 'Open the database in Notion → Share → copy the URL; the id is the 32-char hex segment.' },
  ],
  asana: [
    { key: 'workspace_id', label: 'Workspace ID', placeholder: 'numeric id' },
    { key: 'project_id', label: 'Project ID', placeholder: 'numeric id', hint: 'Action items will be created in this project.' },
  ],
  webhook: [
    { key: 'url', label: 'Webhook URL', placeholder: 'https://...', hint: 'Where automation rules will POST.' },
    { key: 'secret', label: 'Shared secret (optional)', placeholder: '...', hint: 'Used to sign payloads with HMAC-SHA256.' },
  ],
};

const OAUTH_KINDS = new Set(['google_drive', 'google_calendar', 'gmail', 'google_contacts', 'google_tasks']);

function IntegrationsSection({ mode = 'all' }: { mode?: 'public' | 'advanced' | 'all' }) {
  const [list, setList] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [configDrafts, setConfigDrafts] = useState<Record<string, Record<string, string>>>({});

  const refresh = async () => {
    const next = await window.api.integrations.list();
    setList(next);
    setConfigDrafts((prev) => {
      const out: Record<string, Record<string, string>> = { ...prev };
      for (const i of next) {
        if (!out[i.kind]) {
          const defaults: Record<string, string> = {};
          for (const f of INTEGRATION_CONFIG_FIELDS[i.kind] ?? []) {
            defaults[f.key] = ((i.config?.[f.key] as string | undefined) ?? '');
          }
          out[i.kind] = defaults;
        }
      }
      return out;
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  const authorize = async (kind: string) => {
    setBusy(kind);
    try {
      const r = await window.api.integrations.authorize(kind as any);
      if (!r.ok) alert(`Connect ${kind} failed: ${r.error}`);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (kind: string) => {
    if (!confirm(`Disconnect ${kind}?`)) return;
    setBusy(kind);
    try {
      await window.api.integrations.disconnect(kind as any);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async (kind: string) => {
    setBusy(kind);
    try {
      const config = configDrafts[kind] ?? {};
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        const t = (v ?? '').trim();
        if (t) cleaned[k] = t;
      }
      await window.api.integrations.setConfig(kind as any, cleaned);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-section">
      <h3>Connected services</h3>
      {mode === 'public' ? (
        <p>
          Calendar helps detect scheduled meetings. Drive is optional for export and sharing.
          Add your Google OAuth client ID and secret in Setup before connecting.
        </p>
      ) : (
        <p>
          Labs integrations authenticate via OAuth or API keys. Some rows expose extra config
          such as team, database, workspace, or webhook IDs.
        </p>
      )}
      {list.filter((i) => {
        if (mode === 'all') return true;
        const publicKinds = new Set(['google_calendar', 'google_drive']);
        return mode === 'public' ? publicKinds.has(i.kind) : !publicKinds.has(i.kind);
      }).map((i) => {
        const oauth = OAUTH_KINDS.has(i.kind);
        const fields = INTEGRATION_CONFIG_FIELDS[i.kind];
        const draft = configDrafts[i.kind] ?? {};
        return (
          <div key={i.id} className="integration-row">
            <div className="integration-row-head">
              <div className="col">
                <div className="integration-name">{i.name}</div>
                <div className="muted small">
                  <span className={`status-dot ${i.status}`} /> {i.status}
                  {i.account_email && ` · ${i.account_email}`}
                  {i.last_synced_at && ` · synced ${new Date(i.last_synced_at).toLocaleTimeString()}`}
                  {i.error_message && <span className="error-inline"> · {i.error_message}</span>}
                </div>
              </div>
              <div className="row gap-8">
                {oauth ? (
                  i.status === 'connected' ? (
                    <>
                      <button onClick={() => authorize(i.kind)} disabled={busy === i.kind}>
                        {busy === i.kind ? '…' : 'Reconnect'}
                      </button>
                      <button className="danger" onClick={() => disconnect(i.kind)} disabled={busy === i.kind}>
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button className="primary" onClick={() => authorize(i.kind)} disabled={busy === i.kind}>
                      {busy === i.kind ? 'Connecting…' : 'Connect'}
                    </button>
                  )
                ) : (
                  <span className="muted small">via API key</span>
                )}
                <label className="row gap-8 small">
                  <input
                    type="checkbox"
                    checked={i.enabled}
                    onChange={(e) =>
                      window.api.integrations.setEnabled(i.kind, e.target.checked).then(refresh)
                    }
                  />{' '}
                  enabled
                </label>
              </div>
            </div>
            {fields && fields.length > 0 && (
              <div className="integration-config">
                {fields.map((f) => (
                  <label key={f.key} className="config-field">
                    <div className="config-label">{f.label}</div>
                    {f.hint && <div className="muted tiny">{f.hint}</div>}
                    <input
                      value={draft[f.key] ?? ''}
                      onChange={(e) =>
                        setConfigDrafts((prev) => ({
                          ...prev,
                          [i.kind]: { ...(prev[i.kind] ?? {}), [f.key]: e.target.value },
                        }))
                      }
                      placeholder={f.placeholder}
                    />
                  </label>
                ))}
                <div>
                  <button
                    className="primary"
                    onClick={() => saveConfig(i.kind)}
                    disabled={busy === i.kind}
                  >
                    {busy === i.kind ? 'Saving…' : 'Save config'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface KeyMeta {
  name: string;
  label: string;
  hint: string;
  placeholder: string;
}

const KEY_FIELDS: KeyMeta[] = [
  {
    name: 'openai',
    label: 'OpenAI API key',
    hint: 'Required for AI notes and search. Defaults to the configured model in Advanced.',
    placeholder: 'sk-...',
  },
  {
    name: 'deepgram',
    label: 'Deepgram API key',
    hint: 'Required for live transcription. Sign up at deepgram.com.',
    placeholder: 'dg-...',
  },
  {
    name: 'google_client_id',
    label: 'Google OAuth client ID',
    hint: 'Optional for Calendar and Drive. Create at console.cloud.google.com under "OAuth 2.0 Client IDs".',
    placeholder: '...apps.googleusercontent.com',
  },
  {
    name: 'google_client_secret',
    label: 'Google OAuth client secret',
    hint: 'Pairs with the client ID above.',
    placeholder: 'GOCSPX-...',
  },
  {
    name: 'todoist',
    label: 'Todoist API token',
    hint: 'Optional — needed only if you sync action items to Todoist.',
    placeholder: '...',
  },
  {
    name: 'linear',
    label: 'Linear API key',
    hint: 'Optional — needed only if you sync action items to Linear.',
    placeholder: 'lin_api_...',
  },
  {
    name: 'notion',
    label: 'Notion integration token',
    hint: 'Optional — needed only if you push action items to a Notion database.',
    placeholder: 'secret_...',
  },
  {
    name: 'asana',
    label: 'Asana token',
    hint: 'Optional — needed only if you sync action items to Asana.',
    placeholder: '...',
  },
  {
    name: 'slack',
    label: 'Slack token / webhook URL',
    hint: 'Optional — used by automations to post to Slack.',
    placeholder: 'xoxb-... or https://hooks.slack.com/...',
  },
];

const PUBLIC_KEY_NAMES = new Set(['openai', 'deepgram', 'google_client_id', 'google_client_secret']);

function KeysSection({ mode = 'public' }: { mode?: 'public' | 'advanced' | 'all' }) {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingName, setSavingName] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await window.api.app.getKeyStatus());
    } catch {
      setStatus({});
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const save = async (name: string) => {
    setSavingName(name);
    try {
      await window.api.app.setKey(name, drafts[name] ?? '');
      setDrafts((d) => ({ ...d, [name]: '' }));
      await refresh();
    } catch (err) {
      alert(`Saving ${name} failed: ${(err as Error).message}`);
    } finally {
      setSavingName(null);
    }
  };

  const clearKey = async (name: string) => {
    if (!confirm(`Clear the saved ${name} key?`)) return;
    setSavingName(name);
    try {
      await window.api.app.setKey(name, '');
      await refresh();
    } finally {
      setSavingName(null);
    }
  };

  return (
    <div className="settings-section">
      <h3>{mode === 'advanced' ? 'Labs API keys' : 'API keys'}</h3>
      <p>
        Keys are stored in the macOS keychain - never on disk in plaintext, never sent to anyone but the
        provider you set them for. After saving a key, the corresponding feature lights up immediately.
      </p>
      {KEY_FIELDS.filter((f) => {
        if (mode === 'all') return true;
        const isPublic = PUBLIC_KEY_NAMES.has(f.name);
        return mode === 'public' ? isPublic : !isPublic;
      }).map((f) => (
        <div key={f.name} className="key-row">
          <div className="key-row-head">
            <div className="key-row-label">
              {f.label}
              {status[f.name] && <span className="badge synced" style={{ marginLeft: 8 }}>set</span>}
            </div>
            {status[f.name] && (
              <button className="danger" onClick={() => clearKey(f.name)} disabled={savingName === f.name}>
                Clear
              </button>
            )}
          </div>
          <div className="key-row-hint">{f.hint}</div>
          <div className="key-row-controls">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status[f.name] ? '•••••••• (saved — paste to replace)' : f.placeholder}
              value={drafts[f.name] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [f.name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(f.name);
              }}
            />
            <button
              className="primary"
              onClick={() => save(f.name)}
              disabled={savingName === f.name || !(drafts[f.name] ?? '').trim()}
            >
              {savingName === f.name ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

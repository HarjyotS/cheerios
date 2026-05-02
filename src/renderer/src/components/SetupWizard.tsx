import { useEffect, useMemo, useState } from 'react';
import { audioController } from '../audio/AudioController';
import { navigate } from '../lib/router';

type PermissionStatus = { microphone: string; screen: string };

interface KeyStatus {
  openai?: boolean;
  deepgram?: boolean;
  google_client_id?: boolean;
  google_client_secret?: boolean;
}

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [permissions, setPermissions] = useState<PermissionStatus>({ microphone: 'unknown', screen: 'unknown' });
  const [keys, setKeys] = useState<KeyStatus>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    const [perm, keyStatus] = await Promise.all([
      window.api.app.getPermissionStatus().catch(() => ({ microphone: 'unknown', screen: 'unknown' })),
      window.api.app.getKeyStatus().catch(() => ({})),
    ]);
    setPermissions(perm);
    setKeys(keyStatus);
  };

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  const openaiReady = Boolean(keys.openai) || looksLikeOpenAI(drafts.openai);
  const deepgramReady = Boolean(keys.deepgram) || looksLikeDeepgram(drafts.deepgram);
  const requiredReady = openaiReady && deepgramReady;

  const saveKey = async (name: 'openai' | 'deepgram' | 'google_client_id' | 'google_client_secret') => {
    const value = (drafts[name] ?? '').trim();
    if (!value) return;
    setBusy(name);
    setErr(null);
    try {
      await window.api.app.setKey(name, value);
      setDrafts((d) => ({ ...d, [name]: '' }));
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const connectGoogle = async (kind: 'google_calendar' | 'google_drive') => {
    setBusy(kind);
    setErr(null);
    try {
      const result = await window.api.integrations.authorize(kind);
      if (!result?.ok) setErr(result?.error ?? `Could not connect ${kind}.`);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finish = async (startTest = false) => {
    setBusy('finish');
    setErr(null);
    try {
      await window.api.settings.update({ setup_completed: true });
      if (startTest) {
        await audioController.stopAnyActive();
        const m = await window.api.meetings.create({
          title: 'Test note',
          source_app: 'unknown',
          privacy_mode: 'normal',
        });
        await window.api.meetings.start(m.id).catch(() => undefined);
        audioController.startMicForMeeting(m.id).catch(() => undefined);
        navigate('/meeting/' + m.id);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const steps = useMemo(
    () => [
      { label: 'Privacy' },
      { label: 'Permissions' },
      { label: 'API keys' },
      { label: 'Calendar & Drive' },
      { label: 'Finish' },
    ],
    [],
  );

  return (
    <div className="setup-screen">
      <div className="setup-panel">
        <div className="setup-kicker">Welcome</div>
        <h1>Set up your meeting notetaker</h1>
        <div className="setup-steps" aria-label="Setup progress">
          {steps.map((s, i) => (
            <button
              key={s.label}
              className={`setup-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => setStep(i)}
            >
              <span>{i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>

        <div className="setup-card">
          {step === 0 && (
            <>
              <h2>What this app records</h2>
              <p>
                The app creates local meeting notes from your microphone and, if you turn it on,
                system audio. Audio is streamed only to the transcription provider you configure.
              </p>
              <div className="setup-grid">
                <SetupFact title="Stored locally" body="Notes, transcripts, settings, and metadata live on this Mac." />
                <SetupFact title="Sent to your providers" body="Mic/system audio goes to Deepgram. Transcripts and raw notes go to OpenAI for AI notes." />
                <SetupFact title="Optional sync" body="Calendar and Drive are optional. You can connect them later." />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2>Permissions</h2>
              <p>Microphone is required. Screen Recording is optional and only needed for system audio.</p>
              <StatusRow
                label="Microphone"
                status={permissions.microphone}
                detail="Required to capture your voice."
                actionLabel="Open microphone settings"
                onAction={() => window.api.app.openSystemSettings('microphone')}
              />
              <StatusRow
                label="Screen Recording"
                status={permissions.screen}
                detail="Optional. Needed to capture audio from Meet, Zoom, Teams, and browser tabs."
                actionLabel="Open screen settings"
                onAction={() => window.api.app.openSystemSettings('screen')}
              />
              <button onClick={refresh}>Refresh permission status</button>
            </>
          )}

          {step === 2 && (
            <>
              <h2>Bring your own keys</h2>
              <p>These are stored in your macOS Keychain. The app does not include hosted credits.</p>
              <KeyInput
                label="OpenAI API key"
                name="openai"
                saved={Boolean(keys.openai)}
                value={drafts.openai ?? ''}
                valid={openaiReady}
                placeholder="sk-..."
                busy={busy === 'openai'}
                onChange={(v) => setDrafts((d) => ({ ...d, openai: v }))}
                onSave={() => saveKey('openai')}
              />
              <KeyInput
                label="Deepgram API key"
                name="deepgram"
                saved={Boolean(keys.deepgram)}
                value={drafts.deepgram ?? ''}
                valid={deepgramReady}
                placeholder="dg-..."
                busy={busy === 'deepgram'}
                onChange={(v) => setDrafts((d) => ({ ...d, deepgram: v }))}
                onSave={() => saveKey('deepgram')}
              />
            </>
          )}

          {step === 3 && (
            <>
              <h2>Optional Calendar & Drive</h2>
              <p>Connect Google later if you only want local notes for now.</p>
              <KeyInput
                label="Google OAuth client ID"
                name="google_client_id"
                saved={Boolean(keys.google_client_id)}
                value={drafts.google_client_id ?? ''}
                valid={Boolean(keys.google_client_id) || drafts.google_client_id?.includes('.apps.googleusercontent.com')}
                placeholder="...apps.googleusercontent.com"
                busy={busy === 'google_client_id'}
                onChange={(v) => setDrafts((d) => ({ ...d, google_client_id: v }))}
                onSave={() => saveKey('google_client_id')}
              />
              <KeyInput
                label="Google OAuth client secret"
                name="google_client_secret"
                saved={Boolean(keys.google_client_secret)}
                value={drafts.google_client_secret ?? ''}
                valid={Boolean(keys.google_client_secret) || (drafts.google_client_secret ?? '').length > 6}
                placeholder="GOCSPX-..."
                busy={busy === 'google_client_secret'}
                onChange={(v) => setDrafts((d) => ({ ...d, google_client_secret: v }))}
                onSave={() => saveKey('google_client_secret')}
              />
              <div className="row gap-8" style={{ marginTop: 12 }}>
                <button onClick={() => connectGoogle('google_calendar')} disabled={busy != null}>
                  {busy === 'google_calendar' ? 'Connecting...' : 'Connect Calendar'}
                </button>
                <button onClick={() => connectGoogle('google_drive')} disabled={busy != null}>
                  {busy === 'google_drive' ? 'Connecting...' : 'Connect Drive'}
                </button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h2>Ready to record</h2>
              <p>
                Start with a short test note. You should see transcript activity while speaking,
                then AI notes after stopping.
              </p>
              <div className="setup-grid">
                <SetupFact title="Start note" body="Creates a local note and starts microphone capture." />
                <SetupFact title="System audio" body="Turn it on inside a note when you need the other side of a call." />
                <SetupFact title="Recoverable" body="You can retry AI notes if a provider key or network call fails." />
              </div>
            </>
          )}

          {err && <div className="error setup-error">{err}</div>}
        </div>

        <div className="setup-footer">
          <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</button>
          <div className="spacer" />
          {step < steps.length - 1 ? (
            <button
              className="primary"
              onClick={() => setStep(Math.min(steps.length - 1, step + 1))}
              disabled={step === 2 && !requiredReady}
            >
              Continue
            </button>
          ) : (
            <>
              <button onClick={() => finish(false)} disabled={busy === 'finish'}>Finish setup</button>
              <button className="primary" onClick={() => finish(true)} disabled={busy === 'finish'}>
                {busy === 'finish' ? 'Starting...' : 'Start test note'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupFact({ title, body }: { title: string; body: string }) {
  return (
    <div className="setup-fact">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function StatusRow({
  label,
  status,
  detail,
  actionLabel,
  onAction,
}: {
  label: string;
  status: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const ok = status === 'granted';
  return (
    <div className="setup-status-row">
      <div>
        <div className="row gap-8">
          <span className={`setup-status-dot ${ok ? 'ok' : 'warn'}`} />
          <strong>{label}</strong>
          <span className="muted small">{status}</span>
        </div>
        <div className="muted small">{detail}</div>
      </div>
      {!ok && <button onClick={onAction}>{actionLabel}</button>}
    </div>
  );
}

function KeyInput({
  label,
  saved,
  value,
  valid,
  placeholder,
  busy,
  onChange,
  onSave,
}: {
  label: string;
  name: string;
  saved: boolean;
  value: string;
  valid: boolean;
  placeholder: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="setup-key-row">
      <label>
        <span>{label}</span>
        {saved && <em>saved</em>}
        {!saved && value && <em className={valid ? 'ok' : 'warn'}>{valid ? 'looks valid' : 'check format'}</em>}
      </label>
      <div className="row gap-8">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? 'Saved - paste a new value to replace' : placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
          }}
        />
        <button onClick={onSave} disabled={busy || !value.trim()}>
          {busy ? 'Saving...' : saved ? 'Replace' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function looksLikeOpenAI(value?: string): boolean {
  const v = (value ?? '').trim();
  return /^sk-/.test(v) && v.length > 20;
}

function looksLikeDeepgram(value?: string): boolean {
  const v = (value ?? '').trim();
  return v.length > 20;
}

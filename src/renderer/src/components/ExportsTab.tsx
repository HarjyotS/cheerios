import { useState } from 'react';
import type { Meeting } from '@shared/types/entities';

export function ExportsTab({ meeting }: { meeting: Meeting }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sync = async (formats?: any[]) => {
    setBusy(true);
    setErr(null);
    try {
      await window.api.drive.syncMeeting(meeting.id, formats);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const open = () => window.api.drive.openInDrive(meeting.id).catch(console.error);
  const draft = async (kind: any) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await window.api.gmail.draftFollowUp(meeting.id, kind);
      window.open(r.url, '_blank');
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="exports-tab">
      <section className="card">
        <div className="card-title">Google Drive</div>
        <div className="muted small">
          Status: <strong>{meeting.drive_sync_status}</strong>
        </div>
        <div className="row gap-8" style={{ marginTop: 8 }}>
          <button className="primary" onClick={() => sync()} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
          <button onClick={() => sync(['google_doc', 'markdown', 'pdf', 'json', 'txt'])} disabled={busy}>
            Sync all formats
          </button>
          {meeting.drive_file_ids?.google_doc && (
            <button onClick={open}>Open in Drive</button>
          )}
        </div>
      </section>
      <section className="card">
        <div className="card-title">Gmail follow-up draft</div>
        <div className="row gap-8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button onClick={() => draft('thank_you')} disabled={busy}>Thank-you</button>
          <button onClick={() => draft('sales')} disabled={busy}>Sales</button>
          <button onClick={() => draft('investor')} disabled={busy}>Investor</button>
          <button onClick={() => draft('research')} disabled={busy}>Research</button>
          <button onClick={() => draft('recruiting')} disabled={busy}>Recruiting</button>
          <button onClick={() => draft('recap')} disabled={busy}>Recap</button>
          <button onClick={() => draft('intro')} disabled={busy}>Intro</button>
        </div>
      </section>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

import { useStore } from '../store/store';
import { sourceAppLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { audioController } from '../audio/AudioController';

export function DetectionPrompt() {
  const detection = useStore((s) => s.detection);
  if (!detection) return null;

  const start = async () => {
    try {
      const m = await window.api.meetings.create({
        title: detection.title || 'Meeting',
        source_app: detection.source_app,
        privacy_mode: 'normal',
      });
      await window.api.meetings.start(m.id);
      audioController.startMicForMeeting(m.id).catch(() => undefined);
      navigate('/meeting/' + m.id);
    } catch (err) {
      console.error('Failed to start meeting', err);
    }
  };

  const ignoreOnce = () => {
    window.api.detection.ignoreOnce(detection).catch(() => undefined);
  };
  const alwaysStart = () => {
    window.api.detection.alwaysStartFor({ source_app: detection.source_app }).catch(() => undefined);
    start();
  };
  const startPrivate = async () => {
    try {
      const m = await window.api.meetings.create({
        title: detection.title || 'Meeting',
        source_app: detection.source_app,
        privacy_mode: 'private',
      });
      navigate('/meeting/' + m.id);
    } catch (err) {
      console.error('Failed to start meeting', err);
    }
  };

  return (
    <div className="card detection-prompt">
      <div className="row between">
        <div className="col">
          <div className="card-title">Meeting detected in {sourceAppLabel(detection.source_app)}</div>
          <div className="muted small">
            {detection.title ? <>“{detection.title}”</> : null}
            {detection.confidence ? <> · {detection.confidence} confidence</> : null}
          </div>
        </div>
        <div className="row gap-8">
          <button className="primary" onClick={start}>Start note</button>
          <button onClick={ignoreOnce}>Ignore</button>
          <button onClick={alwaysStart}>Always start for {sourceAppLabel(detection.source_app)}</button>
          <button onClick={startPrivate}>Private mode</button>
        </div>
      </div>
    </div>
  );
}

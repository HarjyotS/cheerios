/**
 * Tiny strip shown at the top of the app shell whenever a meeting is live.
 * Click it to jump back into the meeting. This makes the "single live note"
 * invariant visible from anywhere in the app.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useRoute, navigate } from '../lib/router';
import { formatDuration } from '../lib/format';

export function LiveBanner() {
  const meetings = useStore((s) => s.meetings);
  const route = useRoute();
  const live = meetings.find((m) => !m.ended_at) ?? null;
  const [tick, setTick] = useState(0);

  // Tick once a second so the timer updates.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  if (!live) return null;
  // Don't show inside the meeting view itself — would be redundant.
  if (route.url.startsWith('/meeting/' + live.id)) return null;

  void tick;
  const seconds = Math.floor((Date.now() - new Date(live.started_at).getTime()) / 1000);

  return (
    <div className="live-banner" onClick={() => navigate('/meeting/' + live.id)}>
      <span className="rec-dot" />
      <span className="live-banner-title">{live.title}</span>
      <span className="live-banner-timer">{formatDuration(seconds)}</span>
      <span className="live-banner-cta">Open</span>
    </div>
  );
}

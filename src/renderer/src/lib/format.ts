/**
 * Small formatting helpers — no external deps.
 */

export function formatTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  const sign = diffSec < 0 ? -1 : 1;
  const units: Array<[string, number]> = [
    ['s', 60],
    ['m', 60],
    ['h', 24],
    ['d', 7],
    ['w', 4.345],
    ['mo', 12],
    ['y', Infinity],
  ];
  let value = abs;
  let unit = 's';
  for (const [u, base] of units) {
    if (value < base) {
      unit = u;
      break;
    }
    value /= base;
    unit = u;
  }
  const v = Math.round(value);
  return sign < 0 ? `${v}${unit} ago` : `in ${v}${unit}`;
}

export function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function todayBounds(): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function sourceAppLabel(app: string): string {
  switch (app) {
    case 'zoom':
      return 'Zoom';
    case 'google_meet':
      return 'Google Meet';
    case 'microsoft_teams':
      return 'Teams';
    case 'slack_huddle':
      return 'Slack';
    case 'webex':
      return 'Webex';
    case 'discord':
      return 'Discord';
    case 'facetime':
      return 'FaceTime';
    case 'browser':
      return 'Browser';
    default:
      return 'Unknown';
  }
}

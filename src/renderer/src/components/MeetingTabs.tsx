export type TabKey = 'ai' | 'raw' | 'transcript' | 'chat' | 'tasks' | 'exports';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'ai', label: 'AI Notes' },
  { key: 'raw', label: 'Raw Notes' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'chat', label: 'Chat' },
  { key: 'tasks', label: 'Action Items' },
  { key: 'exports', label: 'Exports' },
];

export function MeetingTabs({
  active,
  onChange,
  advanced = false,
}: {
  active: TabKey;
  onChange: (k: TabKey) => void;
  advanced?: boolean;
}) {
  const tabs = advanced ? TABS : TABS.filter((t) => t.key !== 'chat');
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div
          key={t.key}
          className={`tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </div>
      ))}
    </div>
  );
}

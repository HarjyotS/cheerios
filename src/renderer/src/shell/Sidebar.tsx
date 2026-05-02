/**
 * Left sidebar. Static list of destinations + active highlighting via the
 * hash router.
 */
import { useRoute, navigate } from '../lib/router';
import { useStore } from '../store/store';

interface NavItem {
  to: string;
  label: string;
  icon: 'today' | 'upcoming' | 'notes' | 'actions' | 'chat' | 'templates' | 'automations' | 'search' | 'settings';
  /** Match prefix instead of exact */
  prefix?: boolean;
  badge?: () => string | number | null;
}

export function Sidebar() {
  const route = useRoute();
  const meetings = useStore((s) => s.meetings);
  const actionItems = useStore((s) => s.actionItems);
  const upcoming = useStore((s) => s.upcoming);
  const advanced = useStore((s) => Boolean(s.settings?.advanced_labs_enabled));

  const items: NavItem[] = [
    { to: '/today', label: 'Today', icon: 'today' },
    { to: '/upcoming', label: 'Upcoming', icon: 'upcoming', badge: () => upcoming.length || null },
    { to: '/notes', label: 'Notes', icon: 'notes', prefix: true, badge: () => meetings.length || null },
    { to: '/actions', label: 'Action Items', icon: 'actions', badge: () => actionItems.filter((a) => a.status !== 'done').length || null },
  ];

  const orgNav: NavItem[] = [
    { to: '/chat', label: 'Chat', icon: 'chat' },
    { to: '/templates', label: 'Templates', icon: 'templates' },
    { to: '/automations', label: 'Automations', icon: 'automations' },
  ];

  const bottomNav: NavItem[] = [
    { to: '/search', label: 'Search', icon: 'search' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];

  const isActive = (item: NavItem) => {
    if (item.prefix) return route.url.startsWith(item.to);
    return route.url === item.to;
  };

  const renderItem = (item: NavItem) => {
    const badge = item.badge?.();
    return (
      <div
        key={item.to}
        className={`sidebar-item ${isActive(item) ? 'active' : ''}`}
        onClick={() => navigate(item.to)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') navigate(item.to);
        }}
      >
        <span className={`nav-icon nav-icon-${item.icon}`} aria-hidden="true" />
        <span className="sidebar-label">{item.label}</span>
        {badge != null && badge !== 0 && <span className="sidebar-badge">{badge}</span>}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" />
        <span>Cherios</span>
      </div>

      <div className="sidebar-section">Workspace</div>
      {items.map(renderItem)}

      {advanced && (
        <>
          <div className="sidebar-section">Labs</div>
          {orgNav.map(renderItem)}
        </>
      )}

      <div className="spacer" />
      {bottomNav.map(renderItem)}
    </aside>
  );
}

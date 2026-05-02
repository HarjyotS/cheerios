/**
 * Command palette — Cmd+Shift+Space or Cmd+K. Provides quick navigation
 * and recent meeting/action item access.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { navigate } from '../lib/router';
import { ROUTE_PATTERNS } from '../lib/router';

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const close = useStore((s) => s.actions.togglePalette);
  const meetings = useStore((s) => s.meetings);
  const actionItems = useStore((s) => s.actionItems);
  const people = useStore((s) => s.people);
  const companies = useStore((s) => s.companies);
  const projects = useStore((s) => s.projects);
  const advanced = useStore((s) => Boolean(s.settings?.advanced_labs_enabled));

  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const publicRoutes = new Set(['/today', '/upcoming', '/notes', '/actions', '/search', '/settings']);
    const nav = ROUTE_PATTERNS
      .filter((p) => !p.includes(':') && p !== '/floating' && p !== '/detection-overlay')
      .filter((p) => advanced || publicRoutes.has(p))
      .map((path) => ({
        id: 'nav:' + path,
        label: 'Go to ' + path.slice(1).replace(/^\w/, (c) => c.toUpperCase()),
        hint: path,
        action: () => {
          navigate(path);
          close(false);
        },
      }));
    const meetingItems: PaletteItem[] = meetings.slice(0, 30).map((m) => ({
      id: 'm:' + m.id,
      label: m.title,
      hint: new Date(m.started_at).toLocaleString(),
      action: () => {
        navigate('/meeting/' + m.id);
        close(false);
      },
    }));
    const actionItemsP: PaletteItem[] = actionItems.slice(0, 20).map((a) => ({
      id: 'a:' + a.id,
      label: a.task,
      hint: a.status,
      action: () => {
        navigate('/actions');
        close(false);
      },
    }));
    const peopleP: PaletteItem[] = people.slice(0, 20).map((p) => ({
      id: 'p:' + p.id,
      label: p.name,
      hint: 'Person',
      action: () => {
        navigate('/people/' + p.id);
        close(false);
      },
    }));
    const companiesP: PaletteItem[] = companies.slice(0, 20).map((c) => ({
      id: 'co:' + c.id,
      label: c.name,
      hint: 'Company',
      action: () => {
        navigate('/companies/' + c.id);
        close(false);
      },
    }));
    const projectsP: PaletteItem[] = projects.slice(0, 20).map((p) => ({
      id: 'pr:' + p.id,
      label: p.name,
      hint: 'Project',
      action: () => {
        navigate('/projects/' + p.id);
        close(false);
      },
    }));
    return advanced
      ? [...nav, ...meetingItems, ...actionItemsP, ...peopleP, ...companiesP, ...projectsP]
      : [...nav, ...meetingItems, ...actionItemsP];
  }, [meetings, actionItems, people, companies, projects, close, advanced]);

  const filtered = useMemo(() => {
    if (!q.trim()) return items.slice(0, 30);
    const needle = q.toLowerCase();
    return items
      .filter((i) => i.label.toLowerCase().includes(needle) || (i.hint ?? '').toLowerCase().includes(needle))
      .slice(0, 30);
  }, [q, items]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  if (!open) return null;
  return (
    <div className="palette-backdrop" onClick={() => close(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder={advanced ? 'Search meetings, people, actions, navigation...' : 'Search meetings, actions, navigation...'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const sel = filtered[active];
              if (sel) sel.action();
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={`palette-item ${i === active ? 'active' : ''}`}
              onClick={() => it.action()}
              onMouseEnter={() => setActive(i)}
            >
              <span className="palette-label">{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-empty">No results</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Tiny hash router. No external dependencies.
 * Routes use `/foo/:id` style. The fragment after `#` is the path.
 *
 * Example:
 *   #/meeting/abc123 → { path: '/meeting/:id', params: { id: 'abc123' } }
 */
import { useEffect, useState, useCallback } from 'react';

export type Route = {
  /** The pattern that matched, e.g. '/meeting/:id'. The full hash if no match. */
  path: string;
  /** The raw URL fragment (no leading #). */
  url: string;
  /** Path parameters extracted from the matched pattern. */
  params: Record<string, string>;
};

export const ROUTE_PATTERNS = [
  '/today',
  '/upcoming',
  '/notes',
  '/notes/folder/:folderId',
  '/recent',
  '/meeting/:id',
  '/actions',
  '/people',
  '/people/:id',
  '/companies',
  '/companies/:id',
  '/projects',
  '/projects/:id',
  '/templates',
  '/automations',
  '/search',
  '/chat',
  '/settings',
  '/floating',
  '/detection-overlay',
] as const;

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw === '' ? '/today' : raw;
}

function matchPattern(pattern: string, url: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const urlParts = url.split('?')[0].split('/').filter(Boolean);
  if (patternParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const u = urlParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(u);
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

export function parseRoute(url: string): Route {
  for (const pattern of ROUTE_PATTERNS) {
    const params = matchPattern(pattern, url);
    if (params) return { path: pattern, url, params };
  }
  return { path: url, url, params: {} };
}

const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(readHash()));
  useEffect(() => {
    const update = () => setRoute(parseRoute(readHash()));
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return route;
}

export function navigate(to: string): void {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (window.location.hash === `#${target}`) return;
  window.location.hash = target;
}

export function useNavigate(): (to: string) => void {
  return useCallback((to: string) => navigate(to), []);
}

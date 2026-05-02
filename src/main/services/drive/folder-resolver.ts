/**
 * Resolves the Drive folder path for a meeting given the active folder
 * strategy. The path is rendered as an array of folder names, top-down,
 * starting under the root "AI Meeting Notes" folder.
 *
 * Hybrid (default): meetings get filed by the strongest signal —
 *   Project > Company > Person > Inbox.
 * Date / Project / Person / Company strategies are linear.
 * Custom uses a template string with {year}/{month}/{project}/etc tokens.
 *
 * Local-only meetings (privacy_mode 'private' | 'local_only') return null
 * to signal the caller to skip syncing entirely.
 */

import type { Meeting, Project, Company, Person, Settings } from '@shared/types/entities';

export const ROOT_FOLDER = 'AI Meeting Notes';
export const INBOX_FOLDER = 'Inbox';

export type FolderStrategy = Settings['drive_folder_strategy'] | 'custom';

export interface ResolverContext {
  meeting: Meeting;
  projects?: Project[]; // resolved from meeting.project_ids
  companies?: Company[];
  attendees?: Person[];
  /**
   * Optional template string for 'custom' strategy.
   *  Tokens: {year} {month} {date} {project} {company} {person} {app} {title}
   */
  customTemplate?: string;
}

/**
 * Returns the folder path as an array of segments under the Drive root.
 * E.g. ['AI Meeting Notes', 'Projects', 'Apollo'].
 *
 * Returns null if the meeting must not be synced (privacy reasons).
 */
export function resolveFolderPath(
  strategy: FolderStrategy,
  ctx: ResolverContext,
): string[] | null {
  const { meeting } = ctx;
  if (meeting.privacy_mode === 'private' || meeting.privacy_mode === 'local_only') {
    return null;
  }

  switch (strategy) {
    case 'date':
      return [ROOT_FOLDER, ...dateSegments(meeting.started_at)];
    case 'project': {
      const p = ctx.projects?.[0];
      return [ROOT_FOLDER, 'Projects', sanitize(p?.name ?? INBOX_FOLDER)];
    }
    case 'person': {
      const a = ctx.attendees?.[0];
      return [ROOT_FOLDER, 'People', sanitize(a?.name ?? INBOX_FOLDER)];
    }
    case 'company': {
      const c = ctx.companies?.[0];
      return [ROOT_FOLDER, 'Companies', sanitize(c?.name ?? INBOX_FOLDER)];
    }
    case 'hybrid':
      return hybrid(ctx);
    case 'custom':
      return custom(ctx);
    default:
      return [ROOT_FOLDER, INBOX_FOLDER];
  }
}

function hybrid(ctx: ResolverContext): string[] {
  const project = ctx.projects?.[0];
  const company = ctx.companies?.[0];
  const person = ctx.attendees?.[0];
  if (project) return [ROOT_FOLDER, 'Projects', sanitize(project.name)];
  if (company) return [ROOT_FOLDER, 'Companies', sanitize(company.name)];
  if (person) return [ROOT_FOLDER, 'People', sanitize(person.name)];
  return [ROOT_FOLDER, INBOX_FOLDER];
}

function custom(ctx: ResolverContext): string[] {
  const tpl = ctx.customTemplate?.trim() || '/AI Meeting Notes/{year}/{month}';
  const d = new Date(ctx.meeting.started_at);
  const tokens: Record<string, string> = {
    year: String(d.getFullYear()),
    month: pad2(d.getMonth() + 1),
    date: pad2(d.getDate()),
    project: ctx.projects?.[0]?.name ?? INBOX_FOLDER,
    company: ctx.companies?.[0]?.name ?? INBOX_FOLDER,
    person: ctx.attendees?.[0]?.name ?? INBOX_FOLDER,
    app: ctx.meeting.source_app,
    title: ctx.meeting.title,
  };
  const expanded = tpl.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
  // Strip leading slash, split on /, drop empties, sanitize each segment.
  const segs = expanded.split('/').map((s) => s.trim()).filter(Boolean).map(sanitize);
  // Always anchor under the root if the template didn't already include it.
  if (segs[0] !== ROOT_FOLDER) segs.unshift(ROOT_FOLDER);
  return segs;
}

function dateSegments(iso: string): string[] {
  const d = new Date(iso);
  return [String(d.getFullYear()), `${pad2(d.getMonth() + 1)} - ${monthName(d.getMonth())}`];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function monthName(i: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i] ?? 'Month';
}

/** Drive accepts most characters, but slashes confuse path-style code. */
export function sanitize(s: string): string {
  return s.replace(/[\\/]/g, ' - ').replace(/\s+/g, ' ').trim() || INBOX_FOLDER;
}

/**
 * The "private — local only" signpost folder. Never created in Drive,
 * but exposed for the UI so users can see where to drag local-only notes.
 */
export const PRIVATE_LOCAL_FOLDER_NAME = 'Private - Local Only';

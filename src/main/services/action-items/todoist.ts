/**
 * Push an action item to Todoist via REST API v2.
 * Docs: https://developer.todoist.com/rest/v2/#create-a-new-task
 */
import type { ActionItem, Meeting } from '@shared/types/entities';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

const PRIORITY_MAP: Record<ActionItem['priority'], number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export async function pushToTodoist(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  const token = await getSecret(SECRET_KEYS.todoistToken);
  if (!token) {
    throw new Error('Connect Todoist in Integrations to enable sync');
  }

  const descriptionParts: string[] = [];
  if (opts.meetingTitle ?? meeting?.title) {
    descriptionParts.push(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`);
  }
  if (opts.context) descriptionParts.push(opts.context);
  if (opts.meetingLink) descriptionParts.push(`Link: ${opts.meetingLink}`);

  const body: {
    content: string;
    description?: string;
    priority?: number;
    due_date?: string;
  } = {
    content: actionItem.task,
    priority: PRIORITY_MAP[actionItem.priority] ?? 2,
  };

  if (descriptionParts.length) body.description = descriptionParts.join('\n');

  if (actionItem.due_date) {
    const d = new Date(actionItem.due_date);
    if (!Number.isNaN(d.getTime())) {
      // Todoist due_date wants YYYY-MM-DD.
      body.due_date = d.toISOString().slice(0, 10);
    }
  }

  const res = await fetch('https://api.todoist.com/rest/v2/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Todoist push failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('Todoist did not return a task id');
  return String(json.id);
}

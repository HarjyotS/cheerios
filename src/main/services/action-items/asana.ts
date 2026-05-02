/**
 * Push an action item to Asana as a task in a configured project.
 * Docs: https://developers.asana.com/reference/createtask
 */
import type { ActionItem, Meeting } from '@shared/types/entities';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { Integrations } from '@main/db/repositories';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

export async function pushToAsana(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  const token = await getSecret(SECRET_KEYS.asanaToken);
  if (!token) {
    throw new Error('Connect Asana in Integrations to enable sync');
  }

  const integration = Integrations.byKind('asana');
  const config = (integration?.config ?? {}) as { workspace_id?: string; project_id?: string };
  const workspaceId = config.workspace_id;
  const projectId = config.project_id;
  if (!workspaceId || !projectId) {
    throw new Error('Set workspace_id and project_id on the Asana integration to enable sync');
  }

  const notesParts: string[] = [];
  if (opts.meetingTitle ?? meeting?.title) {
    notesParts.push(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`);
  }
  if (opts.context) notesParts.push(opts.context);
  if (opts.meetingLink) notesParts.push(`Link: ${opts.meetingLink}`);
  if (actionItem.owner && actionItem.owner !== 'me') notesParts.push(`Owner: ${actionItem.owner}`);
  notesParts.push(`Priority: ${actionItem.priority}`);

  const data: Record<string, unknown> = {
    name: actionItem.task,
    notes: notesParts.filter(Boolean).join('\n'),
    workspace: workspaceId,
    projects: [projectId],
  };

  if (actionItem.due_date) {
    const d = new Date(actionItem.due_date);
    if (!Number.isNaN(d.getTime())) {
      data.due_on = d.toISOString().slice(0, 10);
    }
  }

  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ data }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Asana push failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as { data?: { gid?: string } };
  const gid = json.data?.gid;
  if (!gid) throw new Error('Asana did not return a task gid');
  return gid;
}

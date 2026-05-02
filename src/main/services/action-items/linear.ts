/**
 * Push an action item to Linear as an issue via the GraphQL API.
 * Docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */
import type { ActionItem, Meeting } from '@shared/types/entities';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { Integrations } from '@main/db/repositories';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

const ENDPOINT = 'https://api.linear.app/graphql';

const PRIORITY_MAP: Record<ActionItem['priority'], number> = {
  low: 4,
  medium: 3,
  high: 1, // Linear: 1 = Urgent, 2 = High, 3 = Medium, 4 = Low. We map "high" -> Urgent.
};

async function linearRequest<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Linear request failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length) {
    throw new Error('Linear GraphQL error: ' + json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new Error('Linear returned no data');
  return json.data;
}

async function resolveTeamId(token: string): Promise<string> {
  const integration = Integrations.byKind('linear');
  const configured = (integration?.config as { team_id?: string } | undefined)?.team_id;
  if (configured) return configured;
  const data = await linearRequest<{ teams: { nodes: Array<{ id: string }> } }>(
    token,
    'query { teams(first: 1) { nodes { id } } }',
    {},
  );
  const id = data.teams?.nodes?.[0]?.id;
  if (!id) throw new Error('No Linear team available; configure team_id on the linear integration');
  return id;
}

export async function pushToLinear(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  const token = await getSecret(SECRET_KEYS.linearToken);
  if (!token) {
    throw new Error('Connect Linear in Integrations to enable sync');
  }

  const teamId = await resolveTeamId(token);

  const descParts: string[] = [];
  if (opts.meetingTitle ?? meeting?.title) {
    descParts.push(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`);
  }
  if (opts.context) descParts.push(opts.context);
  if (opts.meetingLink) descParts.push(`Link: ${opts.meetingLink}`);
  if (actionItem.owner && actionItem.owner !== 'me') descParts.push(`Owner: ${actionItem.owner}`);

  const input: Record<string, unknown> = {
    teamId,
    title: actionItem.task,
    description: descParts.join('\n\n') || undefined,
    priority: PRIORITY_MAP[actionItem.priority] ?? 3,
  };

  if (actionItem.due_date) {
    const d = new Date(actionItem.due_date);
    if (!Number.isNaN(d.getTime())) {
      input.dueDate = d.toISOString().slice(0, 10);
    }
  }

  const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier }
      }
    }
  `;
  const data = await linearRequest<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string } | null };
  }>(token, mutation, { input });

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issue create returned success=false');
  }
  return data.issueCreate.issue.id;
}

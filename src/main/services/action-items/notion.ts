/**
 * Push an action item to Notion as a page in a configured database.
 * Docs: https://developers.notion.com/reference/post-page
 */
import type { ActionItem, Meeting } from '@shared/types/entities';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { Integrations } from '@main/db/repositories';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

const NOTION_VERSION = '2022-06-28';

export async function pushToNotion(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  const token = await getSecret(SECRET_KEYS.notionToken);
  if (!token) {
    throw new Error('Connect Notion in Integrations to enable sync');
  }

  const integration = Integrations.byKind('notion');
  const databaseId = (integration?.config as { database_id?: string } | undefined)?.database_id;
  if (!databaseId) {
    throw new Error('Set database_id on the Notion integration to enable sync');
  }

  const properties: Record<string, unknown> = {
    Name: {
      title: [{ type: 'text', text: { content: actionItem.task } }],
    },
    Priority: {
      select: { name: actionItem.priority },
    },
  };

  if (actionItem.due_date) {
    const d = new Date(actionItem.due_date);
    if (!Number.isNaN(d.getTime())) {
      properties.Due = { date: { start: d.toISOString().slice(0, 10) } };
    }
  }

  const meetingUrl = opts.meetingLink;
  if (meetingUrl) {
    properties['Source meeting URL'] = { url: meetingUrl };
  }

  const childParas: Array<Record<string, unknown>> = [];
  if (opts.meetingTitle ?? meeting?.title) {
    childParas.push(paragraph(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`));
  }
  if (opts.context) childParas.push(paragraph(opts.context));
  if (actionItem.owner && actionItem.owner !== 'me') childParas.push(paragraph(`Owner: ${actionItem.owner}`));

  const body = {
    parent: { database_id: databaseId },
    properties,
    children: childParas,
  };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion push failed (${res.status}): ${text || res.statusText}`);
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('Notion did not return a page id');
  return json.id;
}

function paragraph(text: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: text } }],
    },
  };
}

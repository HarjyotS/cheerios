/**
 * Push an action item to Google Tasks (default task list) via googleapis.
 * Returns the external Google Tasks task id.
 */
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { ActionItem, Meeting } from '@shared/types/entities';
import { services } from '@main/lib/service-registry';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

export async function pushToGoogleTasks(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  const auth = services.googleAuth;
  if (!auth || !auth.isConnected()) {
    throw new Error('Connect Google in Integrations to enable sync');
  }
  const oauth2 = (await auth.getOAuth2Client()) as OAuth2Client | null;
  if (!oauth2) {
    throw new Error('Connect Google in Integrations to enable sync');
  }

  const tasks = google.tasks({ version: 'v1', auth: oauth2 });

  const notesParts: string[] = [];
  if (opts.meetingTitle ?? meeting?.title) {
    notesParts.push(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`);
  }
  if (opts.context) notesParts.push(opts.context);
  if (opts.meetingLink) notesParts.push(`Link: ${opts.meetingLink}`);
  if (actionItem.owner && actionItem.owner !== 'me') {
    notesParts.push(`Owner: ${actionItem.owner}`);
  }
  notesParts.push(`Priority: ${actionItem.priority}`);

  const body: {
    title: string;
    notes: string;
    due?: string;
  } = {
    title: actionItem.task,
    notes: notesParts.filter(Boolean).join('\n'),
  };

  if (actionItem.due_date) {
    // Google Tasks requires RFC3339; date-only resolution is OK (time is ignored).
    const d = new Date(actionItem.due_date);
    if (!Number.isNaN(d.getTime())) {
      body.due = d.toISOString();
    }
  }

  const res = await tasks.tasks.insert({
    tasklist: '@default',
    requestBody: body,
  });

  const id = res.data.id;
  if (!id) throw new Error('Google Tasks did not return a task id');
  return id;
}

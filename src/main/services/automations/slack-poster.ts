/**
 * Slack poster — sends a message via either an Incoming Webhook URL or the
 * chat.postMessage Bot API. The token stored under SECRET_KEYS.slackToken
 * is interpreted heuristically:
 *   - starts with "https://hooks.slack.com/" → treat as incoming webhook URL
 *   - starts with "xoxb-" or "xoxp-"          → treat as bot token
 *   - anything else                           → assumed to be a webhook URL
 *
 * For bot-token mode the caller must supply a `channel` (channel ID or name)
 * via SlackPostOptions.channel; if omitted we log a warning and skip.
 */
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { log } from '@main/lib/logger';

const logger = log('automations:slack');

export interface SlackPostOptions {
  text: string;
  channel?: string;
  blocks?: unknown[];
}

export interface SlackPostResult {
  ok: boolean;
  error?: string;
}

export async function postToSlack(opts: SlackPostOptions): Promise<SlackPostResult> {
  const token = await getSecret(SECRET_KEYS.slackToken);
  if (!token) {
    logger.warn('post_to_slack skipped — no slack token configured');
    return { ok: false, error: 'slack_token_missing' };
  }

  if (token.startsWith('xoxb-') || token.startsWith('xoxp-')) {
    return postViaBotApi(token, opts);
  }
  // Default to webhook mode.
  return postViaWebhook(token, opts);
}

async function postViaWebhook(url: string, opts: SlackPostOptions): Promise<SlackPostResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid_webhook_url' };
  }
  try {
    const body: Record<string, unknown> = { text: opts.text };
    if (opts.blocks) body.blocks = opts.blocks;
    if (opts.channel) body.channel = opts.channel;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('slack webhook returned non-2xx', { status: res.status, body: text.slice(0, 200) });
      return { ok: false, error: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.error('slack webhook POST failed', { err: String(err) });
    return { ok: false, error: String(err) };
  }
}

async function postViaBotApi(token: string, opts: SlackPostOptions): Promise<SlackPostResult> {
  if (!opts.channel) {
    logger.warn('post_to_slack: bot token configured but no channel supplied; skipping');
    return { ok: false, error: 'channel_required' };
  }
  try {
    const body: Record<string, unknown> = { channel: opts.channel, text: opts.text };
    if (opts.blocks) body.blocks = opts.blocks;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) {
      logger.warn('slack chat.postMessage failed', { status: res.status, error: json.error });
      return { ok: false, error: json.error ?? `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.error('slack chat.postMessage threw', { err: String(err) });
    return { ok: false, error: String(err) };
  }
}

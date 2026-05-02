/**
 * Push an action item to Apple Reminders via osascript (macOS only).
 * The AppleScript returns the new reminder's id which we use as the external id.
 */
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import type { ActionItem, Meeting } from '@shared/types/entities';

export interface PushOptions {
  context?: string;
  meetingLink?: string;
  meetingTitle?: string;
}

function escapeForAppleScript(s: string): string {
  // Escape backslashes and double-quotes for embedding inside an AppleScript string literal.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runOsascript(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString().trim() || err.message;
        reject(new Error(`osascript failed: ${msg}`));
        return;
      }
      resolve(stdout.toString().trim());
    });
  });
}

function formatAppleScriptDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Build a locale-independent string AppleScript can parse: "MM/DD/YYYY HH:MM:SS".
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${mi}:${ss}`;
}

export async function pushToAppleReminders(
  actionItem: ActionItem,
  meeting: Meeting | null,
  opts: PushOptions = {},
): Promise<string> {
  if (platform() !== 'darwin') {
    throw new Error('Apple Reminders sync is only available on macOS');
  }

  const bodyParts: string[] = [];
  if (opts.meetingTitle ?? meeting?.title) {
    bodyParts.push(`From meeting: ${opts.meetingTitle ?? meeting?.title ?? ''}`);
  }
  if (opts.context) bodyParts.push(opts.context);
  if (opts.meetingLink) bodyParts.push(`Link: ${opts.meetingLink}`);
  if (actionItem.owner && actionItem.owner !== 'me') bodyParts.push(`Owner: ${actionItem.owner}`);
  bodyParts.push(`Priority: ${actionItem.priority}`);

  const name = escapeForAppleScript(actionItem.task);
  const body = escapeForAppleScript(bodyParts.filter(Boolean).join('\n'));

  let dueProp = '';
  if (actionItem.due_date) {
    const formatted = formatAppleScriptDate(actionItem.due_date);
    if (formatted) {
      dueProp = `, due date:date "${escapeForAppleScript(formatted)}"`;
    }
  }

  const script = `
tell application "Reminders"
  tell list "Reminders"
    set newReminder to make new reminder with properties {name:"${name}", body:"${body}"${dueProp}}
    return id of newReminder
  end tell
end tell
`.trim();

  const id = await runOsascript(script);
  if (!id) throw new Error('Apple Reminders did not return a reminder id');
  return id;
}

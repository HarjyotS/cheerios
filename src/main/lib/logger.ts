/**
 * Simple structured logger. Writes to stdout in dev and a rolling file in prod.
 */
import { app } from 'electron';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

let logFile: string | null = null;
function ensureFile() {
  if (logFile) return logFile;
  const dir = join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, `pmos-${new Date().toISOString().slice(0, 10)}.log`);
  return logFile;
}

function fmt(level: string, scope: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const m = meta ? ' ' + safeJson(meta) : '';
  return `${ts} [${level}] [${scope}] ${redactUrlsInText(msg)}${m}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_key, value) => {
      if (typeof value === 'string') return redactUrlsInText(value);
      return value;
    });
  } catch {
    return redactUrlsInText(String(v));
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

function redactUrlsInText(text: string): string {
  return text.replace(URL_RE, (raw) => redactUrl(raw));
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname}${port}/[redacted]`;
  } catch {
    return '[redacted-url]';
  }
}

export class Logger {
  constructor(private scope: string) {}
  info(msg: string, meta?: unknown) { write('INFO', this.scope, msg, meta); }
  warn(msg: string, meta?: unknown) { write('WARN', this.scope, msg, meta); }
  error(msg: string, meta?: unknown) { write('ERROR', this.scope, msg, meta); }
  debug(msg: string, meta?: unknown) {
    if (process.env.PMOS_DEBUG === '1') write('DEBUG', this.scope, msg, meta);
  }
}

function write(level: string, scope: string, msg: string, meta?: unknown) {
  const line = fmt(level, scope, msg, meta);
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    appendFileSync(ensureFile(), line + '\n');
  } catch {
    // ignore
  }
}

export const log = (scope: string) => new Logger(scope);

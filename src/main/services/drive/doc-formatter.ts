/**
 * Builds a Google Doc out of a markdown string by uploading HTML and
 * letting Drive's import pipeline convert it. This is the simplest
 * reliable way to get headings, bullet lists, blockquotes, and tables
 * rendered correctly without driving the Google Docs API.
 *
 * The flow:
 *   1. Markdown -> HTML (deterministic, line-based; no third-party dep).
 *   2. Multipart upload to Drive with target mimeType
 *      'application/vnd.google-apps.document', source 'text/html'.
 *   3. Drive does the conversion server-side.
 */

import type { drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';

export interface UploadDocOptions {
  drive: drive_v3.Drive;
  name: string;
  parentFolderId: string;
  markdown: string;
  /** If set, update this file in place rather than creating a new one. */
  existingFileId?: string;
}

export async function uploadAsGoogleDoc(opts: UploadDocOptions): Promise<{ fileId: string; webViewLink?: string }> {
  const html = markdownToHtml(opts.markdown);
  const buf = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.name)}</title></head><body>${html}</body></html>`, 'utf-8');

  if (opts.existingFileId) {
    // Update keeps the file id stable so subsequent re-syncs overwrite
    // rather than creating duplicates.
    const res = await opts.drive.files.update({
      fileId: opts.existingFileId,
      requestBody: { name: opts.name },
      media: { mimeType: 'text/html', body: bufToStream(buf) },
      fields: 'id, webViewLink',
    });
    return { fileId: res.data.id ?? opts.existingFileId, webViewLink: res.data.webViewLink ?? undefined };
  }

  const res = await opts.drive.files.create({
    requestBody: {
      name: opts.name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [opts.parentFolderId],
    },
    media: { mimeType: 'text/html', body: bufToStream(buf) },
    fields: 'id, webViewLink',
  });
  return { fileId: res.data.id!, webViewLink: res.data.webViewLink ?? undefined };
}

// ---------------------------------------------------------------------------
// Tiny markdown → HTML converter — covers the structures our renderer
// emits: headings, paragraphs, ordered/unordered lists, task list checkboxes,
// blockquotes, horizontal rules, inline code, bold, italic, links.
// We do not try to be CommonMark-complete — only handle what we produce.
// ---------------------------------------------------------------------------

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(`<p>${inline(buf.join(' '))}</p>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote (single or multi-line)
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // Unordered / task list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^[-*+]\s+/, '');
        const task = /^\[( |x|X)\]\s+/.exec(raw);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          const rest = raw.slice(task[0].length);
          items.push(`<li><input type="checkbox" disabled${checked ? ' checked' : ''}/> ${inline(rest)}</li>`);
        } else {
          items.push(`<li>${inline(raw)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Plain paragraph — gather until blank line.
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !looksLikeBlock(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    flushParagraph(buf);
  }

  return out.join('\n');
}

function looksLikeBlock(s: string): boolean {
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|---+\s*$)/.test(s);
}

function inline(s: string): string {
  // Process in this order: code spans first (so they aren't re-processed),
  // then links, then bold, italic.
  // Code spans
  let out = s.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  // Bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  // Italic *text* or _text_
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*/g, (_, lead, c) => `${lead}<em>${c}</em>`);
  out = out.replace(/(^|[\s(])_([^_\s][^_]*?)_/g, (_, lead, c) => `${lead}<em>${c}</em>`);
  // Links [t](u)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${escapeHtml(u)}">${t}</a>`);
  // Escape stray HTML in remaining text segments — but our inputs already
  // pass through escapeMd; we only need to neutralize raw `<` from URLs etc.
  // Cheap heuristic: leave through.
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function bufToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

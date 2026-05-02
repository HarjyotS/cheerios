/**
 * AI Note Engine — production implementation.
 *
 * Spec references: §10 (note generation), §15 (chat), §16/§17 (people/company
 * profiles), §29 (quality rules — encoded in prompts.ts).
 *
 * Responsibilities:
 *  - Generate structured notes for a meeting from raw notes + transcript +
 *    template (+ optional prior-meeting context).
 *  - Persist GeneratedNote, fan out canonical ActionItems, and emit events
 *    so automations and the UI can react.
 *  - Regenerate a single section without re-doing the whole note.
 *  - Transform an existing note into other shapes (shorter, follow-up email,
 *    product spec, investor update, etc.).
 *  - Handle scoped chat ("ask across all meetings", "about this person", …)
 *    with citations.
 *  - Build per-person and per-company profiles.
 *  - Power semantic search via FTS recall + Claude rerank.
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import {
  Meetings,
  TranscriptChunks,
  GeneratedNotes,
  ActionItems,
  People,
  Companies,
  ChatThreads,
} from '@main/db/repositories';
import { getSettings } from '@main/db';
import { bus } from '@main/lib/event-bus';
import { log } from '@main/lib/logger';
import type {
  GeneratedNote,
  ChatThread,
  ChatMessage,
  ChatScope,
  Meeting,
  Person,
  Company,
  ActionItemDraft,
  ID,
  TranscriptChunk,
} from '@shared/types/entities';

import { callAI, AIKeyMissingError } from './ai-client';
import {
  NOTE_TOOL_NAME,
  NOTE_TOOL_SCHEMA,
  TRANSFORM_TOOL_NAME,
  TRANSFORM_TOOL_SCHEMA,
  buildNoteSystem,
  buildNoteUserMessage,
  buildRegenerateSectionUser,
  buildTransformSystem,
  buildTransformUser,
  buildChatSystem,
  renderChatContext,
  buildPersonProfileSystem,
  buildPersonProfileUser,
  buildCompanyProfileSystem,
  buildCompanyProfileUser,
  type ChatContextItem,
  type ProfileMeetingDigest,
} from './prompts';
import { buildNoteContext } from './context-builder';
import { semanticSearch as runSemanticSearch, type RankedHit } from './semantic-index';

const logger = log('ai');

// --------------------------------------------------------------------------
// Zod schemas — defensive parsing of Claude's structured output.
// --------------------------------------------------------------------------

const NoteOutputSchema = z.object({
  title: z.string().nullable().optional(),
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).default([]),
  decisions: z
    .array(z.object({ text: z.string(), source_chunk_ids: z.array(z.string()).default([]) }))
    .default([]),
  action_items: z
    .array(
      z.object({
        task: z.string(),
        owner: z.string(),
        due_date: z.string().nullable().optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        source_chunk_ids: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  open_questions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  quotes: z
    .array(
      z.object({
        speaker: z.string(),
        text: z.string(),
        source_chunk_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  follow_up_email: z.string().nullable().optional(),
  personal_reminders: z.array(z.string()).default([]),
});

const TransformOutputSchema = z.object({
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).default([]),
  follow_up_email: z.string().nullable().optional(),
});

interface NoteOutput {
  title?: string | null;
  summary: string;
  sections: Array<{ heading: string; body: string }>;
  decisions: Array<{ text: string; source_chunk_ids: string[] }>;
  action_items: Array<{
    task: string;
    owner: string;
    due_date?: string | null;
    priority?: 'low' | 'medium' | 'high';
    source_chunk_ids: string[];
    confidence: number;
  }>;
  open_questions: string[];
  risks: string[];
  quotes: Array<{ speaker: string; text: string; source_chunk_ids: string[] }>;
  follow_up_email?: string | null;
  personal_reminders: string[];
}

/** Normalize zod output (which has optional-looking fields due to .default()) into NoteOutput. */
function normalizeNoteOutput(parsed: z.output<typeof NoteOutputSchema>): NoteOutput {
  return {
    title: parsed.title ?? null,
    summary: parsed.summary,
    sections: (parsed.sections ?? []).map((s) => ({ heading: s.heading, body: s.body })),
    decisions: (parsed.decisions ?? []).map((d) => ({
      text: d.text,
      source_chunk_ids: d.source_chunk_ids ?? [],
    })),
    action_items: (parsed.action_items ?? []).map((a) => ({
      task: a.task,
      owner: a.owner,
      due_date: a.due_date ?? null,
      priority: a.priority,
      source_chunk_ids: a.source_chunk_ids ?? [],
      confidence: a.confidence,
    })),
    open_questions: parsed.open_questions ?? [],
    risks: parsed.risks ?? [],
    quotes: (parsed.quotes ?? []).map((q) => ({
      speaker: q.speaker,
      text: q.text,
      source_chunk_ids: q.source_chunk_ids ?? [],
    })),
    follow_up_email: parsed.follow_up_email ?? null,
    personal_reminders: parsed.personal_reminders ?? [],
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Parse a tool-use payload, then fall back to extracting a JSON fenced
 * block from text. Throws on irrecoverable parse failure — caller can retry.
 */
function parseStructured<S extends z.ZodTypeAny>(
  schema: S,
  toolUseInput: Record<string, unknown> | null,
  text: string,
): z.output<S> {
  if (toolUseInput) {
    const r = schema.safeParse(toolUseInput);
    if (r.success) return r.data;
  }
  // Fenced JSON fallback.
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = match ? match[1] : text;
  try {
    const obj = JSON.parse(candidate);
    return schema.parse(obj) as z.output<S>;
  } catch (e) {
    throw new Error(`Failed to parse structured output: ${(e as Error).message}`);
  }
}

/**
 * Resolve an action-item owner string ("Sarah", "sarah@x.com", "me") to a
 * Person id when possible. Returns null if no confident match.
 */
function resolveOwnerPersonId(owner: string, attendees: ID[]): ID | null {
  if (!owner) return null;
  const o = owner.trim().toLowerCase();
  if (!o || o === 'me' || o === 'unclear' || o === 'unknown') return null;

  // Email match
  if (o.includes('@')) {
    const p = People.byEmail(o);
    if (p) return p.id;
  }
  // Name match scoped to attendees first (more precise), then global.
  for (const id of attendees) {
    const p = People.get(id);
    if (!p) continue;
    if (p.name.toLowerCase() === o) return p.id;
  }
  for (const id of attendees) {
    const p = People.get(id);
    if (!p) continue;
    if (o.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(o)) return p.id;
  }
  for (const p of People.list()) {
    if (p.name.toLowerCase() === o) return p.id;
    if (p.email && p.email.toLowerCase() === o) return p.id;
  }
  return null;
}

// --------------------------------------------------------------------------
// AINoteEngine
// --------------------------------------------------------------------------

export class AINoteEngine {
  /**
   * Generate the structured note for a meeting end-to-end:
   *  1. Build context (template, transcript, raw notes, prior-meeting digests).
   *  2. Ask Claude with the structured-output tool forced.
   *  3. Persist note, fan out action items, emit events.
   */
  async generateNote(
    meetingId: ID,
    opts?: { templateId?: ID; tone?: string; length?: 'short' | 'medium' | 'detailed' },
  ): Promise<GeneratedNote> {
    const settings = getSettings();
    const ctx = buildNoteContext({
      meetingId,
      templateId: opts?.templateId,
      tone: opts?.tone,
      length: opts?.length,
      settings,
    });

    const system = buildNoteSystem(ctx);
    const userContent = buildNoteUserMessage(ctx);

    let parsed: NoteOutput;
    try {
      parsed = await this.callForNote(settings.ai_model, system, userContent);
    } catch (e) {
      // One retry on parse failure with a slightly higher temperature.
      logger.warn('generateNote.retry_on_parse', { meetingId, err: (e as Error).message });
      parsed = await this.callForNote(settings.ai_model, system, userContent, 0.4);
    }

    // Persist the note.
    const note = GeneratedNotes.upsert({
      meeting_id: meetingId,
      template_id: ctx.template.id,
      summary: parsed.summary,
      sections: parsed.sections,
      decisions: parsed.decisions.map((d) => ({
        text: d.text,
        source_chunk_ids: d.source_chunk_ids,
      })),
      action_items: parsed.action_items.map(
        (a): ActionItemDraft => ({
          task: a.task,
          owner: a.owner,
          due_date: a.due_date ?? null,
          priority: a.priority,
          source_chunk_ids: a.source_chunk_ids,
          confidence: a.confidence,
        }),
      ),
      open_questions: parsed.open_questions,
      risks: parsed.risks,
      quotes: parsed.quotes.map((q) => ({
        speaker: q.speaker,
        text: q.text,
        source_chunk_ids: q.source_chunk_ids,
      })),
      follow_up_email: parsed.follow_up_email ?? undefined,
      personal_reminders: parsed.personal_reminders,
      model: settings.ai_model,
      tone: opts?.tone ?? settings.default_note_tone,
      length_preset: opts?.length ?? settings.default_note_style,
      format_preset: settings.default_note_format,
    });

    // If the meeting still has its placeholder title and the AI produced a
    // meaningful one, adopt it. This runs once — title_is_auto flips to
    // false after the first applied AI title (or the first manual rename),
    // so subsequent regenerations don't churn the title.
    if (ctx.meeting.title_is_auto && parsed.title && parsed.title.trim()) {
      const cleanedTitle = parsed.title.trim().replace(/[.!?]+$/, '').slice(0, 120);
      try {
        const renamed = Meetings.update(ctx.meeting.id, {
          title: cleanedTitle,
          title_is_auto: false,
        });
        bus.emit('meeting_updated', renamed);
      } catch (err) {
        logger.warn('apply_ai_title_failed', { err: (err as Error).message });
      }
    }

    // Fan out canonical action items + per-item automation triggers.
    for (const draft of parsed.action_items) {
      const personId = resolveOwnerPersonId(draft.owner, ctx.meeting.attendees);
      const ai = ActionItems.insert({
        meeting_id: meetingId,
        task: draft.task,
        owner: draft.owner || 'unclear',
        owner_person_id: personId,
        due_date: draft.due_date ?? null,
        priority: draft.priority ?? 'medium',
        status: 'open',
        source_chunk_id: draft.source_chunk_ids[0] ?? null,
        confidence: draft.confidence,
        external_ids: {},
      });
      bus.emit('automation_trigger', {
        trigger: 'action_item_detected',
        meetingId,
        payload: { actionItemId: ai.id },
      });
    }

    // Re-index meeting FTS so the new summary is searchable.
    Meetings.indexFts(ctx.meeting);

    bus.emit('note_updated', note);
    bus.emit('automation_trigger', { trigger: 'meeting_notes_generated', meetingId });

    return note;
  }

  /** Fire-and-forget variant — used by the meeting-ended handler. */
  async generateNoteAsync(meetingId: ID): Promise<void> {
    try {
      await this.generateNote(meetingId);
    } catch (e) {
      if (e instanceof AIKeyMissingError) {
        logger.warn('generateNoteAsync.skipped_no_key', { meetingId });
      } else {
        logger.error('generateNoteAsync.failed', { meetingId, err: (e as Error).message });
      }
    }
  }

  /**
   * Re-generate a single section (e.g. "Decisions") without redoing the
   * whole note. Reuses the cached system prompt.
   */
  async regenerateSection(meetingId: ID, section: string): Promise<GeneratedNote> {
    const settings = getSettings();
    const ctx = buildNoteContext({ meetingId, settings });
    const existing = GeneratedNotes.get(meetingId);
    if (!existing) {
      // Nothing to patch — generate fresh and return.
      return this.generateNote(meetingId);
    }

    const system = buildNoteSystem(ctx);
    const userContent = buildRegenerateSectionUser(ctx, existing, section);

    const parsed = await this.callForNote(settings.ai_model, system, userContent);
    const newSection = parsed.sections.find((s) => s.heading === section) ?? parsed.sections[0];

    const merged = GeneratedNotes.upsert({
      ...existing,
      meeting_id: meetingId,
      sections: existing.sections.some((s) => s.heading === section)
        ? existing.sections.map((s) => (s.heading === section ? newSection ?? s : s))
        : [...existing.sections, ...(newSection ? [newSection] : [])],
      model: settings.ai_model,
    });
    bus.emit('note_updated', merged);
    return merged;
  }

  /**
   * Reshape an existing note into a different format (shorter, detailed,
   * follow-up email, product spec, investor update, CRM, …).
   */
  async transformNote(meetingId: ID, kind: string): Promise<GeneratedNote> {
    const settings = getSettings();
    const existing = GeneratedNotes.get(meetingId);
    if (!existing) throw new Error('No existing note to transform for meeting ' + meetingId);

    const res = await callAI({
      model: settings.ai_model,
      system: buildTransformSystem(kind),
      messages: [{ role: 'user', content: buildTransformUser(existing, kind) }],
      tool: {
        name: TRANSFORM_TOOL_NAME,
        description: 'Emit the transformed note.',
        input_schema: TRANSFORM_TOOL_SCHEMA,
      },
      forceTool: true,
      max_tokens: 4096,
      temperature: 0.3,
    });
    const parsed = parseStructured(TransformOutputSchema, res.toolUseInput, res.text);

    const updated = GeneratedNotes.upsert({
      ...existing,
      meeting_id: meetingId,
      summary: parsed.summary || existing.summary,
      sections: (parsed.sections ?? []).length ? (parsed.sections ?? existing.sections) : existing.sections,
      follow_up_email: parsed.follow_up_email ?? existing.follow_up_email,
      model: settings.ai_model,
    });
    bus.emit('note_updated', updated);
    return updated;
  }

  /**
   * Append a user message to a chat thread, gather scope context, ask Claude,
   * append the assistant reply (with citations), persist.
   */
  async chatSend(threadId: ID, message: string): Promise<ChatThread> {
    const thread = ChatThreads.get(threadId);
    if (!thread) throw new Error('Chat thread not found: ' + threadId);

    const settings = getSettings();
    const context = this.buildChatContext(thread.scope);

    // Append user message first so it's preserved even if the call fails.
    const userMsg: ChatMessage = {
      id: 'msg_' + nanoid(10),
      role: 'user',
      content: message,
      created_at: new Date().toISOString(),
    };
    const withUser: ChatThread = { ...thread, messages: [...thread.messages, userMsg] };

    const history = withUser.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const contextBlock = renderChatContext(context);
    // Prepend the context as a synthetic user-message turn so it benefits from
    // prompt caching independently of the live chat history.
    const messages: Array<{
      role: 'user' | 'assistant';
      content:
        | string
        | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    }> = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `MEETING CONTEXT:\n${contextBlock}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'assistant', content: 'Understood. What would you like to know?' },
      ...history,
    ];

    let answer = '';
    let citations: ChatMessage['citations'] = [];
    try {
      const chatMaxTokens = 8192;
      const res = await callAI({
        model: settings.ai_model,
        system: buildChatSystem(),
        messages,
        max_tokens: chatMaxTokens,
        temperature: 0.3,
      });
      const split = extractCitations(res.text);
      answer = split.text;
      citations = split.citations;
      if (!answer.trim()) {
        logger.warn('chatSend.empty_response', {
          threadId,
          model: res.modelUsed,
          output_tokens: res.usage.output_tokens,
        });
        const exhaustedBudget = res.usage.output_tokens >= chatMaxTokens * 0.9;
        answer = exhaustedBudget
          ? 'The AI response used its full completion budget before returning visible text. Try the question again; I increased the chat budget for future replies.'
          : 'The AI returned an empty response. Try again, or ask the question more specifically.';
      }
    } catch (e) {
      if (e instanceof AIKeyMissingError) {
        answer = e.message;
      } else {
        logger.error('chatSend.failed', { threadId, err: (e as Error).message });
        answer = `Sorry, the chat call failed: ${(e as Error).message}`;
      }
    }

    const asstMsg: ChatMessage = {
      id: 'msg_' + nanoid(10),
      role: 'assistant',
      content: answer,
      created_at: new Date().toISOString(),
      citations,
    };

    const updated = ChatThreads.upsert({
      ...withUser,
      messages: [...withUser.messages, asstMsg],
    });
    return updated;
  }

  async semanticSearch(
    q: string,
    scope?: ChatScope,
  ): Promise<Array<{ meeting: Meeting; snippet: string; score: number }>> {
    const settings = getSettings();
    try {
      const hits: RankedHit[] = await runSemanticSearch(q, scope, settings.ai_model);
      return hits;
    } catch (e) {
      if (e instanceof AIKeyMissingError) {
        logger.warn('semanticSearch.no_key — falling back to FTS only');
        return Meetings.search(q, 10).map((h) => ({
          meeting: h.meeting,
          snippet: h.snippet,
          score: 0.5,
        }));
      }
      logger.error('semanticSearch.failed', { err: (e as Error).message });
      return [];
    }
  }

  async buildPersonProfile(personId: ID): Promise<string> {
    const person = People.get(personId);
    if (!person) throw new Error('Person not found: ' + personId);

    const meetings = Meetings.list({ person_id: personId });
    const digests = meetings.map((m) => meetingDigestForPerson(m, person));

    const settings = getSettings();
    try {
      const res = await callAI({
        model: settings.ai_model,
        system: buildPersonProfileSystem(),
        messages: [{ role: 'user', content: buildPersonProfileUser(person, digests) }],
        max_tokens: 2048,
        temperature: 0.4,
      });
      const md = res.text.trim();
      People.upsert({ ...person, ai_profile: md });
      return md;
    } catch (e) {
      if (e instanceof AIKeyMissingError) return e.message;
      throw e;
    }
  }

  async buildCompanyProfile(companyId: ID): Promise<string> {
    const company = Companies.get(companyId);
    if (!company) throw new Error('Company not found: ' + companyId);

    const meetings = Meetings.list({ company_id: companyId });
    const digests = meetings.map((m) => meetingDigestForCompany(m));

    const settings = getSettings();
    try {
      const res = await callAI({
        model: settings.ai_model,
        system: buildCompanyProfileSystem(),
        messages: [{ role: 'user', content: buildCompanyProfileUser(company, digests) }],
        max_tokens: 2048,
        temperature: 0.4,
      });
      const md = res.text.trim();
      Companies.upsert({ ...company, ai_profile: md });
      return md;
    } catch (e) {
      if (e instanceof AIKeyMissingError) return e.message;
      throw e;
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private async callForNote(
    model: string,
    system: ReturnType<typeof buildNoteSystem>,
    userContent: ReturnType<typeof buildNoteUserMessage>,
    temperature = 0.2,
  ): Promise<NoteOutput> {
    const res = await callAI({
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      tool: {
        name: NOTE_TOOL_NAME,
        description: 'Emit the structured meeting note.',
        input_schema: NOTE_TOOL_SCHEMA,
      },
      forceTool: true,
      max_tokens: 6000,
      temperature,
    });
    return normalizeNoteOutput(parseStructured(NoteOutputSchema, res.toolUseInput, res.text));
  }

  /**
   * Build the per-message context blob for a chat thread by scope. We cap
   * total volume — for "all" we take the 50 most recent meetings.
   */
  private buildChatContext(scope: ChatScope): ChatContextItem[] {
    let meetings: Meeting[] = [];
    switch (scope.kind) {
      case 'all':
        meetings = Meetings.list().slice(0, 50);
        break;
      case 'meeting': {
        const m = Meetings.get(scope.meeting_id);
        meetings = m ? [m] : [];
        break;
      }
      case 'meetings':
        meetings = scope.meeting_ids
          .map((id) => Meetings.get(id))
          .filter((m): m is Meeting => Boolean(m));
        break;
      case 'person':
        meetings = Meetings.list({ person_id: scope.person_id }).slice(0, 50);
        break;
      case 'company':
        meetings = Meetings.list({ company_id: scope.company_id }).slice(0, 50);
        break;
      case 'project':
        meetings = Meetings.list({ project_id: scope.project_id }).slice(0, 50);
        break;
      case 'date_range':
        meetings = Meetings.list({ from: scope.from, to: scope.to }).slice(0, 50);
        break;
      case 'folder':
        meetings = Meetings.list().slice(0, 50);
        break;
      default:
        meetings = Meetings.list().slice(0, 50);
    }

    return meetings.map((m): ChatContextItem => {
      const note = GeneratedNotes.get(m.id);
      const attendees = m.attendees
        .map((id) => People.get(id)?.name)
        .filter((n): n is string => Boolean(n))
        .join(', ');
      // For single-meeting scope, include a transcript excerpt; for broader
      // scopes, summary only to keep token usage reasonable.
      const transcriptExcerpt =
        scope.kind === 'meeting'
          ? excerptTranscript(TranscriptChunks.listByMeeting(m.id), 4000)
          : '';
      return {
        meeting_id: m.id,
        title: m.title,
        started_at: m.started_at,
        attendees: attendees || '(unknown)',
        raw_notes: (m.raw_notes ?? '').slice(0, 800),
        summary: note?.summary?.slice(0, 1200) ?? '',
        transcript_excerpt: transcriptExcerpt,
      };
    });
  }
}

// --------------------------------------------------------------------------
// Module-private helpers
// --------------------------------------------------------------------------

function excerptTranscript(chunks: TranscriptChunk[], maxChars: number): string {
  let total = 0;
  const out: string[] = [];
  for (const c of chunks) {
    if (!c.is_final || c.is_deleted) continue;
    const line = `[${c.id}] ${c.speaker_name ?? c.speaker_id ?? '?'}: ${c.text}`;
    if (total + line.length > maxChars) break;
    total += line.length + 1;
    out.push(line);
  }
  return out.join('\n');
}

function meetingDigestForPerson(m: Meeting, person: Person): ProfileMeetingDigest {
  const note = GeneratedNotes.get(m.id);
  const owned = ActionItems.list({ person_id: person.id })
    .filter((a) => a.meeting_id === m.id)
    .map((a) => a.task);
  return {
    meeting_id: m.id,
    title: m.title,
    started_at: m.started_at,
    summary: note?.summary?.slice(0, 600) ?? '',
    action_items_owned: owned,
    decisions: (note?.decisions ?? []).map((d) => d.text),
    raw_notes: (m.raw_notes ?? '').slice(0, 600),
  };
}

function meetingDigestForCompany(m: Meeting): ProfileMeetingDigest {
  const note = GeneratedNotes.get(m.id);
  const items = ActionItems.list({ company_id: undefined as unknown as ID })
    .filter((a) => a.meeting_id === m.id)
    .map((a) => a.task);
  return {
    meeting_id: m.id,
    title: m.title,
    started_at: m.started_at,
    summary: note?.summary?.slice(0, 600) ?? '',
    action_items_owned: items,
    decisions: (note?.decisions ?? []).map((d) => d.text),
    raw_notes: (m.raw_notes ?? '').slice(0, 600),
  };
}

/**
 * Strip the trailing <<CITATIONS>>...<</CITATIONS>> JSON block from chat
 * output and return both the clean text and the parsed citations.
 */
function extractCitations(raw: string): {
  text: string;
  citations: NonNullable<ChatMessage['citations']>;
} {
  const re = /<<CITATIONS>>\s*([\s\S]*?)\s*<<\/CITATIONS>>/;
  const m = raw.match(re);
  if (!m) return { text: raw.trim(), citations: [] };
  const cleaned = raw.replace(re, '').trim();
  try {
    const arr = JSON.parse(m[1]) as Array<{ meeting_id: ID; chunk_id?: ID; quote?: string }>;
    return { text: cleaned, citations: arr };
  } catch {
    return { text: cleaned, citations: [] };
  }
}

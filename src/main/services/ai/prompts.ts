/**
 * All prompt builders for the AI Note Engine.
 *
 * Every function returns either a system-block array or a user-message string.
 * Prompts are split out from the engine for two reasons:
 *  1. They're the highest-leverage knob in the system — keeping them in one
 *     file makes them easy to tune and review.
 *  2. The note-generation system prompt is long and stable, so we mark it
 *     cache_control: 'ephemeral' to get prompt-caching across calls
 *     (regenerateSection, transformNote, follow-up Q&A all hit cache).
 *
 * Quality rules from spec §29 are baked into the system prompt verbatim.
 */
import type {
  Meeting,
  TranscriptChunk,
  Template,
  GeneratedNote,
  Settings,
  Person,
  Company,
} from '@shared/types/entities';
import type { SystemBlock } from './ai-client';

// --------------------------------------------------------------------------
// Shared §29 quality rules — included in every note-generation prompt.
// --------------------------------------------------------------------------

const QUALITY_RULES = `You are the note engine for a personal AI meeting notetaker. Quality rules (these are non-negotiable):

1. RAW NOTES ARE THE STRONGEST SIGNAL. The user typed those during the meeting on purpose. Treat them as source of truth, not the transcript. Reorganize and expand them — never replace them with generic transcript summary.
2. NEVER INVENT COMMITMENTS. An action item only exists if a person clearly accepted or promised to do something in the transcript or raw notes. Do not infer commitments from passing mentions.
3. MARK UNCERTAIN OWNERS. If you're not sure who owns an action item, set the owner to "unclear" and lower the confidence score. Never guess a name.
4. CITE TRANSCRIPT EVIDENCE. For decisions, action items, and quotes, populate source_chunk_ids with the chunk ids you used. Empty array is fine if the source is raw notes only.
5. CONCRETE BULLETS, NOT VAGUE SUMMARIES. "Discussed pricing" is useless. Prefer "Agreed to drop the enterprise tier from $2k → $1.5k starting Q3."
6. DO NOT SUMMARIZE GAPS. If the transcript has a silent or low-confidence stretch, just don't mention that period. Never write "the meeting paused" or "audio was unclear."
7. RESPECT WORD-LEVEL CONFIDENCE. When transcript chunks are flagged as low-confidence, do not extract direct quotes from them. Paraphrase, or skip.
8. PRESERVE EXACT QUOTES ONLY WHEN HIGH CONFIDENCE. Quotes in the "quotes" array must be verbatim from a high-confidence chunk. If unsure, omit the quote.
9. SPEAK IN THE FIRST PERSON when the user ("Me") is the actor. The user is the owner of these notes.
10. NO HALLUCINATIONS ABOUT TIME, AMOUNTS, OR PEOPLE. If a number, date, or name isn't explicit, leave it out.`;

const OUTLINE_NOTE_STYLE = `Readable note-page format:

- Create a specific, topic-driven title from the transcript. Prefer "Universe formation and life constraints in alternative cosmological models" over "Quick note" or "Meeting notes".
- The finished note should read like high-quality study notes, not an executive meeting recap, whenever the transcript is a lecture, class, video, research talk, brainstorming monologue, or other content-heavy session.
- Use topical section headings that describe the subject matter. Avoid generic headings like "Summary", "Key discussion points", "Discussion", or "Topic" unless the meeting is truly too thin to organize.
- Each section body should be markdown bullets, with nested bullets for supporting details:
  - Top-level bullets capture the main idea.
  - Nested bullets capture definitions, mechanisms, evidence, constraints, examples, or caveats.
- Keep bullets concise and information-dense. Remove filler like "the speaker discussed", "they talked about", "it was mentioned that", and "overall".
- Preserve relationships between ideas: cause/effect, comparisons, sequences, assumptions, constraints, and consequences.
- Do not flatten technical or conceptual material into a few sentences. If the transcript contains a rich explanation, build an outline with enough sections to be useful later.
- The summary field should be a short thesis/overview only. Put the real notes in sections.
- For normal business meetings, still extract decisions/action items separately, but make the sections concrete and scannable.`;

// --------------------------------------------------------------------------
// Tool/JSON schema for structured note output.
// --------------------------------------------------------------------------

export const NOTE_TOOL_NAME = 'emit_meeting_note';

export const NOTE_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: {
      type: ['string', 'null'],
      description:
        'Specific title for this note (usually 6-14 words, no trailing punctuation, no quotes). For lectures or talks, name the actual subject. Examples: "Universe formation and life constraints in alternative cosmological models", "Acme Robotics pilot kickoff". Return null ONLY if there is genuinely too little content to title.',
    },
    summary: {
      type: 'string',
      description:
        'Short markdown thesis/overview, 1-3 sentences. The detailed note belongs in sections as outline-style markdown bullets.',
    },
    sections: {
      type: 'array',
      description:
        'Topical note sections. Use specific subject-matter headings and markdown bullet bodies with nested bullets where useful.',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          body: { type: 'string', description: 'Markdown body. Use bullets for lists.' },
        },
        required: ['heading', 'body'],
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          source_chunk_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'source_chunk_ids'],
      },
    },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string', description: 'Name, "me", or "unclear".' },
          due_date: { type: ['string', 'null'], description: 'ISO 8601 date or null.' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          source_chunk_ids: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['task', 'owner', 'source_chunk_ids', 'confidence'],
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          text: { type: 'string' },
          source_chunk_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['speaker', 'text', 'source_chunk_ids'],
      },
    },
    follow_up_email: {
      type: ['string', 'null'],
      description: 'A drafted follow-up email if the meeting clearly warrants one. Otherwise null.',
    },
    personal_reminders: {
      type: 'array',
      items: { type: 'string' },
      description: 'Personal nudges for the user only — things they should remember/do that aren\'t formal action items.',
    },
  },
  required: [
    'summary',
    'sections',
    'decisions',
    'action_items',
    'open_questions',
    'risks',
    'quotes',
    'personal_reminders',
  ],
};

// --------------------------------------------------------------------------
// Note-generation prompt
// --------------------------------------------------------------------------

export interface PreviousMeetingDigest {
  title: string;
  started_at: string;
  summary: string;
  open_action_items: string[];
}

export interface NotePromptInput {
  meeting: Meeting;
  template: Template;
  chunks: TranscriptChunk[];
  rawNotes: string;
  settings: Settings;
  attendeeNames: string[];
  previousMeetings: PreviousMeetingDigest[];
  tone?: string;
  length?: 'short' | 'medium' | 'detailed';
}

/**
 * Build the SYSTEM blocks. The first block (rules + template + style) is
 * cached so subsequent calls (regenerateSection, transformNote) can reuse
 * the same prefix and only pay for the user-message diff.
 */
export function buildNoteSystem(input: NotePromptInput): SystemBlock[] {
  const { template, settings, tone, length } = input;
  const tonePref = tone ?? settings.default_note_tone;
  const lengthPref = length ?? settings.default_note_style;
  const formatPref = settings.default_note_format;

  const sectionList = template.required_sections
    .map((s) => `- ${s} (REQUIRED)`)
    .concat(template.optional_sections.map((s) => `- ${s} (optional, include if relevant)`))
    .join('\n');

  const text = `${QUALITY_RULES}

${OUTLINE_NOTE_STYLE}

Template: ${template.name}
When to use: ${template.when_to_use}
Description: ${template.description}

Sections to cover:
${sectionList}

For specialized meeting templates, cover the required template sections. For General Meeting, Class Lecture, lectures, classes, talks, research explanations, and transcript-heavy notes, translate the generic template sections into specific topical headings based on the transcript. The output should look like a structured note page with subject-matter headings and nested bullets.

Formatting rules: ${template.formatting_rules || '(default markdown bullets)'}
Action item format: ${template.action_item_format || '(default: task — owner — due date)'}
Follow-up style: ${template.follow_up_style || '(default direct, plain prose)'}

Style preferences:
- Tone: ${tonePref}
- Length: ${lengthPref} (short = compact but complete, medium = thorough outline, detailed = expanded study notes)
- Format preset: ${formatPref}

Output: invoke the ${NOTE_TOOL_NAME} tool with the structured JSON described in its schema. Do not produce free-form text outside the tool call.`;

  return [
    {
      type: 'text',
      text,
      // Cache the long, stable system prefix so follow-up calls (regenerate,
      // transform, chat about this note) hit the cache.
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Render the user-message body. The transcript portion is also marked
 * cache_control so re-asks on the same meeting reuse it.
 */
export function buildNoteUserMessage(input: NotePromptInput): Array<{
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}> {
  const { meeting, chunks, rawNotes, attendeeNames, previousMeetings } = input;

  const meta = [
    `Meeting title: ${meeting.title}`,
    `Date: ${meeting.started_at}`,
    `Source app: ${meeting.source_app}`,
    `Attendees: ${attendeeNames.length ? attendeeNames.join(', ') : '(unknown)'}`,
    meeting.language ? `Language: ${meeting.language}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const rawNotesBlock = rawNotes?.trim()
    ? `RAW NOTES (highest priority — typed by the user during the meeting):\n${rawNotes.trim()}`
    : 'RAW NOTES: (none — user did not type notes during this meeting)';

  const transcriptText = renderTranscript(chunks);

  const previousBlock = previousMeetings.length
    ? `PREVIOUS MEETINGS WITH THESE ATTENDEES (most recent first, for context only — do not duplicate):\n${previousMeetings
        .map(
          (p) =>
            `- ${p.title} (${p.started_at})\n  Summary: ${p.summary || '(none)'}\n  Open action items: ${
              p.open_action_items.length ? p.open_action_items.join('; ') : '(none)'
            }`,
        )
        .join('\n')}`
    : '';

  return [
    { type: 'text', text: `MEETING METADATA:\n${meta}` },
    { type: 'text', text: rawNotesBlock },
    {
      type: 'text',
      text: `TRANSCRIPT (chunk_id | start | speaker | text — confidence noted when low):\n${transcriptText}`,
      // Long content — worth caching for follow-up calls on the same meeting.
      cache_control: { type: 'ephemeral' },
    },
    ...(previousBlock ? [{ type: 'text' as const, text: previousBlock }] : []),
    {
      type: 'text',
      text: `Now produce the note by invoking ${NOTE_TOOL_NAME}. Build the sections from the transcript itself, using the readable note-page format and the quality rules.`,
    },
  ];
}

/**
 * Render transcript with per-chunk ids, timestamps, speakers, and a
 * confidence flag when below 0.7 so Claude can avoid quoting it verbatim.
 */
function renderTranscript(chunks: TranscriptChunk[]): string {
  if (!chunks.length) return '(no transcript captured)';
  const lines = chunks.map((c) => {
    const t = formatSeconds(c.start_time);
    const speaker = c.speaker_name || c.speaker_id || 'unknown';
    const lowConf = typeof c.confidence === 'number' && c.confidence < 0.7;
    const flag = lowConf ? ' [LOW_CONFIDENCE]' : '';
    return `[${c.id}] ${t} ${speaker}: ${c.text}${flag}`;
  });
  return lines.join('\n');
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// --------------------------------------------------------------------------
// Regenerate-section prompt
// --------------------------------------------------------------------------

/**
 * Re-render the system block for "regenerate one section". We reuse the
 * note-generation system (so prompt-cache still hits) and only swap the
 * final instruction in the user message.
 */
export function buildRegenerateSectionUser(
  noteInput: NotePromptInput,
  existing: GeneratedNote,
  sectionHeading: string,
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  const base = buildNoteUserMessage(noteInput);
  // Replace final instruction.
  base[base.length - 1] = {
    type: 'text',
    text: `Existing note JSON for context (do not regenerate the whole thing):\n${JSON.stringify(
      {
        summary: existing.summary,
        sections: existing.sections,
      },
      null,
      2,
    )}\n\nRegenerate ONLY the section titled "${sectionHeading}". Invoke ${NOTE_TOOL_NAME} but populate ONLY the "sections" array with a single object {heading: "${sectionHeading}", body: "..."}. Leave all other fields as empty arrays/strings.`,
  };
  return base;
}

// --------------------------------------------------------------------------
// Transform-note prompt
// --------------------------------------------------------------------------

export const TRANSFORM_TOOL_NAME = 'emit_transformed_note';

export const TRANSFORM_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { heading: { type: 'string' }, body: { type: 'string' } },
        required: ['heading', 'body'],
      },
    },
    follow_up_email: { type: ['string', 'null'] },
  },
  required: ['summary', 'sections'],
};

export function buildTransformSystem(kind: string): SystemBlock[] {
  const text = `You transform an existing AI-generated meeting note into a different shape: "${kind}".

Common kinds:
- "shorter": tighten to ~150 words. Keep only the most important points.
- "detailed": expand into structured study notes with topical headings and nested markdown bullets. Add context only from the existing note; never invent facts.
- "study_notes": reorganize into a polished note page with a concise overview, topical headings, and nested bullets.
- "follow_up_email": produce ONE email draft (subject implicit, body only) that the user can send to attendees. Set sections to [{heading: "Email", body: <email>}].
- "product_spec": reorganize into a product spec — Problem, Goals, Non-Goals, Proposal, Risks, Open Questions.
- "investor_update": reorganize into an investor update — Highlights, Metrics, Asks, Lowlights.
- "crm": reorganize into a CRM entry — Account, Contact, Stage, Next Steps, Notes.

Rules:
- Use ONLY information present in the input note. Never introduce new facts.
- Preserve the original structured action items in spirit; the transform is presentational.
- Prefer subject-matter headings and nested bullets over generic recap prose.
- Output via the ${TRANSFORM_TOOL_NAME} tool.`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildTransformUser(existing: GeneratedNote, kind: string): string {
  return `Existing note JSON:\n${JSON.stringify(
    {
      summary: existing.summary,
      sections: existing.sections,
      decisions: existing.decisions,
      action_items: existing.action_items,
      open_questions: existing.open_questions,
      risks: existing.risks,
      quotes: existing.quotes,
    },
    null,
    2,
  )}\n\nTransform to: ${kind}. Invoke ${TRANSFORM_TOOL_NAME}.`;
}

// --------------------------------------------------------------------------
// Chat prompt
// --------------------------------------------------------------------------

export interface ChatContextItem {
  meeting_id: string;
  title: string;
  started_at: string;
  attendees: string;
  raw_notes: string;
  summary: string;
  transcript_excerpt: string;
}

export function buildChatSystem(): SystemBlock[] {
  const text = `You are an assistant answering questions across the user's meeting history.

Rules:
- Answer ONLY from the provided meeting context. If the answer isn't there, say so plainly.
- Cite the meeting(s) you used. Quote a short verbatim phrase from the relevant chunk when helpful.
- Be concrete and chronological when summarizing.
- Keep the visible answer concise. For requests like "last 4 meetings", use exactly those recent meetings and write one short section or 2-4 bullets per meeting.
- The user is "Me" — speak directly, second person ("you said…", "your meeting with…").

Format your answer as plain markdown text. At the very end of your reply, on its own line, emit a JSON block tagged like:

<<CITATIONS>>
[{"meeting_id":"mtg_xxx","quote":"..."}]
<</CITATIONS>>

Include only meetings you actually used. The JSON must be valid; if no citations, emit an empty array.`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function renderChatContext(items: ChatContextItem[]): string {
  if (!items.length) return '(no meetings in scope)';
  return items
    .map(
      (m) =>
        `=== MEETING ${m.meeting_id} ===\nTitle: ${m.title}\nDate: ${m.started_at}\nAttendees: ${m.attendees}\nRaw notes: ${m.raw_notes || '(none)'}\nSummary: ${m.summary || '(none)'}\nTranscript excerpt: ${m.transcript_excerpt || '(none)'}`,
    )
    .join('\n\n');
}

// --------------------------------------------------------------------------
// Person / company profile prompts
// --------------------------------------------------------------------------

export interface ProfileMeetingDigest {
  meeting_id: string;
  title: string;
  started_at: string;
  summary: string;
  action_items_owned: string[];
  decisions: string[];
  raw_notes: string;
}

export function buildPersonProfileSystem(): SystemBlock[] {
  const text = `You build a short, useful profile of one person based on the user's meetings with them.

Rules:
- Concrete only. No filler. If a section has nothing, write "(none yet)".
- Use the user's voice (first person — "I"). The user is "Me".
- Cite specific past meeting moments where helpful.

Output: pure markdown with these sections (in this order):

# {Name}
**Relationship summary** — 2-3 sentences.
**Things they care about** — bullet list.
**Past commitments** — what they have promised. Bullet list with date in parens.
**Open items** — bullet list of unresolved follow-ups.
**Suggested follow-ups** — bullet list of things I should do next.`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildPersonProfileUser(person: Person, meetings: ProfileMeetingDigest[]): string {
  return `Person: ${person.name}${person.email ? ` <${person.email}>` : ''}${
    person.role ? ` — ${person.role}` : ''
  }${person.relationship_type ? ` (${person.relationship_type})` : ''}

User notes about them: ${person.notes || '(none)'}

Meetings (most recent first):
${meetings
  .map(
    (m) =>
      `--- ${m.meeting_id} | ${m.title} | ${m.started_at}\nSummary: ${m.summary || '(none)'}\nDecisions: ${
        m.decisions.length ? m.decisions.join('; ') : '(none)'
      }\nAction items they own: ${
        m.action_items_owned.length ? m.action_items_owned.join('; ') : '(none)'
      }\nMy raw notes: ${m.raw_notes || '(none)'}`,
  )
  .join('\n\n')}

Now write the markdown profile.`;
}

export function buildCompanyProfileSystem(): SystemBlock[] {
  const text = `You build a short, useful profile of one company based on the user's meetings with people from it.

Same shape as the person profile, but framed as a company:

# {Company name}
**Relationship summary** — 2-3 sentences.
**Things they care about** — bullets.
**Past commitments** — what their team has promised.
**Open items** — unresolved follow-ups across this company.
**Suggested follow-ups** — what I should do next.`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildCompanyProfileUser(company: Company, meetings: ProfileMeetingDigest[]): string {
  return `Company: ${company.name}${company.domain ? ` (${company.domain})` : ''}
User notes: ${company.notes || '(none)'}

Meetings:
${meetings
  .map(
    (m) =>
      `--- ${m.meeting_id} | ${m.title} | ${m.started_at}\nSummary: ${m.summary || '(none)'}\nDecisions: ${
        m.decisions.length ? m.decisions.join('; ') : '(none)'
      }\nAction items: ${m.action_items_owned.length ? m.action_items_owned.join('; ') : '(none)'}\nRaw notes: ${m.raw_notes || '(none)'}`,
  )
  .join('\n\n')}

Now write the markdown profile.`;
}

// --------------------------------------------------------------------------
// Semantic-search re-rank prompt
// --------------------------------------------------------------------------

export const SEARCH_RERANK_TOOL_NAME = 'emit_search_scores';

export const SEARCH_RERANK_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          meeting_id: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['meeting_id', 'score'],
      },
    },
  },
  required: ['scores'],
};

export function buildSearchRerankSystem(): SystemBlock[] {
  const text = `You score the relevance of meeting candidates to a user's search query.
For each candidate, output a score between 0 and 1.
- 1.0 = directly answers the query
- 0.7 = strongly related
- 0.3 = tangentially related
- 0.0 = unrelated

Be strict. Most candidates should score below 0.5. Invoke the ${SEARCH_RERANK_TOOL_NAME} tool with one entry per candidate.`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildSearchRerankUser(
  query: string,
  candidates: Array<{ meeting_id: string; title: string; snippet: string; started_at: string }>,
): string {
  return `Query: ${query}

Candidates:
${candidates
  .map((c) => `--- ${c.meeting_id} | ${c.title} | ${c.started_at}\nSnippet: ${c.snippet}`)
  .join('\n\n')}

Score each.`;
}

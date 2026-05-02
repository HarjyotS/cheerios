/**
 * Semantic search.
 *
 * Approach (per spec): rather than maintaining an embedding index (cost,
 * complexity, sync-on-edit), we use the existing SQLite FTS5 index on
 * meetings + chunks for keyword recall, then ask Claude to re-rank the
 * top candidates by semantic relevance.
 *
 * This gives us "search means it" semantics without an embedding pipeline.
 */
import { z } from 'zod';
import { Meetings, GeneratedNotes } from '@main/db/repositories';
import type { Meeting, ChatScope } from '@shared/types/entities';
import { callAI } from './ai-client';
import {
  SEARCH_RERANK_TOOL_NAME,
  SEARCH_RERANK_TOOL_SCHEMA,
  buildSearchRerankSystem,
  buildSearchRerankUser,
} from './prompts';

const ScoresSchema = z.object({
  scores: z.array(z.object({ meeting_id: z.string(), score: z.number().min(0).max(1) })),
});

export interface RankedHit {
  meeting: Meeting;
  snippet: string;
  score: number;
}

/**
 * Convert a free-text query into an FTS5 query string. SQLite FTS5 chokes
 * on bare punctuation; we keep alphanumerics and join with spaces (implicit
 * AND). Quoted phrases are preserved.
 */
function toFtsQuery(q: string): string {
  const cleaned = q
    .replace(/[^\w\s"'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || q;
}

function inScope(m: Meeting, scope?: ChatScope): boolean {
  if (!scope || scope.kind === 'all') return true;
  switch (scope.kind) {
    case 'meeting':
      return m.id === scope.meeting_id;
    case 'meetings':
      return scope.meeting_ids.includes(m.id);
    case 'person':
      return m.attendees.includes(scope.person_id);
    case 'company':
      return m.company_ids.includes(scope.company_id);
    case 'project':
      return m.project_ids.includes(scope.project_id);
    case 'folder':
      // Folder scoping isn't represented on Meeting — treat as no-op.
      return true;
    case 'date_range':
      return m.started_at >= scope.from && m.started_at <= scope.to;
    default:
      return true;
  }
}

export async function semanticSearch(
  query: string,
  scope: ChatScope | undefined,
  modelForRerank: string,
): Promise<RankedHit[]> {
  if (!query.trim()) return [];

  // 1) FTS recall — top 50.
  const ftsHits = Meetings.search(toFtsQuery(query), 50).filter((h) => inScope(h.meeting, scope));
  if (!ftsHits.length) return [];

  // 2) Claude re-rank.
  const candidates = ftsHits.map((h) => ({
    meeting_id: h.meeting.id,
    title: h.meeting.title,
    started_at: h.meeting.started_at,
    snippet:
      h.snippet || GeneratedNotes.get(h.meeting.id)?.summary?.slice(0, 280) || h.meeting.title,
  }));

  let scored: Array<{ meeting_id: string; score: number }> = [];
  try {
    const res = await callAI({
      model: modelForRerank,
      system: buildSearchRerankSystem(),
      messages: [{ role: 'user', content: buildSearchRerankUser(query, candidates) }],
      tool: {
        name: SEARCH_RERANK_TOOL_NAME,
        description: 'Emit relevance scores for each candidate meeting.',
        input_schema: SEARCH_RERANK_TOOL_SCHEMA,
      },
      forceTool: true,
      max_tokens: 1024,
      temperature: 0,
    });
    if (res.toolUseInput) {
      const parsed = ScoresSchema.safeParse(res.toolUseInput);
      if (parsed.success) scored = parsed.data.scores;
    }
  } catch {
    // Fall back to FTS-only ordering if rerank fails.
    scored = candidates.map((c, i) => ({ meeting_id: c.meeting_id, score: 1 - i / candidates.length }));
  }

  const scoreMap = new Map(scored.map((s) => [s.meeting_id, s.score]));
  const out: RankedHit[] = ftsHits
    .map((h) => ({ meeting: h.meeting, snippet: h.snippet, score: scoreMap.get(h.meeting.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return out;
}

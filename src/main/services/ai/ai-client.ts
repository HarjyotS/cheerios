/**
 * OpenAI API client wrapper.
 *
 * Responsibilities:
 *  - Resolve the OpenAI API key from secret storage. Throw a helpful
 *    AIKeyMissingError if not configured so callers can surface it cleanly.
 *  - Wrap openai.chat.completions.create with:
 *      • automatic model fallback (the user-configured model name might be
 *        rejected by the API if it's a "latest alias" the bound version
 *        doesn't recognize — fall back to a known model id).
 *      • tool/function-calling support to force structured JSON output.
 *      • OpenAI auto-caches long, stable prompt prefixes (>1024 tokens) at no
 *        cost — callers don't need to mark blocks. We accept the legacy
 *        `cache_control` markers from the prompt builders and ignore them so
 *        the rest of the codebase didn't have to change.
 *      • exponential backoff for transient 5xx / 429 / network errors.
 *      • lightweight token-usage logging.
 *
 * Output: a normalized response shape {text, toolUseInput?, usage} so the
 * caller doesn't have to walk OpenAI's choices/tool_calls structure.
 */
import OpenAI from 'openai';
import { getSecret, SECRET_KEYS } from '@main/lib/secrets';
import { log } from '@main/lib/logger';

const logger = log('ai');

// --------------------------------------------------------------------------
// Public types — kept identical to the previous (Anthropic-shaped) wrapper
// so the prompt builders and engine don't need to change. The
// `cache_control` field is accepted for compatibility but ignored —
// OpenAI handles caching automatically.
// --------------------------------------------------------------------------

export interface SystemBlock {
  type: 'text';
  text: string;
  /** Compatibility shim — OpenAI auto-caches long prefixes; this is ignored. */
  cache_control?: { type: 'ephemeral' };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  input_schema: Record<string, unknown>;
}

type UserContentBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

export interface AICallOpts {
  /** Model from settings; falls back automatically if rejected. */
  model: string;
  system: SystemBlock[];
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | UserContentBlock[];
  }>;
  max_tokens?: number;
  temperature?: number;
  /** Optional tool — used to force structured JSON output. */
  tool?: ToolDef;
  /** When provided with `tool`, forces the model to invoke that tool. */
  forceTool?: boolean;
}

export interface AICallResult {
  /** Concatenated text-block output. Empty if the model went tool-only. */
  text: string;
  /** If a tool was invoked, this is the structured JSON input the model produced. */
  toolUseInput: Record<string, unknown> | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Tokens served from OpenAI's automatic prompt cache. */
    cache_read_input_tokens?: number;
  };
  /** The model id actually used (after any fallback). */
  modelUsed: string;
}

// --------------------------------------------------------------------------
// Public friendly error so callers can branch on "no key" without parsing
// strings.
// --------------------------------------------------------------------------

export class AIKeyMissingError extends Error {
  constructor() {
    super('Set OPENAI_API_KEY in keychain (key: openai.api_key).');
    this.name = 'AIKeyMissingError';
  }
}

// --------------------------------------------------------------------------
// Singleton-ish client. We re-create when the key changes — cheap.
// --------------------------------------------------------------------------

let cachedKey: string | null = null;
let cachedClient: OpenAI | null = null;

async function getClient(): Promise<OpenAI> {
  const key = await getSecret(SECRET_KEYS.openaiApiKey);
  if (!key) throw new AIKeyMissingError();
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedKey = key;
  cachedClient = new OpenAI({ apiKey: key });
  return cachedClient;
}

// Known fallbacks if the API rejects the configured model.
// Order matters — most capable first.
const MODEL_FALLBACKS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
];

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string };
  if (e.status && e.status >= 500 && e.status < 600) return true;
  if (e.status === 429) return true;
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') return true;
  return false;
}

function isModelNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string; code?: string };
  if (e.status === 404) return true;
  if (e.code === 'model_not_found') return true;
  if (typeof e.message === 'string' && /model.*(not found|does not exist|unsupported)/i.test(e.message)) return true;
  return false;
}

function isUnsupportedTemperature(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string };
  return (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /temperature/i.test(e.message) &&
    /(unsupported|not supported|only the default)/i.test(e.message)
  );
}

function isUnsupportedMaxTokens(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string };
  return (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /max_tokens/i.test(e.message) &&
    /(unsupported|not supported|max_completion_tokens)/i.test(e.message)
  );
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// Shape adapters: convert our prompt-builder shapes into OpenAI shapes.
// --------------------------------------------------------------------------

/** Flatten our SystemBlock[] into a single system message string. */
function flattenSystem(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/** Flatten our user/assistant content into the OpenAI message shape. */
function toOpenAIMessage(m: { role: 'user' | 'assistant'; content: string | UserContentBlock[] }): {
  role: 'user' | 'assistant';
  content: string;
} {
  const text = typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('\n\n');
  return { role: m.role, content: text };
}

/**
 * Core call. Handles model fallback, retries, tool calling, and result
 * normalization. The system prompt and any cache_control hints are passed
 * through and translated to whatever the OpenAI API understands.
 */
export async function callAI(opts: AICallOpts): Promise<AICallResult> {
  const client = await getClient();
  const candidates = [opts.model, ...MODEL_FALLBACKS.filter((m) => m !== opts.model)];

  const systemText = flattenSystem(opts.system);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemText },
    ...opts.messages.map(toOpenAIMessage),
  ];

  // OpenAI tool: { type:'function', function: { name, description, parameters } }
  const tools = opts.tool
    ? [
        {
          type: 'function' as const,
          function: {
            name: opts.tool.name,
            description: opts.tool.description,
            parameters: opts.tool.input_schema,
          },
        },
      ]
    : undefined;

  const tool_choice = opts.tool && opts.forceTool
    ? ({ type: 'function' as const, function: { name: opts.tool.name } })
    : undefined;

  let lastErr: unknown = null;
  for (const model of candidates) {
    // gpt-5 / o1 / o3 reasoning models reject `max_tokens` (require
    // `max_completion_tokens`) and only accept the default temperature.
    // gpt-4o accepts either name, so we unconditionally use the new one.
    let skipTemperature = /^(gpt-5|o1|o3)/i.test(model);
    let attempt = 0;
    let params: Record<string, unknown> = {};
    while (attempt < 4) {
      try {
        params = {
          model,
          messages,
          max_completion_tokens: opts.max_tokens ?? 4096,
        };
        if (!skipTemperature) {
          params.temperature = opts.temperature ?? 0.2;
        }
        if (tools) {
          params.tools = tools;
          if (tool_choice) params.tool_choice = tool_choice;
        }

        const res = await client.chat.completions.create(
          params as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
        ) as OpenAI.Chat.Completions.ChatCompletion;

        const choice = res.choices[0];
        const msg = choice?.message;

        let text = '';
        let toolUseInput: Record<string, unknown> | null = null;

        if (msg?.content) {
          text = typeof msg.content === 'string' ? msg.content : '';
        }
        if (msg?.tool_calls && msg.tool_calls.length > 0) {
          const call = msg.tool_calls[0];
          if (call.type === 'function' && call.function?.arguments) {
            try {
              toolUseInput = JSON.parse(call.function.arguments) as Record<string, unknown>;
            } catch (e) {
              logger.warn('ai.tool_args_parse_failed', { err: (e as Error).message });
            }
          }
        }

        const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const cachedRead = (usage as any)?.prompt_tokens_details?.cached_tokens as number | undefined;

        const out: AICallResult = {
          text,
          toolUseInput,
          usage: {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            cache_read_input_tokens: cachedRead,
          },
          modelUsed: model,
        };

        logger.info('ai.call', {
          model,
          input_tokens: out.usage.input_tokens,
          output_tokens: out.usage.output_tokens,
          cache_read: out.usage.cache_read_input_tokens ?? 0,
        });

        return out;
      } catch (err) {
        lastErr = err;
        if (isModelNotFound(err)) {
          // Move to next candidate model; don't retry this one.
          break;
        }
        if (isUnsupportedTemperature(err) && !skipTemperature) {
          // Reasoning model the regex didn't catch — retry without temperature.
          logger.warn('ai.retry_no_temperature', { model });
          skipTemperature = true;
          continue; // rebuild params at top of loop
        }
        if (isUnsupportedMaxTokens(err)) {
          // We already use max_completion_tokens; this branch is just defensive
          // logging in case OpenAI ever changes the param name again.
          logger.warn('ai.unsupported_max_tokens_unexpected', { model, msg: (err as Error).message });
        }
        if (isTransient(err) && attempt < 3) {
          const wait = 400 * Math.pow(2, attempt);
          logger.warn('ai.retry', { attempt, wait, err: (err as Error).message });
          await sleep(wait);
          attempt++;
          continue;
        }
        // Non-retryable, non-model error — propagate.
        throw err;
      }
    }
  }

  throw lastErr ?? new Error('AI call failed for all candidate models');
}

/**
 * Backwards-compatible alias so any straggling import of `callClaude` keeps
 * working during the OpenAI swap. New code should use `callAI`.
 */
export const callClaude = callAI;

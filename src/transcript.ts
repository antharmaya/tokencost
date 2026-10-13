/**
 * Reading a real transcript, and being honest about what it can prove.
 *
 * The whole point of analysing a log rather than a scenario is that a log
 * contains facts. But not every log contains the same facts, and the difference
 * decides whether a finding is an assertion or a guess:
 *
 *   - Anthropic, Bedrock and Langfuse expose cache_read_input_tokens, so the
 *     achieved hit rate is MEASURED.
 *   - OpenAI folds cache reads into prompt_tokens, so the hit rate there can
 *     only be INFERRED, and must be labelled that way.
 *
 * A tool that presents a guess in the same typeface as a measurement is worse
 * than one that stays quiet, because the reader cannot tell which is which.
 */

import { createHash } from 'node:crypto';
import { ratesFor } from './cost.js';
import type { ModelPrice } from './types.js';

/** A single request/response pair pulled out of whatever the log looked like. */
export interface TranscriptTurn {
  index: number;
  /** ISO timestamp of the request, when the log carries one. */
  at?: string;
  model?: string;
  /** Serialised tool definitions, for byte-comparison across turns. */
  toolsRaw?: string;
  /** Whether any image block appeared in this request. */
  hasImage: boolean;
  /** Serialised thinking/effort configuration, if present. */
  thinkingRaw?: string;
  /**
   * The WHOLE prompt the provider processed: fresh tokens plus cache reads plus
   * cache writes. Providers disagree on what their own `input_tokens` means —
   * see `parseTranscript` — so it is normalised here once.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Present only where the provider reports it. Absent is not zero. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** Which adapter matched, so the report can state its own fidelity. */
  format: 'anthropic' | 'openai' | 'generic';
  /** True when the provider reports cache tokens separately. */
  cacheTokensReported: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Stable stringify so key order in the log does not masquerade as a change. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

function hasImageBlock(messages: unknown): boolean {
  const s = JSON.stringify(messages ?? '');
  return s.includes('"type":"image"') || s.includes('"image_url"');
}

/**
 * Parse a log into turns.
 *
 * Accepts a JSON array, or JSONL (one record per line) which is what most SDK
 * session logs actually are. Each record may be a raw request, or a wrapper of
 * the shape { request, response, timestamp } — both appear in the wild.
 */
export function parseTranscript(raw: string): Transcript {
  const records = readRecords(raw);
  let cacheTokensReported = false;
  let format: Transcript['format'] = 'generic';

  const turns: TranscriptTurn[] = records.map((rec, index) => {
    const req = (rec.request ?? rec.body ?? rec) as Record<string, unknown>;
    // `a ?? b ? c : d` parses as `(a ?? b) ? c : d`, which always picked the
    // wrapper and then found no usage on it — every token count silently came
    // back zero. Read the nested shape directly instead of being clever.
    const usage = (rec.response?.usage ??
      rec.usage ??
      {}) as Record<string, number>;

    // The two families report the same three quantities in opposite shapes.
    //
    // Anthropic (and Bedrock) split the prompt into three counters that do not
    // overlap: `input_tokens` is only what was neither read from nor written to
    // the cache, and the prompt is the sum of all three. Treating that field as
    // the whole prompt, which this parser did before 0.1.0, inflates the hit
    // rate (reads over a denominator that excludes them) and bills cache
    // writes at nothing.
    //
    // OpenAI reports the total as `input_tokens` / `prompt_tokens` and breaks
    // the cached part out underneath it in `*_tokens_details`.
    const partRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens;
    const partWrite = usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens;
    const splitCounters = partRead !== undefined || partWrite !== undefined;
    const details = ((usage as Record<string, unknown>).input_tokens_details ??
      (usage as Record<string, unknown>).prompt_tokens_details) as
      | Record<string, number>
      | undefined;

    const read = partRead ?? details?.cached_tokens;
    const write = partWrite ?? details?.cache_write_tokens;
    if (read !== undefined || write !== undefined) cacheTokensReported = true;
    if (splitCounters) {
      format = 'anthropic';
    } else if (usage.prompt_tokens !== undefined || details !== undefined) {
      format = format === 'anthropic' ? format : 'openai';
    }

    const reportedInput = (usage.input_tokens ??
      usage.prompt_tokens ??
      usage.inputTokens) as number | undefined;
    const inputTokens =
      reportedInput === undefined
        ? undefined
        : splitCounters
          ? reportedInput + (partRead ?? 0) + (partWrite ?? 0)
          : reportedInput;

    return {
      index,
      at: (rec.timestamp ?? rec.at ?? rec.created_at) as string | undefined,
      model: req.model as string | undefined,
      toolsRaw: req.tools ? canonical(req.tools) : undefined,
      hasImage: hasImageBlock(req.messages),
      thinkingRaw:
        req.thinking || req.reasoning_effort || req.effort
          ? canonical({
              thinking: req.thinking,
              effort: req.reasoning_effort ?? req.effort,
            })
          : undefined,
      inputTokens,
      outputTokens:
        (usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens) as
          | number
          | undefined,
      cacheReadTokens: read,
      cacheWriteTokens: write,
    };
  });

  return { turns, format, cacheTokensReported };
}

function readRecords(raw: string): Array<Record<string, any>> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of turns.');
    return parsed;
  }
  // JSONL — skip blank lines, and skip lines that are not objects rather than
  // dying, because session logs interleave non-request events.
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, any> => !!v && typeof v === 'object');
}

/* ── findings ─────────────────────────────────────────────────────────── */

export type Confidence = 'measured' | 'inferred';

export interface Finding {
  confidence: Confidence;
  severity: 'critical' | 'warning' | 'info';
  turn?: number;
  title: string;
  detail: string;
}

/**
 * Analyse a transcript for cache-destroying patterns.
 *
 * Every finding carries whether it was measured or inferred. Nothing here
 * guesses silently.
 */
export function analyse(
  t: Transcript,
  opts: { cacheMinimumTokens?: number; ttlSeconds?: number } = {},
): Finding[] {
  const out: Finding[] = [];
  const ttl = opts.ttlSeconds ?? 300;

  // --- tools changing between turns. Byte comparison on a canonical form, so
  //     key reordering is reported as the serialisation bug it is rather than
  //     as an intentional tool change.
  for (let i = 1; i < t.turns.length; i++) {
    const prev = t.turns[i - 1].toolsRaw;
    const cur = t.turns[i].toolsRaw;
    if (prev && cur && prev !== cur) {
      out.push({
        confidence: 'measured',
        severity: 'critical',
        turn: i,
        title: 'Tool definitions changed',
        detail:
          `Tools hash went ${sha(prev)} → ${sha(cur)}. The cached prefix is ordered ` +
          `tools → system → messages, so this invalidated all three: this turn and ` +
          `every turn after it write a fresh cache and read nothing back. Declare the ` +
          `full tool set once and narrow it with tool_choice, which invalidates only messages.`,
      });
      break; // one report is enough; the rest is the same failure
    }
  }

  // --- wall-clock gaps past the TTL
  for (let i = 1; i < t.turns.length; i++) {
    const a = t.turns[i - 1].at;
    const b = t.turns[i].at;
    if (!a || !b) continue;
    const gap = (Date.parse(b) - Date.parse(a)) / 1000;
    if (Number.isFinite(gap) && gap > ttl) {
      out.push({
        confidence: 'measured',
        severity: 'warning',
        turn: i,
        title: 'Gap exceeded the cache TTL',
        detail:
          `${Math.round(gap)}s between turn ${i} and ${i + 1}, past the ${ttl}s lifetime. ` +
          `The prefix expired, so this turn paid the write premium again and collected ` +
          `nothing. Consider a 1-hour TTL, or a keep-alive read before it lapses.`,
      });
    }
  }

  // --- prompts too short to cache at all
  if (opts.cacheMinimumTokens) {
    const short = t.turns.filter(
      (x) => x.inputTokens !== undefined && x.inputTokens < opts.cacheMinimumTokens!,
    );
    if (short.length) {
      out.push({
        confidence: 'measured',
        severity: 'info',
        title: `${short.length} turn(s) below the cacheable minimum`,
        detail:
          `This model will not cache a prefix under ${opts.cacheMinimumTokens} tokens. ` +
          `Those requests were processed uncached — no hit, no write, no error.`,
      });
    }
  }

  // --- images invalidate from their position onward
  const firstImage = t.turns.findIndex((x) => x.hasImage);
  if (firstImage > 0) {
    out.push({
      confidence: 'measured',
      severity: 'info',
      turn: firstImage,
      title: 'Image present in the prompt',
      detail:
        'Image bytes are hashed into the prefix. If the image changes between turns, ' +
        'everything after it invalidates.',
    });
  }

  // --- thinking configuration changes
  for (let i = 1; i < t.turns.length; i++) {
    const a = t.turns[i - 1].thinkingRaw;
    const b = t.turns[i].thinkingRaw;
    if (a && b && a !== b) {
      out.push({
        confidence: 'inferred',
        severity: 'warning',
        turn: i,
        title: 'Thinking configuration changed',
        detail:
          'The thinking/effort configuration is rendered into the prompt, so a change ' +
          'restarts the cache. Whether it also invalidated tools and system is ' +
          'model-specific and cannot be determined from this log alone.',
      });
      break;
    }
  }

  // --- achieved hit rate: a fact where reported, silence where not
  if (t.cacheTokensReported) {
    const read = sum(t.turns.map((x) => x.cacheReadTokens ?? 0));
    const input = sum(t.turns.map((x) => x.inputTokens ?? 0));
    if (input > 0) {
      const rate = read / input;
      out.push({
        confidence: 'measured',
        severity: rate === 0 ? 'critical' : 'info',
        title: `Achieved cache hit rate: ${(rate * 100).toFixed(1)}%`,
        detail:
          rate === 0
            ? 'Not one token was served from cache across the whole run.'
            : `${read.toLocaleString()} of ${input.toLocaleString()} input tokens were cache reads.`,
      });
    }
  } else {
    out.push({
      confidence: 'inferred',
      severity: 'info',
      title: 'Cache hit rate is not measurable from this log',
      detail:
        t.format === 'openai'
          ? 'This log carries prompt totals but no cached-token details ' +
            '(prompt_tokens_details or input_tokens_details), so cache reads cannot be ' +
            'separated from the rest. Any hit rate quoted for it would be a guess.'
          : 'No cache token fields present. Absent is not the same as zero.',
    });
  }

  // --- lookback exhaustion, which is only ever a hypothesis
  if (t.turns.length > 10) {
    out.push({
      confidence: 'inferred',
      severity: 'info',
      title: 'Long run — the 20-block lookback may be exhausted',
      detail:
        `Anthropic searches at most 20 blocks back per breakpoint. Each turn adds two, ` +
        `so past roughly ten turns a single-breakpoint agent can miss on a prefix that is ` +
        `still byte-identical, just out of range. This is a hypothesis, not a measurement.`,
    });
  }

  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * What the run cost at list prices, from the token counts the log reports.
 *
 * Priced request by request, because the long-context rates apply to a whole
 * request once its prompt crosses the line. Cache writes are billed at the
 * short-lifetime write rate: a log does not reliably say which lifetime was
 * bought, and the short one is the default everywhere. Returns undefined when
 * the log reports no input counts at all, which is not the same as zero cost.
 */
export function billedUsd(t: Transcript, price: ModelPrice): number | undefined {
  if (!t.turns.some((x) => x.inputTokens)) return undefined;
  return sum(
    t.turns.map((x) => {
      const prompt = x.inputTokens ?? 0;
      const rates = ratesFor(price, prompt);
      const read = x.cacheReadTokens ?? 0;
      const write = x.cacheWriteTokens ?? 0;
      const fresh = Math.max(0, prompt - read - write);
      return (
        fresh * rates.input +
        read * rates.cacheRead +
        write * (rates.cacheWrite ?? rates.input) +
        (x.outputTokens ?? 0) * rates.output
      );
    }),
  );
}

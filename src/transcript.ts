/**
 * Reading a real transcript, and being honest about what it can prove.
 *
 * The whole point of analysing a log rather than a scenario is that a log
 * contains facts. But not every log contains the same facts, and the difference
 * decides whether a finding is an assertion or a guess:
 *
 *   - Anthropic, Bedrock and Langfuse expose cache_read_input_tokens, so the
 *     achieved hit rate is MEASURED.
 *   - OpenAI reports cache reads under *_tokens_details; DeepSeek reports
 *     prompt_cache_hit_tokens; Gemini reports cachedContentTokenCount. Where a
 *     log carries only a prompt total, the hit rate can only be INFERRED, and
 *     must be labelled that way.
 *
 * A tool that presents a guess in the same typeface as a measurement is worse
 * than one that stays quiet, because the reader cannot tell which is which.
 */

import { createHash } from 'node:crypto';
import { CACHE_TTL_SECONDS, ratesFor } from './cost.js';
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
  /**
   * The parts of `cacheWriteTokens` bought at each lifetime, where the log says
   * (Anthropic's `usage.cache_creation`). Absent means the log does not say.
   */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /**
   * Thinking tokens, where the provider reports them apart from the reply
   * (Gemini's thoughtsTokenCount). Already included in `outputTokens`, because
   * they are billed at the output rate.
   */
  reasoningTokens?: number;
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** Which adapter matched, so the report can state its own fidelity. */
  format: 'anthropic' | 'openai' | 'gemini' | 'generic';
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
    // Gemini names its block usageMetadata and counts in camelCase.
    const gemini = (rec.response?.usageMetadata ?? rec.usageMetadata) as
      | Record<string, number>
      | undefined;
    const model = (req.model ??
      rec.response?.model ??
      rec.response?.modelVersion ??
      rec.model ??
      rec.modelVersion) as string | undefined;
    const base = {
      index,
      at: (rec.timestamp ?? rec.at ?? rec.created_at) as string | undefined,
      model,
      toolsRaw: req.tools ? canonical(req.tools) : undefined,
      hasImage: hasImageBlock(req.messages ?? req.contents),
      thinkingRaw:
        req.thinking || req.reasoning_effort || req.effort
          ? canonical({
              thinking: req.thinking,
              effort: req.reasoning_effort ?? req.effort,
            })
          : undefined,
    };

    if (gemini && typeof gemini === 'object') {
      // ai.google.dev/api/generate-content: promptTokenCount INCLUDES the
      // cached content; tool-use prompt tokens and thoughts are counted apart
      // from it and from the candidates. Thoughts bill at the output rate.
      if (format === 'generic') format = 'gemini';
      const read = gemini.cachedContentTokenCount;
      if (read !== undefined) cacheTokensReported = true;
      const prompt =
        gemini.promptTokenCount === undefined && gemini.toolUsePromptTokenCount === undefined
          ? undefined
          : (gemini.promptTokenCount ?? 0) + (gemini.toolUsePromptTokenCount ?? 0);
      const thoughts = gemini.thoughtsTokenCount;
      const output =
        gemini.candidatesTokenCount === undefined && thoughts === undefined
          ? undefined
          : (gemini.candidatesTokenCount ?? 0) + (thoughts ?? 0);
      return {
        ...base,
        inputTokens: prompt,
        outputTokens: output,
        cacheReadTokens: read,
        reasoningTokens: thoughts,
      };
    }

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
    const splitCounters =
      partRead !== undefined ||
      partWrite !== undefined ||
      (usage as Record<string, unknown>).cache_creation !== undefined;
    const details = ((usage as Record<string, unknown>).input_tokens_details ??
      (usage as Record<string, unknown>).prompt_tokens_details) as
      | Record<string, number>
      | undefined;

    // Anthropic says which lifetime each write bought. cache_creation_input_tokens
    // equals the sum of this object (platform.claude.com prompt-caching docs).
    const creation = (usage as Record<string, unknown>).cache_creation as
      | Record<string, number>
      | undefined;
    const w5m = creation?.ephemeral_5m_input_tokens;
    const w1h = creation?.ephemeral_1h_input_tokens;
    const partWriteTotal =
      partWrite ?? (w5m !== undefined || w1h !== undefined ? (w5m ?? 0) + (w1h ?? 0) : undefined);
    // DeepSeek's native counters: prompt_tokens = hit + miss (api-docs.deepseek.com).
    const dsHit = usage.prompt_cache_hit_tokens;
    const dsMiss = usage.prompt_cache_miss_tokens;

    const read = partRead ?? details?.cached_tokens ?? dsHit;
    const write = partWriteTotal ?? details?.cache_write_tokens;
    if (read !== undefined || write !== undefined) cacheTokensReported = true;
    if (splitCounters) {
      format = 'anthropic';
    } else if (
      usage.prompt_tokens !== undefined ||
      details !== undefined ||
      dsHit !== undefined ||
      dsMiss !== undefined
    ) {
      format = format === 'anthropic' ? format : 'openai';
    }

    const reportedInput = (usage.input_tokens ??
      usage.prompt_tokens ??
      usage.inputTokens ??
      (dsHit !== undefined || dsMiss !== undefined ? (dsHit ?? 0) + (dsMiss ?? 0) : undefined)) as
      | number
      | undefined;
    const inputTokens =
      reportedInput === undefined
        ? undefined
        : splitCounters
          ? reportedInput + (partRead ?? 0) + (partWriteTotal ?? 0)
          : reportedInput;

    return {
      ...base,
      inputTokens,
      outputTokens:
        (usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens) as
          | number
          | undefined,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      ...(w5m !== undefined ? { cacheWrite5mTokens: w5m } : {}),
      ...(w1h !== undefined ? { cacheWrite1hTokens: w1h } : {}),
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
  const ttl = opts.ttlSeconds ?? cacheTtlSeconds(t);

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
    // Only turns that report a prompt total can say what share of it was read.
    // A turn with reads and no total would otherwise add to the numerator alone
    // (0.1.0 printed "50000.0%").
    const counted = t.turns.filter((x) => x.inputTokens !== undefined);
    const input = sum(counted.map((x) => x.inputTokens!));
    const read = Math.min(input, sum(counted.map((x) => Math.min(x.cacheReadTokens ?? 0, x.inputTokens!))));
    if (input > 0) {
      const rate = Math.min(1, read / input);
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
 * The cache lifetime to judge wall-clock gaps against, in seconds.
 *
 * A model that sells one lifetime (OpenAI's GPT-5.6 and later keep entries 30
 * minutes) uses it. Otherwise, a log that shows 1-hour cache writes bought an
 * hour; anything else is the 5-minute default.
 */
export function cacheTtlSeconds(t: Transcript, price?: ModelPrice): number {
  if (price?.cacheLifetimeSeconds !== undefined) return price.cacheLifetimeSeconds;
  return t.turns.some((x) => (x.cacheWrite1hTokens ?? 0) > 0)
    ? CACHE_TTL_SECONDS['1h']
    : CACHE_TTL_SECONDS['5m'];
}

/** USD for one turn at one model's list prices. */
function turnUsd(x: TranscriptTurn, price: ModelPrice): number {
  const prompt = x.inputTokens ?? 0;
  const rates = ratesFor(price, prompt);
  const read = x.cacheReadTokens ?? 0;
  const write = x.cacheWriteTokens ?? 0;
  // Anthropic's usage.cache_creation says which lifetime each write bought.
  // Where it is absent the whole write is billed at the short-lifetime rate,
  // the default everywhere.
  const long = Math.min(write, x.cacheWrite1hTokens ?? 0);
  const short = write - long;
  const shortRate = rates.cacheWrite ?? rates.input;
  const longRate = rates.cacheWriteLong ?? shortRate;
  const fresh = Math.max(0, prompt - read - write);
  return (
    fresh * rates.input +
    read * rates.cacheRead +
    short * shortRate +
    long * longRate +
    (x.outputTokens ?? 0) * rates.output
  );
}

/**
 * What the run cost at list prices, every turn at `price`, from the token
 * counts the log reports.
 *
 * Priced request by request, because the long-context rates apply to a whole
 * request once its prompt crosses the line. Returns undefined when the log
 * reports no input counts at all, which is not the same as zero cost. To price
 * each turn at the model it actually used, see `billRun`.
 */
export function billedUsd(t: Transcript, price: ModelPrice): number | undefined {
  if (!t.turns.some((x) => x.inputTokens)) return undefined;
  return sum(t.turns.map((x) => turnUsd(x, price)));
}

/** One model's share of a run. */
export interface ModelSubtotal {
  /** The model id as the log wrote it, or null when no turn named one. */
  model: string | null;
  /** The price-table row it resolved to, or null when there is none. */
  priceId: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when this model has no bundled price. */
  costUsd: number | null;
}

export interface RunBill {
  /** Sum over priced turns; undefined when no priced turn reports input. */
  totalUsd: number | undefined;
  byModel: ModelSubtotal[];
  /** Turns whose model has no price, so are left out of `totalUsd`. */
  unpricedTurns: number;
}

/**
 * Price each turn at its own model. A run that delegates to a cheaper model,
 * or falls back to one, is billed at what it actually used rather than at the
 * first turn's rates. A turn that names no model inherits the one before it.
 * `override`, when given, prices every turn at that one model (the CLI's
 * `--model`).
 */
export function billRun(
  t: Transcript,
  priceFor: (id: string) => ModelPrice | undefined,
  override?: ModelPrice,
): RunBill {
  const groups = new Map<string, { sub: ModelSubtotal; price?: ModelPrice; priced: boolean }>();
  let last = t.turns.find((x) => x.model)?.model;
  let unpricedTurns = 0;
  for (const x of t.turns) {
    if (x.model) last = x.model;
    const model = override ? override.id : (last ?? null);
    const price = override ?? (model ? priceFor(model) : undefined);
    const key = model ?? '';
    let g = groups.get(key);
    if (!g) {
      g = {
        price,
        priced: false,
        sub: {
          model,
          priceId: price?.id ?? null,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: price ? 0 : null,
        },
      };
      groups.set(key, g);
    }
    const s = g.sub;
    s.turns++;
    s.inputTokens += x.inputTokens ?? 0;
    s.outputTokens += x.outputTokens ?? 0;
    s.cacheReadTokens += x.cacheReadTokens ?? 0;
    s.cacheWriteTokens += x.cacheWriteTokens ?? 0;
    if (price) {
      s.costUsd = (s.costUsd ?? 0) + turnUsd(x, price);
      if (x.inputTokens) g.priced = true;
    } else unpricedTurns++;
  }
  const all = [...groups.values()];
  const priced = all.filter((g) => g.price && g.priced);
  return {
    totalUsd: priced.length ? sum(priced.map((g) => g.sub.costUsd ?? 0)) : undefined,
    byModel: all.map((g) => g.sub),
    unpricedTurns,
  };
}

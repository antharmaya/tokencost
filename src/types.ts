/**
 * Token & cost calculator — core types.
 *
 * Two of these encode one-way architectural doors (see
 * _cofounder/life/token-calculator-architecture.md):
 *
 *  1. The unit of computation is a CONVERSATION, not a string. Every public
 *     surface takes `Turn[]`. A textarea-in / integer-out shape would make
 *     multi-turn a rewrite rather than a feature, and multi-turn is the only
 *     thing no competitor does.
 *
 *  2. Every price carries its provenance. `sourceUrl` and `seenAt` are
 *     required, not optional, because retrofitting them means re-verifying
 *     every record — and because vendor prices do NOT only move downward
 *     (Anthropic Sonnet 5 rises 2026-09-01; Bedrock Priority is a premium
 *     tier). A price without a date cannot be trusted in either direction.
 *
 * The `Tokenizer` and `PricingProvider` interfaces mirror RateGuard's
 * (02-fast-cash/rateguard, core/tokenizer.ts and core/genai.ts) so an exact
 * tokenizer or a live price feed can be swapped in without touching callers.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** One message in a conversation. */
export interface Turn {
  role: Role;
  content: string;
}

/** What the user is pricing: a model, a conversation, and how it repeats. */
export interface Scenario {
  modelId: string;
  /** The conversation as authored. Turn 0 is conventionally the system prompt. */
  turns: Turn[];
  /** How many assistant round-trips to simulate. The context regrows each one. */
  turnCount: number;
  /** Tokens the model is expected to emit per turn. */
  outputTokensPerTurn: number;

  /**
   * Hidden thinking tokens generated per turn, billed at the OUTPUT rate.
   *
   * The largest cost element this tool ignored until 2026-08-05. Measured agent
   * runs show 2-8x more thinking than visible output, so on a reasoning model
   * the real output bill is several times the headline figure.
   *
   * They are billed once and then discarded — providers strip prior thinking
   * blocks rather than resending them — so unlike visible output they do NOT
   * join the transcript and do NOT compound across turns. That distinction is
   * the whole reason they need their own field instead of being folded into
   * outputTokensPerTurn.
   */
  reasoningTokensPerTurn: number;
  /**
   * Tokens of tool/function definitions sent on every request.
   *
   * Agents resend the whole tool schema each turn, exactly like the transcript.
   * A dozen tools with typed parameters runs to thousands of tokens, and on a
   * short conversation that is more of the bill than the messages are. Every
   * calculator checked on 2026-08-04 ignores this input entirely.
   */
  toolDefinitionTokens: number;

  /** Whether the provider's prompt cache is assumed active. */
  cacheEnabled: boolean;

  /**
   * Which cache lifetime is purchased, where the provider sells more than one.
   * Anthropic charges 1.25x input to write a 5-minute entry and 2x for an hour.
   */
  cacheTtl: '5m' | '1h';

  /**
   * Wall-clock gap between turns, in seconds.
   *
   * This is the input nobody models and it changes the answer more than the
   * model choice does. A prompt cache entry expires; if the agent waits longer
   * than the TTL — a human in the loop, a slow tool call, an overnight queue —
   * the next turn is a cache MISS and pays the write premium again. Caching can
   * therefore cost strictly more than not caching, at any turn count.
   */
  secondsBetweenTurns: number;
  /** Whether the batch API discount applies. */
  batchEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Rates are stored in the unit the vendor publishes and normalised at read
 * time. Vertex mixes per-1M-tokens, per-1K-characters and per-1K-queries on
 * one surface — the classic 1000x error — so the unit is explicit, never
 * assumed.
 */
export type PriceUnit = 'per_1m_tokens' | 'per_1k_tokens';

export interface Rate {
  value: number;
  unit: PriceUnit;
}

export interface ModelPrice {
  id: string;
  displayName: string;
  provider: string;

  input: Rate;
  output: Rate;

  /**
   * Prompt-cache economics. This is where multi-turn agent cost actually
   * lives: the transcript is resent every turn, so a cache read at 0.1x input
   * (OpenAI, Anthropic) or ~2% of miss (DeepSeek V4-Flash) is the difference
   * between linear and quadratic spend.
   *
   * `cacheWrite` is charged once when a prefix first enters the cache
   * (Anthropic: 1.25x input for 5-minute TTL, 2x for 1-hour).
   * `cacheRead` is charged on every subsequent hit.
   * Absent when the provider publishes no cache pricing.
   */
  cacheWrite?: Rate;
  /** Write rate for the longer cache lifetime, where the provider sells one. */
  cacheWriteLong?: Rate;
  cacheRead?: Rate;

  /**
   * Smallest prefix the provider will cache at all.
   *
   * Below this the request is processed uncached — silently, with no error and
   * no cache-write charge. Anthropic documents 1,024 tokens for Sonnet 4.x and
   * 2,048 for Opus 4.7+ on the direct API. Modelling a write premium on a
   * prompt too short to be cached invents a cost that is never billed, which is
   * the same class of error as ignoring one that is.
   */
  cacheMinimumTokens?: number;

  /** Multiplier applied to the whole bill in batch mode. 0.5 = 50% off. */
  batchMultiplier?: number;

  /** Which BPE encoding to count with. Absent means no public tokenizer. */
  encoding?: 'o200k_base' | 'cl100k_base';

  /**
   * Multiplier applied to a near-neighbour token count for this model.
   *
   * Anthropic documents that Claude 4.7 and later use a newer tokenizer which
   * "produces approximately 30% more tokens for the same text" than earlier
   * Claude models. Counting those models with a borrowed BPE and no correction
   * under-states the bill by roughly a third — an error in the dangerous
   * direction, since a cost estimate that lands under the invoice is worse than
   * one that lands over. Absent means the neighbour count needs no correction.
   */
  tokenizerInflation?: number;

  /**
   * Tokens the provider silently prepends when any tool is enabled.
   *
   * Anthropic injects a tool-use system prompt on every request that carries a
   * `tools` array — 290 tokens on Opus 4.8, 354 on Sonnet 5 — on top of your
   * own schemas. It is resent every turn like everything else in the prefix,
   * and nobody counts it because you never wrote it.
   */
  toolSystemPromptTokens?: number;

  contextWindow: number;

  /** Provenance. Both required — see the file header. */
  sourceUrl: string;
  seenAt: string; // ISO date, the day a human read the vendor page

  /**
   * Set when the token count is approximate rather than exact — i.e. the
   * provider does not publish a tokenizer and we are counting with a
   * near-neighbour. Surfaced in the UI; never hidden.
   */
  countAccuracy?: 'exact' | 'approximate';

  /** Free-text caveat shown next to the price. */
  note?: string;

  /**
   * Set when the rates were typed in by the reader rather than read off a
   * vendor page.
   *
   * This tool's entire claim is that every number carries a source and a date.
   * A rate someone entered has neither, so it cannot be allowed to render in
   * the same visual language as a verified one — the UI has to say plainly
   * that nobody checked it. Being able to price an unlisted model is worth
   * having; quietly laundering a guess into something that looks sourced is
   * not.
   */
  isCustom?: boolean;
}

/** Mirrors RateGuard's PricingProvider. Swap the implementation, not callers. */
export interface PricingProvider {
  priceFor(modelId: string): ModelPrice | undefined;
  all(): ModelPrice[];
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Mirrors RateGuard's Tokenizer interface, which documents itself as "the
 * plug-in point" for exact counting. Two implementations ship:
 * an exact BPE counter, and RateGuard's own CJK-aware heuristic.
 */
export interface Tokenizer {
  estimateTokens(text: string): number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface TurnCost {
  index: number;
  /** True when the prefix had expired and this turn paid the write premium. */
  cacheExpired: boolean;
  /** True when the prompt was shorter than the provider will cache at all. */
  belowCacheMinimum: boolean;
  /** Full input as the provider sees it: transcript so far + ChatML overhead. */
  inputTokens: number;
  /** Portion served from the prompt cache. */
  cachedInputTokens: number;
  /** Portion billed at the full input rate. */
  freshInputTokens: number;
  outputTokens: number;
  /** Hidden thinking tokens billed this turn at the output rate. */
  reasoningTokens: number;
  costUsd: number;
}

export interface CostBreakdown {
  perTurn: TurnCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Thinking tokens billed across the run. Never part of the transcript. */
  totalReasoningTokens: number;
  /**
   * ChatML structural tokens: ~4 per message plus 2 priming the assistant
   * reply. Thirty messages carry 122 tokens nobody typed. Every competitor
   * checked on 2026-08-04 ignores this entirely.
   */
  chatOverheadTokens: number;
  totalCostUsd: number;
  /** Accuracy of the underlying token count, propagated from the model. */
  accuracy: 'exact' | 'approximate';
}

/** The headline comparison: what caching is actually worth over N turns. */
export interface CostComparison {
  cached: CostBreakdown;
  uncached: CostBreakdown;
  /** uncached / cached. The number the whole tool exists to show. */
  multiple: number;
  savedUsd: number;
}

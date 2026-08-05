/**
 * The cost engine — the part no competitor has built.
 *
 * Every public calculator checked on 2026-08-04 (tokenmath.dev, BenchLM,
 * aitokencalculator, apyrn) prices a SINGLE request: you give it a token count,
 * it multiplies by a rate. BenchLM has a preset labelled "Agent runs" but its
 * input is still a flat "input tokens per request" times a monthly volume —
 * context never compounds.
 *
 * That misses the thing that actually costs money. In a multi-turn agent the
 * whole transcript is resent every turn, so aggregate input across N turns
 * grows with the square of N, not linearly. Prompt caching collapses it back
 * toward linear. The gap between those two curves is the product.
 */

import type {
  CostBreakdown,
  CostComparison,
  ModelPrice,
  Rate,
  Scenario,
  Tokenizer,
  Turn,
  TurnCost,
} from './types';

/**
 * ChatML structural overhead.
 *
 * Chat models do not receive raw text. The backend wraps every message in
 * special tokens (<|im_start|>, role, <|im_end|>) and appends an open
 * assistant header to prime the reply. You are billed for all of it.
 *
 * Counting `JSON.stringify(messages)` instead is not an approximation of this
 * — it is a different string entirely, since JSON braces and quotes tokenize
 * nothing like the chat template.
 */
export const TOKENS_PER_MESSAGE = 4;
export const TOKENS_PRIMING_REPLY = 2;

/** Cache lifetimes, in seconds, as the providers sell them. */
export const CACHE_TTL_SECONDS = { '5m': 300, '1h': 3600 } as const;

/** Normalise any published unit to a flat per-token USD rate. */
export function perToken(rate: Rate): number {
  switch (rate.unit) {
    case 'per_1m_tokens':
      return rate.value / 1_000_000;
    case 'per_1k_tokens':
      return rate.value / 1_000;
  }
}

/** Tokens for one message, including its ChatML wrapper. */
export function countTurn(turn: Turn, tokenizer: Tokenizer): number {
  return tokenizer.estimateTokens(turn.content) + TOKENS_PER_MESSAGE;
}

/**
 * Price a scenario.
 *
 * The loop is the whole point: at turn i the model receives the system prompt
 * plus every prior message plus every prior reply. `cacheEnabled` decides
 * whether that resent prefix is billed at the read rate or the full input
 * rate.
 */
export function computeCost(
  scenario: Scenario,
  price: ModelPrice,
  tokenizer: Tokenizer,
): CostBreakdown {
  const inputRate = perToken(price.input);
  const outputRate = perToken(price.output);
  const readRate = price.cacheRead ? perToken(price.cacheRead) : inputRate;
  const writeRate = price.cacheWrite ? perToken(price.cacheWrite) : inputRate;

  const seed = scenario.turns.map((t) => ({ turn: t, tokens: countTurn(t, tokenizer) }));
  const seedTokens = seed.reduce((sum, s) => sum + s.tokens, 0);
  const seedMessages = seed.length;

  // A turn appends the assistant reply plus the next user message. We model the
  // follow-up user message as the same size as the last authored user turn,
  // which is the honest default when the user has not written turn N yet.
  const lastUser = [...scenario.turns].reverse().find((t) => t.role === 'user');
  const followUpTokens = lastUser
    ? countTurn(lastUser, tokenizer)
    : TOKENS_PER_MESSAGE;

  const perTurn: TurnCost[] = [];
  // Tool schemas sit in the prefix alongside the system prompt and are resent
  // on every single request, cached or not.
  let transcriptTokens = seedTokens + scenario.toolDefinitionTokens;
  let messageCount = seedMessages;
  let cachedPrefix = 0; // what the provider already holds
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;

  // A cache entry has a lifetime. If the agent takes longer than that between
  // turns, the prefix is gone and the next turn pays to write it again — so a
  // slow agent can pay the write premium on every turn and never collect a
  // single read. This is the case where caching costs strictly more than not
  // caching, and it is invisible in every calculator that ignores wall clock.
  const ttlSeconds = CACHE_TTL_SECONDS[scenario.cacheTtl];
  const cacheSurvivesGap = scenario.secondsBetweenTurns <= ttlSeconds;

  // Anthropic sells the longer lifetime at a higher write rate. Buying an hour
  // of cache you do not use is pure loss, which is why the TTL is an input
  // rather than an assumption.
  const writeRateForTtl =
    scenario.cacheTtl === '1h' && price.cacheWriteLong
      ? perToken(price.cacheWriteLong)
      : writeRate;

  for (let i = 0; i < scenario.turnCount; i++) {
    const inputTokens = transcriptTokens + TOKENS_PRIMING_REPLY;

    // Anything already in the cache AND still alive is billed at the read rate;
    // the rest is fresh. Without caching every token is fresh, every single
    // turn — which is exactly how the bill goes quadratic.
    // A prefix shorter than the provider's minimum is not cached at all — no
    // hit, no write, no premium, no error. Charging the premium anyway would
    // invent a cost that is never billed.
    const tooShortToCache =
      price.cacheMinimumTokens !== undefined &&
      inputTokens < price.cacheMinimumTokens;

    const expired = scenario.cacheEnabled && i > 0 && !cacheSurvivesGap;
    const usablePrefix = expired || tooShortToCache ? 0 : cachedPrefix;
    const cached = scenario.cacheEnabled ? Math.min(usablePrefix, inputTokens) : 0;
    const fresh = inputTokens - cached;

    let cost = cached * readRate + fresh * inputRate;

    // Writing the fresh portion into the cache costs a premium, once per write.
    if (scenario.cacheEnabled && price.cacheWrite && fresh > 0 && !tooShortToCache) {
      cost += fresh * (writeRateForTtl - inputRate);
    }

    // Thinking is billed at the output rate. It is NOT added to the transcript
    // below, because providers discard prior thinking blocks rather than
    // resending them — so it costs money every turn without ever compounding.
    cost += (scenario.outputTokensPerTurn + scenario.reasoningTokensPerTurn) * outputRate;

    perTurn.push({
      index: i,
      cacheExpired: expired,
      belowCacheMinimum: tooShortToCache,
      inputTokens,
      cachedInputTokens: cached,
      freshInputTokens: fresh,
      outputTokens: scenario.outputTokensPerTurn,
      reasoningTokens: scenario.reasoningTokensPerTurn,
      costUsd: cost,
    });

    totalCost += cost;
    totalInput += inputTokens;
    totalOutput += scenario.outputTokensPerTurn;
    totalReasoning += scenario.reasoningTokensPerTurn;

    // The reply and the next question join the transcript. Next turn resends
    // all of it.
    if (scenario.cacheEnabled) cachedPrefix = tooShortToCache ? 0 : inputTokens;
    transcriptTokens +=
      scenario.outputTokensPerTurn + TOKENS_PER_MESSAGE + followUpTokens;
    messageCount += 2;
  }

  const batch =
    scenario.batchEnabled && price.batchMultiplier ? price.batchMultiplier : 1;

  return {
    perTurn,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    chatOverheadTokens:
      messageCount * TOKENS_PER_MESSAGE + scenario.turnCount * TOKENS_PRIMING_REPLY,
    totalCostUsd: totalCost * batch,
    accuracy: price.countAccuracy ?? 'approximate',
  };
}

/**
 * The headline. Same scenario priced twice — with the prompt cache and
 * without — because that delta is what a reader cannot get anywhere else.
 */
export function compareCaching(
  scenario: Scenario,
  price: ModelPrice,
  tokenizer: Tokenizer,
): CostComparison {
  const cached = computeCost({ ...scenario, cacheEnabled: true }, price, tokenizer);
  const uncached = computeCost({ ...scenario, cacheEnabled: false }, price, tokenizer);

  return {
    cached,
    uncached,
    multiple:
      cached.totalCostUsd > 0 ? uncached.totalCostUsd / cached.totalCostUsd : 1,
    savedUsd: uncached.totalCostUsd - cached.totalCostUsd,
  };
}

/** USD formatter that stays honest at very small amounts. */
export function formatUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(5)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

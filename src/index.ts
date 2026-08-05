/**
 * @antharmaya/tokencost — price a conversation, not a request.
 *
 * Every public LLM cost calculator surveyed in August 2026 prices a single
 * request. In a multi-turn agent the whole transcript is resent every turn, so
 * aggregate input grows closer to the square of the turn count than to a line.
 * This models that, plus the things that actually decide an agent's bill:
 * prompt-cache write premiums, cache TTL expiry, the minimum cacheable prefix,
 * tool definitions resent every turn, and hidden thinking tokens.
 *
 * Zero runtime dependencies in the core. The exact BPE tokenizer is an optional
 * peer (gpt-tokenizer); without it, counting falls back to a conservative
 * estimator that is deliberately biased not to under-count.
 */

export type {
  Role,
  Turn,
  Scenario,
  PriceUnit,
  Rate,
  ModelPrice,
  PricingProvider,
  Tokenizer,
  TurnCost,
  CostBreakdown,
  CostComparison,
} from "./types";

export {
  TOKENS_PER_MESSAGE,
  TOKENS_PRIMING_REPLY,
  CACHE_TTL_SECONDS,
  perToken,
  countTurn,
  computeCost,
  compareCaching,
  formatUsd,
} from "./cost";

export {
  estimateTokens,
  guardrailTokenizer,
  exactTokenizer,
  conservativeTokenizer,
  inflatedTokenizer,
  tokenizerFor,
  type Encoding,
} from "./tokenizer";

export { staticPricing, LAST_REVIEWED } from "./pricing";

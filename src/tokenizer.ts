/**
 * Two tokenizers behind one interface.
 *
 * `exactTokenizer` uses gpt-tokenizer (pure TypeScript, MIT, tree-shakeable
 * per-encoding). Pure JS is a deliberate one-way choice: WASM tokenizers that
 * thread require SharedArrayBuffer, which forces COOP/COEP headers, and
 * without them the browser blocks instantiation outright. Pure JS sidesteps
 * that entirely and keeps this page deployable anywhere.
 *
 * `guardrailTokenizer` is RateGuard's own estimator, ported verbatim from
 * 02-fast-cash/rateguard/packages/sdk-node/src/core/tokenizer.ts. It is
 * deliberately biased NOT to under-count so that a limit fails safe.
 *
 * Both are shown in the UI, side by side, and the gap between them is the
 * argument: a guardrail that over-counts is correct, a calculator that
 * over-counts is broken. Same number, opposite jobs.
 */

import type { Tokenizer } from './types';

// ---------------------------------------------------------------------------
// RateGuard's estimator — ported unchanged so counts agree with the Go, Node
// and Python SDKs, which are locked by conformance/token_estimate_vectors.json.
// ---------------------------------------------------------------------------

/** CJK blocks that tokenize at roughly one token per character. Bounds inclusive. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x20000, 0x2ebef], // Extension B and beyond (astral)
];

function isCJK(codePoint: number): boolean {
  for (const [low, high] of CJK_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/**
 * ~1 token per CJK character, ~1 token per 4 characters otherwise, rounded up.
 *
 * The naive chars/4 rule undercounts CJK by roughly 75% — those scripts
 * tokenize near one token per character — which is a real limit-evasion gap.
 * Iterates by code point so all SDKs agree on astral characters.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCJK(ch.codePointAt(0)!)) cjk++;
    else other++;
  }
  return cjk + Math.floor((other + 3) / 4);
}

export const guardrailTokenizer: Tokenizer = { estimateTokens };

// ---------------------------------------------------------------------------
// Exact BPE counting
// ---------------------------------------------------------------------------

export type Encoding = 'o200k_base' | 'cl100k_base';

/**
 * Encodings are loaded lazily and per-encoding, not as one bundle. Importing
 * gpt-tokenizer wholesale pulls every OpenAI vocabulary into the page; the
 * o200k vocabulary alone is >2.5MB raw. These paths are the pre-compiled
 * single-encoding builds.
 */
const encoders = new Map<Encoding, (t: string) => number[]>();

async function loadEncoder(encoding: Encoding): Promise<(t: string) => number[]> {
  const cached = encoders.get(encoding);
  if (cached) return cached;

  const mod =
    encoding === 'o200k_base'
      ? await import('gpt-tokenizer/encoding/o200k_base')
      : await import('gpt-tokenizer/encoding/cl100k_base');

  const encode = (mod as { encode: (t: string) => number[] }).encode;
  encoders.set(encoding, encode);
  return encode;
}

/**
 * An exact tokenizer for a given encoding.
 *
 * Picking the wrong encoding is a silent correctness bug, not a rounding
 * error: counting an o200k_base model with cl100k_base overestimates by
 * roughly 5-15%, because the larger vocabulary merges more aggressively.
 */
export async function exactTokenizer(encoding: Encoding): Promise<Tokenizer> {
  const encode = await loadEncoder(encoding);
  return { estimateTokens: (text: string) => encode(text).length };
}

/**
 * The higher count of several tokenizers, per string.
 *
 * For a vendor that publishes no tokenizer there is no ground truth, only
 * competing estimates — and neither estimate dominates. Measured 2026-08-04
 * across eight representative samples, the guardrail reads HIGHER than
 * o200k_base on prose (+37%) and CJK (+36%), but LOWER on dense code (-12%)
 * and JSON (-25%), because BPE merges English words far more aggressively than
 * it merges punctuation-heavy source.
 *
 * So "just use the guardrail, it over-counts" is false. Taking the max makes
 * the conservative property true by construction instead of by assumption,
 * which matters: a cost estimate that lands under the real invoice is worse
 * than one that lands over.
 */
export function conservativeTokenizer(...tokenizers: Tokenizer[]): Tokenizer {
  return {
    estimateTokens: (text: string) =>
      tokenizers.reduce((max, t) => Math.max(max, t.estimateTokens(text)), 0),
  };
}

/**
 * Scale a tokenizer's counts by a documented factor.
 *
 * Used where a vendor publishes no tokenizer AND documents that its own differs
 * measurably from the near-neighbour we are forced to borrow. Anthropic states
 * that Claude 4.7+ emits ~30% more tokens for the same text than earlier Claude
 * models; without that correction every Anthropic number here reads about a
 * third under the real invoice.
 *
 * Rounds up. A fractional token is still a billed token.
 */
export function inflatedTokenizer(base: Tokenizer, factor: number): Tokenizer {
  return {
    estimateTokens: (text: string) =>
      Math.ceil(base.estimateTokens(text) * factor),
  };
}

/**
 * Pick the right tokenizer for a model.
 *
 * Models whose provider publishes no browser tokenizer (Claude, Gemini,
 * DeepSeek) fall back to the guardrail estimate. That is surfaced in the UI as
 * "approximate" — never silently.
 */
export async function tokenizerFor(encoding?: Encoding): Promise<Tokenizer> {
  if (!encoding) return guardrailTokenizer;
  try {
    return await exactTokenizer(encoding);
  } catch {
    // A failed vocabulary load must degrade to a working estimate, not a
    // blank page. The UI reads accuracy from the model record either way.
    return guardrailTokenizer;
  }
}

/**
 * PricingProvider over the static table.
 *
 * Build-time JSON, not a runtime fetch: this page makes zero network requests
 * after load, and that claim is only true if the data ships with the bundle.
 * If a live feed is ever needed, it swaps in behind this interface without
 * touching a single caller — that is what the seam is for.
 */

import type { ModelPrice, PricingProvider } from './types.js';
// NodeNext requires an explicit import attribute for JSON, and the emitted
// ESM is loaded by Node directly rather than by a bundler.
import table from './pricing.json' with { type: 'json' };

const models = table.models as unknown as ModelPrice[];

/**
 * Retired or renamed ids that a log may still carry, mapped by hand. Explicit
 * on purpose: a rename is a fact someone read on a vendor page, not a pattern.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
};

/** Provider and routing prefixes a log may put in front of a vendor id. */
const PREFIXES = [
  /^(?:us|eu|apac|global|jp|au|ca)\.(?=anthropic\.)/, // Bedrock cross-region inference
  /^(?:anthropic|openai|google|deepseek|gemini|vertex_ai|bedrock)[./]/,
  /^models\//, // Gemini API resource names
];

/** Snapshot, release-channel and platform-version suffixes. */
const SUFFIXES = [
  /-v\d+(?::\d+)?$/, // Bedrock: -v1:0
  /@[\w.-]+$/, // Vertex: @20251101, @latest
  /-\d{4}-\d{2}-\d{2}$/, // ISO: -2026-03-17
  /-\d{8}$/, // compact: -20251101
  /-\d{2}-\d{4}$/, // Gemini: -09-2026
  /-(?:preview|latest|exp)$/,
];

/**
 * Reduce a model id as logs write it to the id the price table uses: strip a
 * known provider prefix and any trailing snapshot date, channel or platform
 * version. Lower-cased. Suffixes are stripped repeatedly, so
 * `-preview-09-2026` goes in two steps.
 */
export function normaliseModelId(id: string): string {
  let s = id.trim().toLowerCase();
  for (const re of PREFIXES) s = s.replace(re, '');
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of SUFFIXES) {
      const next = s.replace(re, '');
      if (next !== s && next.length > 0) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Find the price for a model id. An exact id always wins. Failing that, the id
 * is normalised (and run through `MODEL_ALIASES`), but a row marked
 * `exactMatchOnly` is never reached that way: it is the escape hatch for a
 * model whose dated snapshots were priced differently from its alias.
 */
export function lookupPrice(rows: readonly ModelPrice[], id: string): ModelPrice | undefined {
  const exact = rows.find((m) => m.id === id);
  if (exact) return exact;
  const aliased = MODEL_ALIASES[id];
  if (aliased) return rows.find((m) => m.id === aliased);
  const n = normaliseModelId(id);
  const target = MODEL_ALIASES[n] ?? n;
  return rows.find((m) => m.id === target && !m.exactMatchOnly);
}

export const staticPricing: PricingProvider = {
  priceFor: (id) => lookupPrice(models, id),
  all: () => models,
};

/** The date a human last read the vendor pages. Shown in the UI, always. */
export const LAST_REVIEWED = table.lastReviewed as string;

/**
 * Days after which the bundled table is called stale.
 *
 * A daily job re-reads every vendor page and opens a PR when a number moves,
 * and re-dates the table at least every 30 days when nothing does. A table
 * older than this means that loop stopped (the job died, a PR sat unmerged, or
 * this install is an old release), so the figures are unchecked, not wrong.
 */
export const STALE_AFTER_DAYS = 45;

/** Whole days from the table's lastReviewed to `today` (ISO dates). */
export function tableAgeDays(today: string, lastReviewed: string = LAST_REVIEWED): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastReviewed}T00:00:00Z`)) / 86_400_000);
}

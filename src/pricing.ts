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

export const staticPricing: PricingProvider = {
  priceFor: (id) => models.find((m) => m.id === id),
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

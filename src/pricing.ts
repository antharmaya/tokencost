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

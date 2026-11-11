#!/usr/bin/env bun
/**
 * Prices come from one place: RateGuard's conformance/pricing.json.
 *
 *   bun scripts/sync-prices.ts            re-derive src/pricing.json from vendor/rateguard-pricing.json
 *   bun scripts/sync-prices.ts --from <path|url>
 *                                         copy RateGuard's table into vendor/ first, then re-derive
 *   bun scripts/sync-prices.ts --check    exit 1 if src/pricing.json's prices differ from the vendored copy
 *
 * The split:
 *   RateGuard owns every PRICE: input, output, cache read/write/long-write, long-context rates,
 *   priceChangesOn, sourceUrl, seenAt, exactOnly, and the table's lastReviewed. Both its CI
 *   (staleness, scheduled changes) and its three SDKs read the same file.
 *   tokencost owns the FACTS a run simulator needs and RateGuard has no use for: displayName,
 *   contextWindow, encoding, countAccuracy, cacheMinimumTokens, cacheLifetimeSeconds,
 *   toolSystemPromptTokens, tokenizerInflation, batchMultiplier, note. Which models tokencost
 *   offers is also its own call: a model appears here only once it has those facts.
 *
 * Why a vendored copy and not an import or a fetch: the calculator promises zero network
 * requests after load, and @varbees/rateguard-node is a whole SDK. The copy is byte-for-byte,
 * its sha256 is recorded in src/pricing.json, and a test fails if anyone edits a price by hand.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_PATH = join(ROOT, 'vendor/rateguard-pricing.json');
export const TABLE_PATH = join(ROOT, 'src/pricing.json');
export const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/varbees/rateguard/main/conformance/pricing.json';

type Num = number | undefined;
interface RgLong { aboveTokens: number; input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWriteLongTTL?: number }
export interface RgRow {
  id: string; provider: string; input: number; output: number;
  cacheRead?: number; cacheWrite?: number; cacheWriteLongTTL?: number;
  longContext?: RgLong; priceChangesOn?: string; exactOnly?: boolean;
  sourceUrl: string; seenAt: string; note?: string;
}
export interface RgTable { unit: string; lastReviewed: string; models: RgRow[] }
type Rate = { value: number; unit: 'per_1m_tokens' };
type Row = Record<string, unknown> & { id: string };
type Table = Record<string, unknown> & { lastReviewed: string; models: Row[] };

/** Keys RateGuard owns. Anything else on a tokencost row is tokencost's. */
export const PRICE_KEYS = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteLong', 'longContext',
  'priceChangesOn', 'exactMatchOnly', 'sourceUrl', 'seenAt',
] as const;

const rate = (v: Num): Rate | undefined => (v === undefined ? undefined : { value: v, unit: 'per_1m_tokens' });

/** The price fields of one tokencost row, built from RateGuard's row. Absent stays absent. */
export function pricesFrom(rg: RgRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input: rate(rg.input),
    output: rate(rg.output),
    cacheWrite: rate(rg.cacheWrite),
    cacheWriteLong: rate(rg.cacheWriteLongTTL),
    cacheRead: rate(rg.cacheRead),
    longContext: rg.longContext && {
      aboveTokens: rg.longContext.aboveTokens,
      input: rate(rg.longContext.input),
      output: rate(rg.longContext.output),
      cacheWrite: rate(rg.longContext.cacheWrite),
      cacheWriteLong: rate(rg.longContext.cacheWriteLongTTL),
      cacheRead: rate(rg.longContext.cacheRead),
    },
    priceChangesOn: rg.priceChangesOn,
    exactMatchOnly: rg.exactOnly,
    sourceUrl: rg.sourceUrl,
    seenAt: rg.seenAt,
  };
  return JSON.parse(JSON.stringify(out)); // drops undefined at every depth
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Re-derive the tokencost table: keep each row's facts and its position, replace every price
 * key with RateGuard's. A model tokencost lists that RateGuard does not is an error, never a
 * silent keep: a price with no maintained source is exactly what this script exists to stop.
 */
export function derive(current: Table, rgText: string): Table {
  const rg = JSON.parse(rgText) as RgTable;
  if (rg.unit !== 'usd_per_1m_tokens') throw new Error(`RateGuard table unit is ${rg.unit}, expected usd_per_1m_tokens`);
  const byId = new Map(rg.models.map((m) => [m.id, m]));
  const missing = current.models.filter((m) => !byId.has(m.id)).map((m) => m.id);
  if (missing.length) throw new Error(`not in RateGuard's table: ${missing.join(', ')}. Add the row there first.`);

  const models = current.models.map((row) => {
    const facts = Object.fromEntries(Object.entries(row).filter(([k]) => !(PRICE_KEYS as readonly string[]).includes(k)));
    const merged = { ...facts, ...pricesFrom(byId.get(row.id)!) } as Row;
    // Stable key order: id, displayName, provider, then prices, then facts, so diffs stay readable.
    const order = ['id', 'displayName', 'provider', ...PRICE_KEYS];
    return Object.fromEntries([
      ...order.filter((k) => k in merged).map((k) => [k, merged[k]]),
      ...Object.keys(merged).filter((k) => !order.includes(k)).map((k) => [k, merged[k]]),
    ]) as Row;
  });

  const { models: _old, lastReviewed: _lr, pricesFrom: _pf, ...rest } = current as Table & { pricesFrom?: unknown };
  return {
    ...rest,
    lastReviewed: rg.lastReviewed,
    pricesFrom: {
      repo: 'varbees/rateguard',
      path: 'conformance/pricing.json',
      vendored: 'vendor/rateguard-pricing.json',
      sha256: sha256(rgText),
    },
    models,
  };
}

async function readSource(from: string): Promise<string> {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from);
    if (!res.ok) throw new Error(`${from}: HTTP ${res.status}`);
    return await res.text();
  }
  return readFileSync(from, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  if (fromIdx >= 0) {
    const text = await readSource(args[fromIdx + 1] ?? DEFAULT_SOURCE);
    JSON.parse(text); // refuse to vendor something that is not JSON
    mkdirSync(dirname(VENDOR_PATH), { recursive: true });
    writeFileSync(VENDOR_PATH, text);
  }
  if (!existsSync(VENDOR_PATH)) throw new Error(`${VENDOR_PATH} missing: run with --from first`);
  const rgText = readFileSync(VENDOR_PATH, 'utf8');
  const currentText = readFileSync(TABLE_PATH, 'utf8');
  const next = JSON.stringify(derive(JSON.parse(currentText), rgText), null, 2) + '\n';

  if (args.includes('--check')) {
    if (next !== currentText) {
      console.error('src/pricing.json differs from the vendored RateGuard table. Prices are edited in RateGuard, then `bun scripts/sync-prices.ts --from <source>`.');
      process.exit(1);
    }
    console.log(`prices match RateGuard (sha256 ${sha256(rgText).slice(0, 12)}…, lastReviewed ${JSON.parse(rgText).lastReviewed})`);
    return;
  }
  if (next === currentText) {
    console.log('src/pricing.json already matches RateGuard');
    return;
  }
  writeFileSync(TABLE_PATH, next);
  console.log(`src/pricing.json re-derived from RateGuard (lastReviewed ${JSON.parse(rgText).lastReviewed})`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}

/**
 * One source of prices: RateGuard's conformance/pricing.json, vendored byte-for-byte in
 * vendor/rateguard-pricing.json. These tests make a hand-edited price fail CI.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { derive, pricesFrom, sha256, TABLE_PATH, VENDOR_PATH, PRICE_KEYS, type RgRow } from '../scripts/sync-prices.ts';

const vendorText = readFileSync(VENDOR_PATH, 'utf8');
const tableText = readFileSync(TABLE_PATH, 'utf8');
const table = JSON.parse(tableText);

describe('prices come from RateGuard', () => {
  test('re-deriving from the vendored table reproduces src/pricing.json exactly', () => {
    expect(JSON.stringify(derive(table, vendorText), null, 2) + '\n').toBe(tableText);
  });

  test('the recorded sha256 is the vendored file', () => {
    expect(table.pricesFrom.sha256).toBe(sha256(vendorText));
    expect(table.lastReviewed).toBe(JSON.parse(vendorText).lastReviewed);
  });

  test('a hand-edited price is caught', () => {
    const edited = structuredClone(table);
    edited.models[0].input.value += 1;
    expect(JSON.stringify(derive(edited, vendorText))).not.toBe(JSON.stringify(edited));
    expect(derive(edited, vendorText).models[0].input.value).toBe(table.models[0].input.value);
  });

  test('a model RateGuard does not list is an error, never a silent keep', () => {
    const extra = structuredClone(table);
    extra.models.push({ ...extra.models[0], id: 'not-a-real-model' });
    expect(() => derive(extra, vendorText)).toThrow('not in RateGuard');
  });

  test('facts stay tokencost\'s: re-deriving never touches them', () => {
    const next = derive(table, vendorText);
    for (const [i, row] of table.models.entries()) {
      for (const [k, v] of Object.entries(row)) {
        if (!(PRICE_KEYS as readonly string[]).includes(k)) expect(next.models[i][k]).toEqual(v);
      }
    }
  });

  test('an absent cache price stays absent (billed at the input rate)', () => {
    const row: RgRow = { id: 'x', provider: 'p', input: 1, output: 2, sourceUrl: 'u', seenAt: '2026-01-01' };
    const p = pricesFrom(row);
    expect(p).toEqual({ input: { value: 1, unit: 'per_1m_tokens' }, output: { value: 2, unit: 'per_1m_tokens' }, sourceUrl: 'u', seenAt: '2026-01-01' });
    expect('cacheRead' in p).toBe(false);
  });

  test('RateGuard key names map to tokencost\'s', () => {
    const row: RgRow = {
      id: 'x', provider: 'p', input: 1, output: 2, cacheWriteLongTTL: 3, exactOnly: true, sourceUrl: 'u', seenAt: 'd',
      longContext: { aboveTokens: 1000, input: 4, output: 5, cacheWriteLongTTL: 6 },
    };
    const p = pricesFrom(row) as any;
    expect(p.cacheWriteLong.value).toBe(3);
    expect(p.exactMatchOnly).toBe(true);
    expect(p.longContext.cacheWriteLong.value).toBe(6);
    expect(p.longContext.aboveTokens).toBe(1000);
  });
});

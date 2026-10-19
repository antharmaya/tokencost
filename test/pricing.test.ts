import { describe, expect, test } from 'bun:test';
import { lookupPrice, normaliseModelId, staticPricing } from '../src/pricing.js';
import type { ModelPrice } from '../src/types.js';

describe('model id normalisation', () => {
  const p = (id: string) => staticPricing.priceFor(id)?.id;

  test('exact ids still match', () => {
    expect(p('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  test('dated snapshots resolve to their row', () => {
    expect(p('gpt-5.4-mini-2026-03-17')).toBe('gpt-5.4-mini');
    expect(p('claude-sonnet-5-5-20260901')).toBe('claude-sonnet-5-5');
    expect(p('gemini-3.8-flash-preview-09-2026')).toBe('gemini-3.8-flash');
    expect(p('gemini-4-argon-latest')).toBe('gemini-4-argon');
    expect(p('gemini-4-argon-exp')).toBe('gemini-4-argon');
  });

  test('provider prefixes, Bedrock and Vertex ids resolve', () => {
    expect(p('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(p('us.anthropic.claude-opus-5-5-v1:0')).toBe('claude-opus-5-5');
    expect(p('anthropic/claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(p('claude-haiku-5-5@20261001')).toBe('claude-haiku-5-5');
    expect(p('models/gemini-4-argon')).toBe('gemini-4-argon');
    expect(p('openai/gpt-5.5')).toBe('gpt-5.5');
  });

  test('the retired alias deepseek-v4-flash maps explicitly', () => {
    expect(p('deepseek-v4-flash')).toBe('deepseek-flash');
  });

  test('an unknown model stays unknown', () => {
    expect(p('claude-opus-4-5-20251101')).toBeUndefined();
    expect(p('mystery-model')).toBeUndefined();
  });

  test('normaliseModelId strips each suffix form', () => {
    expect(normaliseModelId('gpt-5.4-mini-2026-03-17')).toBe('gpt-5.4-mini');
    expect(normaliseModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(normaliseModelId('gemini-3.8-flash-preview-09-2026')).toBe('gemini-3.8-flash');
    expect(normaliseModelId('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  test('a row marked exactMatchOnly is never reached by normalisation', () => {
    const row = { ...staticPricing.priceFor('gpt-5.5')!, exactMatchOnly: true } as ModelPrice;
    expect(lookupPrice([row], 'gpt-5.5')?.id).toBe('gpt-5.5');
    expect(lookupPrice([row], 'gpt-5.5-2026-01-01')).toBeUndefined();
    expect(lookupPrice([row], 'openai/gpt-5.5')).toBeUndefined();
  });
});

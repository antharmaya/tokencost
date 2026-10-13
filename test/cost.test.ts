import { describe, expect, test } from 'bun:test';
import { compareCaching, computeCost, formatUsd, perToken, ratesFor } from '../src/cost.js';
import {
  conservativeTokenizer,
  estimateTokens,
  exactTokenizer,
  guardrailTokenizer,
  inflatedTokenizer,
} from '../src/tokenizer.js';
import { LAST_REVIEWED, staticPricing } from '../src/pricing.js';
import type { ModelPrice, Scenario } from '../src/types.js';

const opus = staticPricing.priceFor('claude-opus-4-8')!;
const gpt = staticPricing.priceFor('gpt-5.5')!;

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    modelId: 'claude-opus-4-8',
    turns: [
      { role: 'system', content: 'You are a coding agent with repository access.' },
      { role: 'user', content: 'Refactor the auth middleware and add tests.' },
    ],
    turnCount: 10,
    outputTokensPerTurn: 500,
    reasoningTokensPerTurn: 0,
    toolDefinitionTokens: 0,
    cacheEnabled: false,
    toolsChangeEachTurn: false,
    cacheTtl: '5m',
    secondsBetweenTurns: 5,
    batchEnabled: false,
    ...over,
  };
}

describe('rate normalisation', () => {
  test('per-1M and per-1K resolve to the same per-token rate', () => {
    expect(perToken({ value: 5, unit: 'per_1m_tokens' })).toBeCloseTo(0.000005, 12);
    expect(perToken({ value: 0.005, unit: 'per_1k_tokens' })).toBeCloseTo(0.000005, 12);
  });

  test('the unit is read, not assumed — a 1000x error is the classic failure', () => {
    const asMillions = perToken({ value: 5, unit: 'per_1m_tokens' });
    const asThousands = perToken({ value: 5, unit: 'per_1k_tokens' });
    expect(asThousands / asMillions).toBeCloseTo(1000, 6);
  });
});

describe("RateGuard's guardrail estimate", () => {
  test('Latin text counts at ~4 characters per token, rounded up', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars -> ceil(11/4)
  });

  test('CJK counts at ~1 token per character, not 1 per 4', () => {
    expect(estimateTokens('你好')).toBe(2);
  });

  test('it is biased to over-count so a limit fails safe', () => {
    const cjk = '中文字符';
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4));
  });

  test('astral characters are counted by code point, not UTF-16 unit', () => {
    // A single astral CJK ideograph is one code point but two UTF-16 units.
    const astral = '\u{20000}';
    expect(astral.length).toBe(2);
    expect(estimateTokens(astral)).toBe(1);
  });
});

describe('conservative counting for vendors with no public tokenizer', () => {
  test('neither estimator dominates — which is why the max exists', async () => {
    const o200k = await exactTokenizer('o200k_base');
    // Prose: BPE merges English words hard, so the guardrail reads higher.
    const prose = 'The quick brown fox jumps over the lazy dog and then considers its options carefully.';
    expect(estimateTokens(prose)).toBeGreaterThan(o200k.estimateTokens(prose));
    // JSON: punctuation does not merge, so the guardrail reads LOWER.
    const json = '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"hi"}]}';
    expect(estimateTokens(json)).toBeLessThan(o200k.estimateTokens(json));
  });

  test('the max never under-counts either input', async () => {
    const o200k = await exactTokenizer('o200k_base');
    const combined = conservativeTokenizer(guardrailTokenizer, o200k);
    const samples = [
      'The quick brown fox jumps over the lazy dog.',
      '{"a":1,"b":[2,3],"c":{"d":null}}',
      'const x = items.filter(i => i.id !== null).map(i => i.value);',
      '\u4e2d\u6587\u5b57\u7b26\u6d4b\u8bd5',
      '',
    ];
    for (const s of samples) {
      const m = combined.estimateTokens(s);
      expect(m).toBeGreaterThanOrEqual(estimateTokens(s));
      expect(m).toBeGreaterThanOrEqual(o200k.estimateTokens(s));
    }
  });

  test('a conservative count never prices a run below either component', async () => {
    const o200k = await exactTokenizer('o200k_base');
    const combined = conservativeTokenizer(guardrailTokenizer, o200k);
    const s = scenario({ turnCount: 15 });
    const viaMax = computeCost(s, opus, combined).totalCostUsd;
    expect(viaMax).toBeGreaterThanOrEqual(computeCost(s, opus, guardrailTokenizer).totalCostUsd);
    expect(viaMax).toBeGreaterThanOrEqual(computeCost(s, opus, o200k).totalCostUsd);
  });
});

describe('ChatML overhead — the error every competitor makes', () => {
  test('structural tokens are counted, not ignored', () => {
    const r = computeCost(scenario({ turnCount: 1 }), opus, guardrailTokenizer);
    expect(r.chatOverheadTokens).toBeGreaterThan(0);
  });

  test('overhead scales with message count', () => {
    const one = computeCost(scenario({ turnCount: 1 }), opus, guardrailTokenizer);
    const ten = computeCost(scenario({ turnCount: 10 }), opus, guardrailTokenizer);
    expect(ten.chatOverheadTokens).toBeGreaterThan(one.chatOverheadTokens);
  });
});

describe('context regrowth — the thing nobody models', () => {
  test('input tokens grow every turn because the transcript is resent', () => {
    const r = computeCost(scenario({ turnCount: 5 }), opus, guardrailTokenizer);
    const inputs = r.perTurn.map((t) => t.inputTokens);
    for (let i = 1; i < inputs.length; i++) {
      expect(inputs[i]).toBeGreaterThan(inputs[i - 1]);
    }
  });

  test('aggregate input is super-linear: doubling turns more than doubles input', () => {
    const five = computeCost(scenario({ turnCount: 5 }), opus, guardrailTokenizer);
    const ten = computeCost(scenario({ turnCount: 10 }), opus, guardrailTokenizer);
    expect(ten.totalInputTokens).toBeGreaterThan(five.totalInputTokens * 2);
  });

  test('a flat per-request model would understate a 20-turn agent badly', () => {
    const flat = computeCost(scenario({ turnCount: 1 }), opus, guardrailTokenizer);
    const real = computeCost(scenario({ turnCount: 20 }), opus, guardrailTokenizer);
    // What a competitor's "input tokens per request x 20" would produce:
    const naive = flat.totalInputTokens * 20;
    expect(real.totalInputTokens).toBeGreaterThan(naive * 2);
  });
});

describe('the minimum cacheable prefix', () => {
  test('the vendors whose minimum is documented carry it', () => {
    // Anthropic and OpenAI publish these. Gemini and DeepSeek do not, in any
    // source verified on 2026-08-05, so they are left undefined rather than
    // guessed — an invented threshold would silently change every short-prompt
    // result, and being wrong here is indistinguishable from being right.
    // Read off Anthropic's own "Cache limitations" table on 2026-08-05. The
    // thresholds are per-model and not monotonic — 1,024 on Opus 4.8, but 2,048
    // on Opus 4.7 and 4,096 on Opus 4.6 — so an upgrade can silently change
    // whether a prompt caches at all. Two research passes disagreed here; the
    // vendor table settled it.
    expect(staticPricing.priceFor('claude-opus-4-8')!.cacheMinimumTokens).toBe(1024);
    expect(staticPricing.priceFor('claude-sonnet-5')!.cacheMinimumTokens).toBe(1024);
    // Re-read 2026-10-13. The Claude 5.5 family and Fable 5.1 dropped to 512,
    // and OpenAI documents 1,024 for GPT-5.6 and later.
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(staticPricing.priceFor(id)!.cacheMinimumTokens).toBe(512);
    }
    expect(staticPricing.priceFor('gpt-6.1-sol')!.cacheMinimumTokens).toBe(1024);
  });

  test('an undocumented minimum is absent, never invented', () => {
    // OpenAI now says the minimum for GPT-5.5 and earlier "varies by request
    // settings", so the 1,024 this table used to carry for them was removed.
    for (const id of ['gemini-4-argon', 'deepseek-v4-pro', 'gpt-5.5', 'gpt-5.4-mini']) {
      expect(staticPricing.priceFor(id)!.cacheMinimumTokens).toBeUndefined();
    }
  });

  test('a prompt below the minimum is not cached and pays no write premium', () => {
    // The default seed is ~100 tokens; Opus will not cache under 2,048.
    const r = computeCost(
      scenario({ turnCount: 1, cacheEnabled: true }),
      opus,
      guardrailTokenizer,
    );
    expect(r.perTurn[0].belowCacheMinimum).toBe(true);
    const uncached = computeCost(
      scenario({ turnCount: 1, cacheEnabled: false }),
      opus,
      guardrailTokenizer,
    );
    // Identical cost — caching is a no-op, not a loss, on a short prompt.
    expect(r.totalCostUsd).toBeCloseTo(uncached.totalCostUsd, 12);
  });

  test('caching starts working once the transcript crosses the minimum', () => {
    const r = computeCost(
      scenario({ turnCount: 20, cacheEnabled: true }),
      opus,
      guardrailTokenizer,
    );
    expect(r.perTurn.some((t) => t.belowCacheMinimum)).toBe(true);
    expect(r.perTurn.some((t) => !t.belowCacheMinimum && t.cachedInputTokens > 0)).toBe(true);
  });
});

describe('prompt caching — where the order of magnitude lives', () => {
  test('caching reduces total cost over a multi-turn run', () => {
    const c = compareCaching(scenario({ turnCount: 20 }), opus, guardrailTokenizer);
    expect(c.cached.totalCostUsd).toBeLessThan(c.uncached.totalCostUsd);
    expect(c.savedUsd).toBeGreaterThan(0);
  });

  test('the saving compounds with turn count', () => {
    const short = compareCaching(scenario({ turnCount: 3 }), opus, guardrailTokenizer);
    const long = compareCaching(scenario({ turnCount: 30 }), opus, guardrailTokenizer);
    expect(long.multiple).toBeGreaterThan(short.multiple);
  });

  test('a cache read is never dearer than fresh input, on any model', () => {
    for (const m of staticPricing.all()) {
      if (m.cacheRead) expect(perToken(m.cacheRead)).toBeLessThan(perToken(m.input));
    }
  });

  test('the read discount is not one number: it runs from 2% to 10% of input', () => {
    // Every calculator that hard-codes "cached input is 10%" is wrong for the
    // models where caching matters most. DeepSeek Flash reads at 2% of a miss,
    // Claude Fable 5.1 at 2.5%, Opus 5.5 and GPT-6.1 Sol at 5%.
    const ratio = (id: string) => {
      const m = staticPricing.priceFor(id)!;
      return perToken(m.cacheRead!) / perToken(m.input);
    };
    expect(ratio('deepseek-flash')).toBeCloseTo(0.02, 6);
    expect(ratio('claude-fable-5-1')).toBeCloseTo(0.025, 6);
    expect(ratio('claude-opus-5-5')).toBeCloseTo(0.05, 6);
    expect(ratio('gpt-6.1-sol')).toBeCloseTo(0.05, 6);
    expect(ratio('claude-opus-4-8')).toBeCloseTo(0.1, 6);
    const lowest = Math.min(
      ...staticPricing.all().filter((m) => m.cacheRead).map((m) => ratio(m.id)),
    );
    expect(lowest).toBeCloseTo(ratio('deepseek-flash'), 6);
  });
});

describe('tool definitions — resent every turn, modelled by nobody', () => {
  test('tool schemas are billed on every request, not once', () => {
    const without = computeCost(scenario({ turnCount: 10 }), opus, guardrailTokenizer);
    const with2k = computeCost(
      scenario({ turnCount: 10, toolDefinitionTokens: 2000 }),
      opus,
      guardrailTokenizer,
    );
    // 2,000 tokens of schema across 10 turns is 20,000 tokens, not 2,000.
    expect(with2k.totalInputTokens - without.totalInputTokens).toBe(20_000);
  });

  test('on a short conversation the tools cost more than the messages', () => {
    const r = computeCost(
      scenario({ turnCount: 3, toolDefinitionTokens: 2000 }),
      opus,
      guardrailTokenizer,
    );
    const bare = computeCost(scenario({ turnCount: 3 }), opus, guardrailTokenizer);
    expect(r.totalInputTokens - bare.totalInputTokens).toBeGreaterThan(
      bare.totalInputTokens,
    );
  });
});

describe('changing tool definitions destroys the whole prefix', () => {
  test('a tools array that varies each turn yields zero cache hits', () => {
    // Anthropic's invalidation table: modifying tool definitions invalidates
    // the tools, system AND message caches. Prefix order is tools -> system ->
    // messages, so volatility at the front wipes everything behind it.
    const r = computeCost(
      scenario({ turnCount: 20, cacheEnabled: true, toolsChangeEachTurn: true, toolDefinitionTokens: 3000 }),
      opus,
      guardrailTokenizer,
    );
    expect(r.perTurn.slice(1).every((t) => t.toolsInvalidated)).toBe(true);
    expect(r.perTurn.every((t) => t.cachedInputTokens === 0)).toBe(true);
  });

  test('so caching a dynamic-tool agent costs MORE than not caching', () => {
    const opts = { turnCount: 20, toolsChangeEachTurn: true, toolDefinitionTokens: 3000 };
    const cached = computeCost(scenario({ ...opts, cacheEnabled: true }), opus, guardrailTokenizer);
    const plain = computeCost(scenario({ ...opts, cacheEnabled: false }), opus, guardrailTokenizer);
    expect(cached.totalCostUsd).toBeGreaterThan(plain.totalCostUsd);
  });

  test('freezing the tools array restores the saving', () => {
    const opts = { turnCount: 20, cacheEnabled: true, toolDefinitionTokens: 3000 };
    const varying = computeCost(scenario({ ...opts, toolsChangeEachTurn: true }), opus, guardrailTokenizer);
    const frozen = computeCost(scenario({ ...opts, toolsChangeEachTurn: false }), opus, guardrailTokenizer);
    expect(frozen.totalCostUsd).toBeLessThan(varying.totalCostUsd);
  });
});

describe('cache expiry — the input that flips the answer', () => {
  test('a gap inside the TTL keeps the cache warm', () => {
    const r = computeCost(
      scenario({ turnCount: 10, cacheEnabled: true, secondsBetweenTurns: 60 }),
      opus,
      guardrailTokenizer,
    );
    expect(r.perTurn.some((t) => t.cacheExpired)).toBe(false);
  });

  test('a gap past the TTL expires it on every turn after the first', () => {
    const r = computeCost(
      scenario({ turnCount: 10, cacheEnabled: true, secondsBetweenTurns: 600 }),
      opus,
      guardrailTokenizer,
    );
    expect(r.perTurn.slice(1).every((t) => t.cacheExpired)).toBe(true);
    expect(r.perTurn.every((t) => t.cachedInputTokens === 0)).toBe(true);
  });

  test('caching a slow agent costs MORE than not caching, at any length', () => {
    // The write premium is paid every turn and never earns a single read.
    const slow = { turnCount: 30, secondsBetweenTurns: 600 };
    const cached = computeCost(scenario({ ...slow, cacheEnabled: true }), opus, guardrailTokenizer);
    const uncached = computeCost(scenario({ ...slow, cacheEnabled: false }), opus, guardrailTokenizer);
    expect(cached.totalCostUsd).toBeGreaterThan(uncached.totalCostUsd);
  });

  test('a 1-hour cache survives a gap that kills the 5-minute one', () => {
    const gap = { turnCount: 10, cacheEnabled: true, secondsBetweenTurns: 600 };
    const short = computeCost(scenario({ ...gap, cacheTtl: '5m' }), opus, guardrailTokenizer);
    const long = computeCost(scenario({ ...gap, cacheTtl: '1h' }), opus, guardrailTokenizer);
    expect(short.perTurn[1].cacheExpired).toBe(true);
    expect(long.perTurn[1].cacheExpired).toBe(false);
    expect(long.totalCostUsd).toBeLessThan(short.totalCostUsd);
  });

  test('but the longer TTL costs more to write, so it loses on a fast agent', () => {
    const fast = { turnCount: 10, cacheEnabled: true, secondsBetweenTurns: 5 };
    const short = computeCost(scenario({ ...fast, cacheTtl: '5m' }), opus, guardrailTokenizer);
    const long = computeCost(scenario({ ...fast, cacheTtl: '1h' }), opus, guardrailTokenizer);
    expect(long.totalCostUsd).toBeGreaterThan(short.totalCostUsd);
  });
});

describe('reasoning tokens — the biggest element this ignored', () => {
  test('thinking is billed at the output rate, not the input rate', () => {
    const bare = computeCost(scenario({ turnCount: 10 }), opus, guardrailTokenizer);
    const think = computeCost(
      scenario({ turnCount: 10, reasoningTokensPerTurn: 1000 }),
      opus,
      guardrailTokenizer,
    );
    const delta = think.totalCostUsd - bare.totalCostUsd;
    expect(delta).toBeCloseTo(10 * 1000 * perToken(opus.output), 10);
  });

  test('thinking does NOT join the transcript, so input is unchanged', () => {
    // Providers discard prior thinking blocks. If this ever fails, the engine
    // has started compounding a cost that does not compound in reality.
    const bare = computeCost(scenario({ turnCount: 20 }), opus, guardrailTokenizer);
    const think = computeCost(
      scenario({ turnCount: 20, reasoningTokensPerTurn: 4000 }),
      opus,
      guardrailTokenizer,
    );
    expect(think.totalInputTokens).toBe(bare.totalInputTokens);
  });

  test('at the measured 2-8x ratio the output bill multiplies accordingly', () => {
    // Third-party agent traces show 2-8x more thinking than visible output.
    const visible = 500;
    for (const ratio of [2, 8]) {
      const r = computeCost(
        scenario({ turnCount: 10, outputTokensPerTurn: visible, reasoningTokensPerTurn: visible * ratio }),
        opus,
        guardrailTokenizer,
      );
      expect(r.totalReasoningTokens).toBe(10 * visible * ratio);
      expect(r.totalReasoningTokens / r.totalOutputTokens).toBeCloseTo(ratio, 6);
    }
  });

  test('a reasoning-heavy short run can cost more than a long cheap one', () => {
    const heavy = computeCost(
      scenario({ turnCount: 5, reasoningTokensPerTurn: 8000 }),
      opus,
      guardrailTokenizer,
    );
    const long = computeCost(scenario({ turnCount: 15 }), opus, guardrailTokenizer);
    expect(heavy.totalCostUsd).toBeGreaterThan(long.totalCostUsd);
  });
});

describe('batch discount', () => {
  test('batch mode applies the published multiplier', () => {
    const normal = computeCost(scenario(), gpt, guardrailTokenizer);
    const batch = computeCost(scenario({ batchEnabled: true }), gpt, guardrailTokenizer);
    expect(batch.totalCostUsd).toBeCloseTo(normal.totalCostUsd * 0.5, 10);
  });
});

describe("the vendor's own documented tokenizer correction", () => {
  test('Claude 4.7+ models carry the ~30% inflation Anthropic documents', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5']) {
      expect(staticPricing.priceFor(id)!.tokenizerInflation).toBeCloseTo(1.3, 5);
    }
  });

  test('models on their own published tokenizer need no correction', () => {
    for (const m of staticPricing.all()) {
      if (m.countAccuracy === 'exact') expect(m.tokenizerInflation).toBeUndefined();
    }
  });

  test('inflation rounds up — a fractional token is still billed', () => {
    const t = inflatedTokenizer({ estimateTokens: () => 10 }, 1.3);
    expect(t.estimateTokens('anything')).toBe(13);
    const t2 = inflatedTokenizer({ estimateTokens: () => 7 }, 1.3);
    expect(t2.estimateTokens('anything')).toBe(10); // 9.1 -> 10, never 9
  });

  test('without it an Anthropic run reads materially under the invoice', () => {
    const plain = computeCost(scenario({ turnCount: 20 }), opus, guardrailTokenizer);
    const corrected = computeCost(
      scenario({ turnCount: 20 }),
      opus,
      inflatedTokenizer(guardrailTokenizer, 1.3),
    );
    expect(corrected.totalInputTokens).toBeGreaterThan(plain.totalInputTokens);
  });
});

describe("the tool-use system prompt you never wrote", () => {
  test('Anthropic models declare the tokens they silently prepend', () => {
    expect(staticPricing.priceFor('claude-opus-4-8')!.toolSystemPromptTokens).toBe(290);
    expect(staticPricing.priceFor('claude-sonnet-5')!.toolSystemPromptTokens).toBe(354);
  });

  test('it is resent every turn, like everything else in the prefix', () => {
    const bare = computeCost(scenario({ turnCount: 10 }), opus, guardrailTokenizer);
    const withSys = computeCost(
      scenario({ turnCount: 10, toolDefinitionTokens: 290 }),
      opus,
      guardrailTokenizer,
    );
    expect(withSys.totalInputTokens - bare.totalInputTokens).toBe(2900);
  });
});

describe('long-context pricing — the bill changes because the run got older', () => {
  const haiku = staticPricing.priceFor('claude-haiku-5-5')!;

  test('the higher rates apply only above the threshold, and to every rate', () => {
    const under = ratesFor(haiku, 100_000);
    const over = ratesFor(haiku, 100_001);
    expect(under.longContext).toBe(false);
    expect(over.longContext).toBe(true);
    expect(over.input).toBeCloseTo(under.input * 5, 12);
    expect(over.output).toBeCloseTo(under.output * 5, 12);
    expect(over.cacheRead).toBeCloseTo(under.cacheRead * 5, 12);
    expect(over.cacheWrite!).toBeCloseTo(under.cacheWrite! * 5, 12);
  });

  test('a model with no long-context tier has one set of rates at any length', () => {
    const a = ratesFor(opus, 1_000);
    const b = ratesFor(opus, 900_000);
    expect(b).toEqual(a);
  });

  test('a run that crosses the line is billed at the higher rates from that turn on', () => {
    // 90,000 tokens of tools puts turn 1 under 100k; each turn adds a
    // 6,000-token reply, so the prompt crosses on the third request.
    const run = computeCost(
      scenario({ turnCount: 4, toolDefinitionTokens: 90_000, outputTokensPerTurn: 6_000 }),
      haiku,
      guardrailTokenizer,
    );
    expect(run.perTurn.map((t) => t.longContext)).toEqual([false, false, true, true]);

    const { longContext: _tier, ...flat } = haiku;
    const naive = computeCost(
      scenario({ turnCount: 4, toolDefinitionTokens: 90_000, outputTokensPerTurn: 6_000 }),
      flat,
      guardrailTokenizer,
    );
    // Same tokens, and the two turns past the line cost exactly 5x.
    expect(run.totalInputTokens).toBe(naive.totalInputTokens);
    expect(run.perTurn[1].costUsd).toBeCloseTo(naive.perTurn[1].costUsd, 12);
    expect(run.perTurn[2].costUsd).toBeCloseTo(naive.perTurn[2].costUsd * 5, 12);
    expect(run.totalCostUsd).toBeGreaterThan(naive.totalCostUsd * 2);
  });

  test('a cache rate missing from the tier falls back to the tier input, never the cheaper base', () => {
    const p: ModelPrice = {
      ...opus,
      longContext: {
        aboveTokens: 1000,
        input: { value: 10, unit: 'per_1m_tokens' },
        output: { value: 50, unit: 'per_1m_tokens' },
      },
    };
    const r = ratesFor(p, 2000);
    expect(r.cacheRead).toBe(r.input);
    expect(r.cacheWrite).toBeUndefined();
  });
});

describe('a provider that sells one cache lifetime', () => {
  const sol = staticPricing.priceFor('gpt-6.1-sol')!;

  test('its lifetime overrides the 5-minute / 1-hour choice', () => {
    // Ten minutes between turns kills a 5-minute Anthropic cache. A GPT-6 entry
    // lives at least 30 minutes, so the same run still reads from it.
    const slow = scenario({ cacheEnabled: true, secondsBetweenTurns: 600 });
    expect(computeCost(slow, opus, guardrailTokenizer).perTurn[1].cacheExpired).toBe(true);
    expect(computeCost(slow, sol, guardrailTokenizer).perTurn[1].cacheExpired).toBe(false);
    const slower = scenario({ cacheEnabled: true, secondsBetweenTurns: 1801 });
    expect(computeCost(slower, sol, guardrailTokenizer).perTurn[1].cacheExpired).toBe(true);
  });

  test("asking for a 1-hour cache does not invent a write rate it doesn't sell", () => {
    const five = computeCost(scenario({ cacheEnabled: true, cacheTtl: '5m' }), sol, guardrailTokenizer);
    const hour = computeCost(scenario({ cacheEnabled: true, cacheTtl: '1h' }), sol, guardrailTokenizer);
    expect(hour.totalCostUsd).toBe(five.totalCostUsd);
  });
});

describe('pricing table integrity', () => {
  test('the table says when it was read, and every row agrees', () => {
    expect(LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const m of staticPricing.all()) expect(m.seenAt <= LAST_REVIEWED).toBe(true);
  });

  test('model ids are unique', () => {
    const ids = staticPricing.all().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an announced price change is a real date, later than the day the row was read', () => {
    const dated = staticPricing.all().filter((m) => m.priceChangesOn);
    expect(dated.length).toBeGreaterThan(0);
    for (const m of dated) {
      expect(m.priceChangesOn!).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.priceChangesOn! > m.seenAt).toBe(true);
    }
  });

  test('a long-context tier is never cheaper than the base rates', () => {
    for (const m of staticPricing.all()) {
      if (!m.longContext) continue;
      expect(perToken(m.longContext.input)).toBeGreaterThan(perToken(m.input));
      expect(perToken(m.longContext.output)).toBeGreaterThan(perToken(m.output));
      expect(m.longContext.aboveTokens).toBeLessThan(m.contextWindow);
    }
  });

  test('every model carries provenance — no bare numbers', () => {
    for (const m of staticPricing.all()) {
      expect(m.sourceUrl).toStartWith('https://');
      expect(m.seenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.input.unit).toBeDefined();
      expect(m.output.unit).toBeDefined();
    }
  });

  test('output is priced above input for every model, as published', () => {
    for (const m of staticPricing.all()) {
      expect(perToken(m.output)).toBeGreaterThan(perToken(m.input));
    }
  });

  test('a cache read is always cheaper than fresh input', () => {
    for (const m of staticPricing.all()) {
      if (m.cacheRead) {
        expect(perToken(m.cacheRead)).toBeLessThan(perToken(m.input));
      }
    }
  });

  test('models without a public tokenizer are marked approximate', () => {
    for (const m of staticPricing.all()) {
      if (!m.encoding) expect(m.countAccuracy).toBe('approximate');
    }
  });
});

describe('custom rates must never look sourced', () => {
  test('every price shipped in the table is NOT custom', () => {
    for (const m of staticPricing.all()) expect(m.isCustom).toBeFalsy();
  });

  test('a custom price still prices correctly — it is only provenance that differs', () => {
    const base = staticPricing.priceFor('claude-opus-4-8')!;
    const mine: ModelPrice = {
      ...base,
      displayName: 'Self-hosted',
      input: { value: 1, unit: 'per_1m_tokens' },
      output: { value: 2, unit: 'per_1m_tokens' },
      cacheRead: undefined,
      cacheWrite: undefined,
      tokenizerInflation: undefined,
      isCustom: true,
    };
    const r = computeCost(scenario({ turnCount: 5 }), mine, guardrailTokenizer);
    const expected =
      r.totalInputTokens * 1e-6 + r.totalOutputTokens * 2e-6;
    expect(r.totalCostUsd).toBeCloseTo(expected, 10);
  });

  test('a model with no cache rates cannot produce a caching saving', () => {
    const base = staticPricing.priceFor('claude-opus-4-8')!;
    const noCache: ModelPrice = {
      ...base,
      cacheRead: undefined,
      cacheWrite: undefined,
      cacheWriteLong: undefined,
      isCustom: true,
    };
    const c = compareCaching(scenario({ turnCount: 20 }), noCache, guardrailTokenizer);
    expect(c.multiple).toBeCloseTo(1, 6);
  });
});

describe('formatting', () => {
  test('sub-cent amounts keep enough precision to be useful', () => {
    expect(formatUsd(0.000042)).toBe('$0.00004');
    expect(formatUsd(0.5)).toBe('$0.5000');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});

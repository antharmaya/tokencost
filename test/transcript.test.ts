import { describe, expect, test } from 'bun:test';
import { analyse, billedUsd, billRun, cacheTtlSeconds, parseTranscript } from '../src/transcript.js';
import { staticPricing } from '../src/pricing.js';

const turn = (o: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: o.at ?? '2026-08-05T10:00:00Z',
    request: {
      model: 'claude-opus-4-8',
      tools: o.tools ?? [{ name: 'read_file' }],
      messages: o.messages ?? [{ role: 'user', content: 'hi' }],
      ...(o.thinking ? { thinking: o.thinking } : {}),
    },
    response: { usage: o.usage ?? { input_tokens: 2000, output_tokens: 500 } },
  });

describe('parsing', () => {
  test('reads JSONL and a JSON array identically', () => {
    const a = parseTranscript([turn({}), turn({})].join('\n'));
    const b = parseTranscript(`[${turn({})},${turn({})}]`);
    expect(a.turns.length).toBe(2);
    expect(b.turns.length).toBe(a.turns.length);
  });

  test('pulls nested usage rather than returning zeros', () => {
    // The original code used `a ?? b ? c : d`, which parses as `(a ?? b) ? c : d`
    // and silently produced zero for every token count.
    const t = parseTranscript(turn({}));
    expect(t.turns[0].inputTokens).toBe(2000);
    expect(t.turns[0].outputTokens).toBe(500);
  });

  test('skips non-JSON lines instead of dying', () => {
    const t = parseTranscript(['not json', turn({}), ''].join('\n'));
    expect(t.turns.length).toBe(1);
  });

  test('key order is not mistaken for a tool change', () => {
    const a = parseTranscript(turn({ tools: [{ name: 'x', description: 'd' }] }));
    const b = parseTranscript(turn({ tools: [{ description: 'd', name: 'x' }] }));
    expect(a.turns[0].toolsRaw).toBe(b.turns[0].toolsRaw!);
  });
});

describe('findings separate fact from hypothesis', () => {
  test('a changed tools array is reported as measured and critical', () => {
    const t = parseTranscript(
      [turn({ tools: [{ name: 'a' }] }), turn({ tools: [{ name: 'a' }, { name: 'b' }] })].join('\n'),
    );
    const f = analyse(t).find((x) => x.title === 'Tool definitions changed')!;
    expect(f.confidence).toBe('measured');
    expect(f.severity).toBe('critical');
  });

  test('a gap past the TTL is measured from timestamps', () => {
    const t = parseTranscript(
      [
        turn({ at: '2026-08-05T10:00:00Z' }),
        turn({ at: '2026-08-05T10:20:00Z' }),
      ].join('\n'),
    );
    expect(analyse(t).some((x) => x.title === 'Gap exceeded the cache TTL')).toBe(true);
  });

  test('a thinking change is INFERRED, never asserted', () => {
    const t = parseTranscript(
      [turn({ thinking: { budget_tokens: 1000 } }), turn({ thinking: { budget_tokens: 4000 } })].join('\n'),
    );
    const f = analyse(t).find((x) => x.title === 'Thinking configuration changed')!;
    expect(f.confidence).toBe('inferred');
  });

  test('hit rate is measured when the provider reports it', () => {
    const t = parseTranscript(
      turn({ usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 400 } }),
    );
    const f = analyse(t).find((x) => x.title.startsWith('Achieved cache hit rate'))!;
    expect(f.confidence).toBe('measured');
    // Anthropic's input_tokens EXCLUDES cache reads and writes, so the prompt
    // was 1,400 tokens and 400 of them were reads. Dividing by 1,000 (the bug
    // this replaced) reported 40%.
    expect(f.title).toContain('28.6%');
  });

  test('OpenAI cached-token details make the hit rate measurable there too', () => {
    const responses = parseTranscript(
      JSON.stringify({
        request: { model: 'gpt-6.1-sol' },
        response: {
          usage: {
            input_tokens: 2000,
            output_tokens: 100,
            input_tokens_details: { cached_tokens: 1536, cache_write_tokens: 400 },
          },
        },
      }),
    );
    expect(responses.format).toBe('openai');
    expect(responses.cacheTokensReported).toBe(true);
    // OpenAI's input_tokens INCLUDES the cached part; nothing is added to it.
    expect(responses.turns[0].inputTokens).toBe(2000);
    expect(responses.turns[0].cacheWriteTokens).toBe(400);
    const f = analyse(responses).find((x) => x.title.startsWith('Achieved cache hit rate'))!;
    expect(f.title).toContain('76.8%');

    const chat = parseTranscript(
      JSON.stringify({
        request: { model: 'gpt-5.5' },
        response: {
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        },
      }),
    );
    expect(chat.turns[0].cacheReadTokens).toBe(1024);
  });

  test('and refuses to quote one when it cannot be separated', () => {
    // OpenAI folds cache reads into prompt_tokens. A number here would be a guess.
    const t = parseTranscript(
      JSON.stringify({ request: { model: 'gpt-5.5' }, response: { usage: { prompt_tokens: 900, completion_tokens: 50 } } }),
    );
    const f = analyse(t).find((x) => x.title.includes('not measurable'))!;
    expect(f.confidence).toBe('inferred');
    expect(t.format).toBe('openai');
  });

  test('every finding declares whether it is fact or hypothesis', () => {
    const t = parseTranscript(Array.from({ length: 12 }, () => turn({})).join('\n'));
    for (const f of analyse(t)) {
      expect(['measured', 'inferred']).toContain(f.confidence);
    }
  });
});

describe('what the run cost', () => {
  const opus = staticPricing.priceFor('claude-opus-4-8')!;

  test('fresh, read and written tokens are each billed at their own rate', () => {
    const t = parseTranscript(
      turn({
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 2000,
          output_tokens: 500,
        },
      }),
    );
    expect(t.turns[0].inputTokens).toBe(7000);
    // Opus 4.8: $5 in, $0.50 read, $6.25 write, $25 out, per million.
    const expected = (1000 * 5 + 4000 * 0.5 + 2000 * 6.25 + 500 * 25) / 1_000_000;
    expect(billedUsd(t, opus)!).toBeCloseTo(expected, 12);
  });

  test('a request over the long-context line is billed at the higher rates, whole', () => {
    const haiku = staticPricing.priceFor('claude-haiku-5-5')!;
    const usage = (read: number) => ({
      usage: { input_tokens: 10_000, cache_read_input_tokens: read, output_tokens: 1_000 },
    });
    const under = billedUsd(parseTranscript(turn(usage(80_000))), haiku)!;
    const over = billedUsd(parseTranscript(turn(usage(95_000))), haiku)!;
    expect(under).toBeCloseTo((10_000 * 0.1 + 80_000 * 0.01 + 1_000 * 0.5) / 1e6, 12);
    expect(over).toBeCloseTo((10_000 * 0.5 + 95_000 * 0.05 + 1_000 * 2.5) / 1e6, 12);
  });

  test('no token counts means no cost, not a cost of zero', () => {
    const t = parseTranscript(JSON.stringify({ request: { model: 'claude-opus-4-8' } }));
    expect(billedUsd(t, opus)).toBeUndefined();
  });
});

/* ── review of 2026-10-17: each test reproduces a bug confirmed on 0.1.0 ── */

const rec = (model: string | undefined, usage: Record<string, unknown>, at?: string, where: 'usage' | 'usageMetadata' = 'usage') =>
  JSON.stringify({
    ...(at ? { timestamp: at } : {}),
    request: model ? { model } : {},
    response: { [where]: usage },
  });

describe('anthropic cache lifetimes', () => {
  const opus = staticPricing.priceFor('claude-opus-5-5')!;

  test('1-hour writes are billed at the 1-hour rate, 5-minute writes at theirs', () => {
    // Shape from platform.claude.com/docs/en/build-with-claude/prompt-caching:
    // cache_creation_input_tokens equals the sum of the cache_creation object.
    const t = parseTranscript(
      rec('claude-opus-5-5', {
        input_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
        output_tokens: 0,
      }),
    );
    expect(t.turns[0].inputTokens).toBe(4000);
    expect(t.turns[0].cacheWrite1hTokens).toBe(2000);
    expect(t.turns[0].cacheWrite5mTokens).toBe(1000);
    // Opus 5.5: $4 in, $5 5-minute write, $8 1-hour write.
    expect(billedUsd(t, opus)!).toBeCloseTo((1000 * 4 + 1000 * 5 + 2000 * 8) / 1e6, 12);
  });

  test('a log with only the total still bills writes at the 5-minute rate', () => {
    const t = parseTranscript(rec('claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0 }));
    expect(billedUsd(t, opus)!).toBeCloseTo((1000 * 5) / 1e6, 12);
  });

  test('1-hour writes in the log move the TTL used for the gap finding to an hour', () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 }, output_tokens: 1 };
    const t = parseTranscript(
      [rec('claude-opus-5-5', usage, '2026-10-13T09:00:00Z'), rec('claude-opus-5-5', usage, '2026-10-13T09:20:00Z')].join('\n'),
    );
    expect(cacheTtlSeconds(t, opus)).toBe(3600);
    expect(analyse(t, { ttlSeconds: cacheTtlSeconds(t, opus) }).some((x) => x.title.startsWith('Gap exceeded'))).toBe(false);
    // Without the 1-hour writes, a 20-minute gap is past the 5-minute TTL.
    const plain = parseTranscript(
      [rec('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }, '2026-10-13T09:00:00Z'), rec('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }, '2026-10-13T09:20:00Z')].join('\n'),
    );
    expect(cacheTtlSeconds(plain, opus)).toBe(300);
    expect(analyse(plain, { ttlSeconds: cacheTtlSeconds(plain, opus) }).some((x) => x.title.startsWith('Gap exceeded'))).toBe(true);
  });

  test("a model's own cache lifetime wins", () => {
    const gpt = staticPricing.priceFor('gpt-6.1-sol')!;
    expect(gpt.cacheLifetimeSeconds).toBe(1800);
    const t = parseTranscript(rec('gpt-6.1-sol', { prompt_tokens: 10, completion_tokens: 1 }));
    expect(cacheTtlSeconds(t, gpt)).toBe(1800);
  });
});

describe('deepseek native usage', () => {
  test('prompt_cache_hit_tokens and prompt_cache_miss_tokens are read', () => {
    // api-docs.deepseek.com: prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens.
    const t = parseTranscript(
      rec('deepseek-flash', { prompt_tokens: 100_000, prompt_cache_hit_tokens: 90_000, prompt_cache_miss_tokens: 10_000, completion_tokens: 1_000 }),
    );
    expect(t.cacheTokensReported).toBe(true);
    expect(t.turns[0].inputTokens).toBe(100_000);
    expect(t.turns[0].cacheReadTokens).toBe(90_000);
    const flash = staticPricing.priceFor('deepseek-flash')!;
    // $0.30 miss, $0.006 hit, $1.20 out.
    expect(billedUsd(t, flash)!).toBeCloseTo((10_000 * 0.3 + 90_000 * 0.006 + 1_000 * 1.2) / 1e6, 12);
  });

  test('the prompt total is derived from hit + miss when prompt_tokens is absent', () => {
    const t = parseTranscript(rec('deepseek-flash', { prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700, completion_tokens: 5 }));
    expect(t.turns[0].inputTokens).toBe(1000);
    expect(t.turns[0].cacheReadTokens).toBe(300);
  });
});

describe('gemini usageMetadata', () => {
  test('prompt, cached, candidate and thought counts are read; thoughts bill as output', () => {
    // ai.google.dev/api/generate-content: promptTokenCount INCLUDES cached content;
    // thoughtsTokenCount is separate from candidatesTokenCount.
    const t = parseTranscript(
      rec('gemini-4-argon', { promptTokenCount: 10_000, cachedContentTokenCount: 6_000, candidatesTokenCount: 500, thoughtsTokenCount: 1_500, totalTokenCount: 12_000 }, undefined, 'usageMetadata'),
    );
    expect(t.format).toBe('gemini');
    expect(t.cacheTokensReported).toBe(true);
    expect(t.turns[0].inputTokens).toBe(10_000);
    expect(t.turns[0].cacheReadTokens).toBe(6_000);
    expect(t.turns[0].outputTokens).toBe(2_000);
    expect(t.turns[0].reasoningTokens).toBe(1_500);
    const argon = staticPricing.priceFor('gemini-4-argon')!;
    // $2 in, $0.10 cached, $10 out.
    expect(billedUsd(t, argon)!).toBeCloseTo((4_000 * 2 + 6_000 * 0.1 + 2_000 * 10) / 1e6, 12);
  });

  test('the model is read from modelVersion when the request has none', () => {
    const t = parseTranscript(JSON.stringify({ response: { modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } }));
    expect(t.turns[0].model).toBe('gemini-3.8-flash');
    expect(t.turns[0].inputTokens).toBe(10);
  });
});

describe('mixed-model runs', () => {
  const log = [
    rec('claude-opus-5-5', { input_tokens: 50_000, output_tokens: 0 }),
    rec('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 0 }),
    rec('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 0 }),
  ].join('\n');

  test('each turn is priced at its own model, with per-model subtotals', () => {
    const bill = billRun(parseTranscript(log), staticPricing.priceFor);
    // 50k each: Opus 5.5 at $4/M, Haiku 5.5 at $0.10/M twice (under its 100k
    // long-context line). Under 0.1.0 all three were billed as Opus: $0.60.
    expect(bill.totalUsd!).toBeCloseTo(0.2 + 0.005 + 0.005, 9);
    expect(bill.byModel.map((m) => [m.priceId, m.turns])).toEqual([
      ['claude-opus-5-5', 1],
      ['claude-haiku-5-5', 2],
    ]);
    expect(bill.byModel[1].costUsd!).toBeCloseTo(0.01, 9);
  });

  test('an override prices every turn at one model', () => {
    const opus = staticPricing.priceFor('claude-opus-5-5')!;
    const bill = billRun(parseTranscript(log), staticPricing.priceFor, opus);
    expect(bill.totalUsd!).toBeCloseTo(0.6, 9);
    expect(bill.byModel).toHaveLength(1);
  });

  test('turns at an unpriced model are counted, not silently priced at another', () => {
    const t = parseTranscript([rec('claude-opus-5-5', { input_tokens: 50_000, output_tokens: 0 }), rec('mystery-1', { input_tokens: 5, output_tokens: 0 })].join('\n'));
    const bill = billRun(t, staticPricing.priceFor);
    expect(bill.totalUsd!).toBeCloseTo(0.2, 9);
    expect(bill.unpricedTurns).toBe(1);
    expect(bill.byModel.find((m) => m.model === 'mystery-1')!.costUsd).toBeNull();
  });
});

describe('hit rate', () => {
  test('a turn with reads but no prompt total cannot push the rate past 100%', () => {
    // 0.1.0 printed "50000.0%" for this log.
    const t = parseTranscript(
      [
        rec('gpt-5.5', { prompt_tokens_details: { cached_tokens: 50_000 }, completion_tokens: 1 }),
        rec('gpt-5.5', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 1 }),
      ].join('\n'),
    );
    const f = analyse(t).find((x) => x.title.startsWith('Achieved cache hit rate'))!;
    expect(f.title).toContain('0.0%');
  });

  test('never above 100% even when a provider over-reports reads', () => {
    const t = parseTranscript(rec('gpt-5.5', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 150 }, completion_tokens: 1 }));
    const f = analyse(t).find((x) => x.title.startsWith('Achieved cache hit rate'))!;
    expect(f.title).toContain('100.0%');
  });
});

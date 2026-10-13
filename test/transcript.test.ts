import { describe, expect, test } from 'bun:test';
import { analyse, billedUsd, parseTranscript } from '../src/transcript.js';
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

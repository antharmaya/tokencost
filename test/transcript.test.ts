import { describe, expect, test } from 'bun:test';
import { analyse, parseTranscript } from '../src/transcript.js';

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
    expect(f.title).toContain('40.0%');
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

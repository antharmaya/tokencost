import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync('bun', [cli, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

describe('cli output', () => {
  test('no ANSI colour when stdout is not a TTY', () => {
    const r = run([join(import.meta.dir, '..', 'examples', 'run.jsonl')]);
    expect(r.stdout).toContain('turns');
    expect(r.stdout).not.toContain('\x1b[');
  });

  test('--json reports per-model subtotals and --model overrides every turn', () => {
    const log = [
      JSON.stringify({ request: { model: 'claude-opus-5-5' }, response: { usage: { input_tokens: 50_000, output_tokens: 0 } } }),
      JSON.stringify({ request: { model: 'claude-haiku-5-5' }, response: { usage: { input_tokens: 50_000, output_tokens: 0 } } }),
    ].join('\n');
    const mixed = JSON.parse(run(['--json'], {}, log).stdout);
    expect(mixed.estimatedCostUsd).toBeCloseTo(0.205, 9);
    expect(mixed.byModel.map((m: { priceId: string }) => m.priceId)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    const forced = JSON.parse(run(['--json', '--model', 'claude-opus-5-5'], {}, log).stdout);
    expect(forced.estimatedCostUsd).toBeCloseTo(0.4, 9);
    expect(forced.byModel).toHaveLength(1);
  });
});

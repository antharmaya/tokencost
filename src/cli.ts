#!/usr/bin/env node
/**
 * tokencost — audit a real agent transcript for cache-destroying patterns.
 *
 *   npx @antharmaya/tokencost run.jsonl
 *   cat run.json | npx @antharmaya/tokencost
 *
 * Every public calculator prices a hypothetical. This reads what actually
 * happened, and separates what it can prove from what it can only suspect —
 * because a tool that prints a guess in the same typeface as a measurement is
 * worse than one that stays quiet.
 */

import { readFileSync } from 'node:fs';
import { analyse, parseTranscript, type Finding } from './transcript.js';
import { staticPricing } from './pricing.js';
import { perToken, formatUsd, CACHE_TTL_SECONDS } from './cost.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function readInput(path?: string): string {
  if (path) return readFileSync(path, 'utf8');
  return readFileSync(0, 'utf8'); // stdin
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`tokencost — audit an agent transcript for cache-destroying patterns

  tokencost <file.jsonl|file.json>
  cat run.json | tokencost

  --json         machine-readable output
  --model <id>   price against a specific model (default: read from the log)

Accepts a JSON array or JSONL. Records may be raw provider requests, or
{ request, response, timestamp } wrappers. Nothing is uploaded; this runs
entirely on your machine.`);
    return;
  }

  const asJson = args.includes('--json');
  // indexOf returns -1 when the flag is absent, and -1 + 1 is 0 — which silently
  // grabs the filename as the model and leaves no file argument, so the CLI sits
  // waiting on a stdin nobody is writing to. Check for the flag before indexing.
  const modelIdx = args.indexOf('--model');
  const modelFlag = modelIdx === -1 ? undefined : args[modelIdx + 1];
  const file = args.find(
    (a: string, i: number) =>
      !a.startsWith('--') && !(modelIdx !== -1 && i === modelIdx + 1),
  );

  let raw = '';
  try {
    raw = readInput(file);
  } catch {
    console.error('Could not read input. Pass a file path or pipe a log on stdin.');
    process.exit(2);
  }

  const t = parseTranscript(raw);
  if (!t.turns.length) {
    console.error('No turns found. Expected a JSON array or JSONL of requests.');
    process.exit(2);
  }

  const modelId = modelFlag ?? t.turns.find((x) => x.model)?.model;
  const price = modelId ? staticPricing.priceFor(modelId) : undefined;

  const findings = analyse(t, {
    cacheMinimumTokens: price?.cacheMinimumTokens,
    ttlSeconds: CACHE_TTL_SECONDS['5m'],
  });

  // Actual spend, where the log reports enough to compute it.
  const input = t.turns.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
  const output = t.turns.reduce((a, x) => a + (x.outputTokens ?? 0), 0);
  const cacheRead = t.turns.reduce((a, x) => a + (x.cacheReadTokens ?? 0), 0);
  const billed =
    price && input
      ? (input - cacheRead) * perToken(price.input) +
        cacheRead * perToken(price.cacheRead ?? price.input) +
        output * perToken(price.output)
      : undefined;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          format: t.format,
          cacheTokensReported: t.cacheTokensReported,
          turns: t.turns.length,
          totals: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
          model: price
            ? { id: price.id, source: price.sourceUrl, seenAt: price.seenAt }
            : { id: modelId ?? null, note: 'not in the bundled price table' },
          estimatedCostUsd: billed ?? null,
          findings,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log(C.bold(`  ${t.turns.length} turns` + (modelId ? ` · ${modelId}` : '')));
  console.log(
    C.dim(
      `  ${input.toLocaleString()} input · ${output.toLocaleString()} output` +
        (t.cacheTokensReported ? ` · ${cacheRead.toLocaleString()} from cache` : ''),
    ),
  );
  if (billed !== undefined) {
    console.log(C.dim(`  ~${formatUsd(billed)} at ${price!.displayName} list prices`));
    console.log(C.dim(`  prices read ${price!.seenAt} · ${price!.sourceUrl}`));
  } else if (modelId && !price) {
    console.log(
      C.dim(`  no bundled price for "${modelId}" — token counts only, no cost`),
    );
  } else if (!input) {
    // Distinct from "no price". Conflating them sent me looking for a pricing
    // bug when the real fault was that no usage had been parsed at all.
    console.log(
      C.dim('  no token counts in this log — findings only, no cost'),
    );
  }

  const measured = findings.filter((f) => f.confidence === 'measured');
  const inferred = findings.filter((f) => f.confidence === 'inferred');

  print('MEASURED — these are facts from your log', measured);
  print('INFERRED — these are hypotheses, not measurements', inferred);

  console.log('');
  const critical = measured.filter((f) => f.severity === 'critical').length;
  process.exit(critical > 0 ? 1 : 0);
}

function print(heading: string, findings: Finding[]) {
  if (!findings.length) return;
  console.log('');
  console.log(C.bold(`  ${heading}`));
  for (const f of findings) {
    const mark =
      f.severity === 'critical' ? C.red('✗') : f.severity === 'warning' ? C.yellow('!') : C.blue('·');
    const where = f.turn !== undefined ? C.dim(` (turn ${f.turn + 1})`) : '';
    console.log(`  ${mark} ${f.title}${where}`);
    for (const line of wrap(f.detail, 72)) console.log(C.dim(`      ${line}`));
  }
}

function wrap(s: string, w: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > w) {
      lines.push(cur.trim());
      cur = word;
    } else cur += ' ' + word;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

main();

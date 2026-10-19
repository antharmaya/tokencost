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
import { analyse, billRun, cacheTtlSeconds, parseTranscript, type Finding } from './transcript.js';
import { staticPricing, LAST_REVIEWED, STALE_AFTER_DAYS, tableAgeDays } from './pricing.js';
import { formatUsd } from './cost.js';

// Colour only for a person at a terminal: not when piped or redirected, and
// not when NO_COLOR is set to anything non-empty (no-color.org).
const colour = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  yellow: paint('33'),
  blue: paint('34'),
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
  --model <id>   price every turn at this model (default: each turn's own)

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
  const override = modelFlag ? price : undefined;
  // --model with an id the table does not know prices nothing, rather than
  // silently falling back to whatever the log says.
  const bill =
    modelFlag && !price
      ? undefined
      : billRun(t, staticPricing.priceFor, override);
  const models = bill?.byModel ?? [];
  const mixed = models.length > 1;

  const findings = analyse(t, {
    cacheMinimumTokens: price?.cacheMinimumTokens,
    ttlSeconds: cacheTtlSeconds(t, price),
  });

  // Actual spend, where the log reports enough to compute it.
  const input = t.turns.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
  const output = t.turns.reduce((a, x) => a + (x.outputTokens ?? 0), 0);
  const cacheRead = t.turns.reduce((a, x) => a + (x.cacheReadTokens ?? 0), 0);
  const cacheWrite = t.turns.reduce((a, x) => a + (x.cacheWriteTokens ?? 0), 0);
  const billed = bill?.totalUsd;
  // A vendor announced new rates from this date. The bundled ones are unchecked
  // past it, and saying so beats printing a confident number that may be stale.
  const today = new Date().toISOString().slice(0, 10);
  const pastChangeDate =
    price?.priceChangesOn !== undefined && today >= price.priceChangesOn;
  // The bundled table ages from the day it was installed. Past the limit, say
  // so on every run rather than print old rates in a confident typeface.
  const tableAge = tableAgeDays(today);
  const tableStale = tableAge > STALE_AFTER_DAYS;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          format: t.format,
          cacheTokensReported: t.cacheTokensReported,
          turns: t.turns.length,
          totals: {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
          },
          model: price
            ? {
                id: price.id,
                source: price.sourceUrl,
                seenAt: price.seenAt,
                ...(price.priceChangesOn
                  ? { priceChangesOn: price.priceChangesOn, pastChangeDate }
                  : {}),
              }
            : { id: modelId ?? null, note: 'not in the bundled price table' },
          estimatedCostUsd: billed ?? null,
          byModel: models,
          unpricedTurns: bill?.unpricedTurns ?? t.turns.length,
          priceTable: { lastReviewed: LAST_REVIEWED, ageDays: tableAge, stale: tableStale },
          findings,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  const label = mixed ? `${models.length} models` : modelId;
  console.log(C.bold(`  ${t.turns.length} turns` + (label ? ` · ${label}` : '')));
  console.log(
    C.dim(
      `  ${input.toLocaleString()} input · ${output.toLocaleString()} output` +
        (t.cacheTokensReported ? ` · ${cacheRead.toLocaleString()} from cache` : ''),
    ),
  );
  if (billed !== undefined && mixed) {
    console.log(C.dim(`  ~${formatUsd(billed)} at list prices, each turn at its own model`));
    for (const m of models) {
      const p = m.priceId ? staticPricing.priceFor(m.priceId) : undefined;
      console.log(
        C.dim(
          `    ${m.model ?? '(no model)'} · ${m.turns} turn(s) · ` +
            (m.costUsd !== null && p ? `~${formatUsd(m.costUsd)} · prices read ${p.seenAt}` : 'no bundled price, not included'),
        ),
      );
    }
  } else if (billed !== undefined) {
    console.log(C.dim(`  ~${formatUsd(billed)} at ${price!.displayName} list prices`));
    console.log(C.dim(`  prices read ${price!.seenAt} · ${price!.sourceUrl}`));
    if (pastChangeDate) {
      console.log(
        C.yellow(
          `  ! the vendor announced new rates for this model from ${price!.priceChangesOn}; ` +
            'this figure uses the earlier ones',
        ),
      );
    }
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

  if (tableStale) {
    console.log(
      C.yellow(
        `  ! the bundled price table was last checked ${LAST_REVIEWED}, ${tableAge} days ago; ` +
          'rates may have changed. Update with npm i @antharmaya/tokencost@latest',
      ),
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

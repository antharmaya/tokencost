#!/usr/bin/env bun
/**
 * Daily price check: re-read every vendor page cited in src/pricing.json,
 * compare each model's numbers with the table, and report what differs.
 *
 *   bun scripts/check-prices.ts                 live pages, print a report
 *   bun scripts/check-prices.ts --fixtures test/fixtures
 *   bun scripts/check-prices.ts --save-fixtures refresh test/fixtures from live
 *   bun scripts/check-prices.ts --acknowledge   mark every untabled model listed
 *                                               today as known (silences the
 *                                               new-models issue)
 *   bun scripts/check-prices.ts --github        what the workflow runs: open or
 *                                               update a PR / issues
 *   --today YYYY-MM-DD  --json
 *
 * The seams:
 *   fetch  ->  parse (price-parsers.ts, pure)  ->  compare (runCheck, pure)
 *          ->  applyUpdates (pure)  ->  GitHub (price-github.ts)
 * Everything up to GitHub runs offline against test/fixtures/, which is how a
 * vendor layout change shows up as a failing parser test instead of a wrong
 * price.
 *
 * Exit codes outside --github: 0 table current, 1 findings, 2 crashed.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelPrice, Rate } from '../src/types.ts';
import {
  type Field,
  type ParsedSource,
  type Quoted,
  type VendorModel,
  parseAnthropicCacheMinimums,
  parseAnthropicPricing,
  parseDeepSeekPricing,
  parseGooglePricing,
  parseOpenAIPricing,
} from './price-parsers.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TABLE_PATH = join(ROOT, 'src/pricing.json');
export const WATCH_PATH = join(ROOT, 'scripts/price-watch.json');
export const FIXTURES = join(ROOT, 'test/fixtures');

/** Open a PR that only re-dates the rows once the table is this old. */
export const REFRESH_AFTER_DAYS = 30;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceId = 'anthropic-pricing' | 'anthropic-caching' | 'openai-pricing' | 'deepseek-pricing' | 'google-pricing';
export type Provider = 'anthropic' | 'openai' | 'deepseek' | 'google';

export interface Source {
  /** What is fetched. May differ from what the table cites (the .md form). */
  url: string;
  fixture: string;
  /** A string the real page always contains. Its absence means sign-in wall or new layout. */
  expect: string;
}

export const SOURCES: Record<SourceId, Source> = {
  'anthropic-pricing': {
    url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    fixture: 'anthropic-pricing.md',
    expect: 'Base input tokens',
  },
  'anthropic-caching': {
    url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md',
    fixture: 'anthropic-prompt-caching.md',
    expect: 'Cache limitations',
  },
  'openai-pricing': {
    url: 'https://developers.openai.com/api/docs/pricing.md',
    fixture: 'openai-pricing.md',
    expect: 'Standard pricing data',
  },
  'deepseek-pricing': {
    url: 'https://api-docs.deepseek.com/quick_start/pricing/',
    fixture: 'deepseek-pricing.html',
    expect: 'CACHE MISS',
  },
  // A browser User-Agent gets bounced through Google sign-in in a redirect
  // loop; a plain one gets the server-rendered page. The .md.txt variant is
  // fetchable too but was stale on 2026-10-14 (no Gemini 4 Argon section), so
  // it is not used: a stale page that parses is worse than one that fails.
  'google-pricing': {
    url: 'https://ai.google.dev/gemini-api/docs/pricing?hl=en',
    fixture: 'google-pricing.html',
    expect: 'class="pricing-table"',
  },
};

interface ProviderSpec {
  /** The URL rows cite in sourceUrl. */
  cites: string;
  pages: SourceId[];
  /** The vendor's name for a row. */
  label: (row: ModelPrice) => string;
  /** Fields this provider's pages publish, and so the fields that get compared. */
  fields: Field[];
}

const RATES: Field[] = ['input', 'output', 'cacheWrite', 'cacheWriteLong', 'cacheRead'];
const LONG: Field[] = [
  'longContext.aboveTokens',
  'longContext.input',
  'longContext.output',
  'longContext.cacheWrite',
  'longContext.cacheWriteLong',
  'longContext.cacheRead',
];

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  anthropic: {
    cites: 'https://platform.claude.com/docs/en/about-claude/pricing',
    pages: ['anthropic-pricing', 'anthropic-caching'],
    label: (r) => r.displayName,
    fields: [...RATES, ...LONG, 'batchMultiplier', 'toolSystemPromptTokens', 'cacheMinimumTokens'],
  },
  openai: {
    cites: 'https://developers.openai.com/api/docs/pricing',
    pages: ['openai-pricing'],
    label: (r) => r.id,
    fields: [
      'input',
      'output',
      'cacheWrite',
      'cacheRead',
      'longContext.aboveTokens',
      'longContext.input',
      'longContext.output',
      'longContext.cacheWrite',
      'longContext.cacheRead',
      'batchMultiplier',
    ],
  },
  deepseek: {
    cites: 'https://api-docs.deepseek.com/quick_start/pricing/',
    pages: ['deepseek-pricing'],
    label: (r) => r.id,
    fields: ['input', 'output', 'cacheRead'],
  },
  google: {
    cites: 'https://ai.google.dev/gemini-api/docs/pricing',
    pages: ['google-pricing'],
    label: (r) => r.id,
    fields: ['input', 'output', 'cacheRead', 'batchMultiplier'],
  },
};

function providerFor(row: ModelPrice): Provider | undefined {
  return (Object.keys(PROVIDERS) as Provider[]).find((p) => PROVIDERS[p].cites === row.sourceUrl);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const USER_AGENT = 'tokencost-price-check/1 (+https://github.com/antharmaya/tokencost)';

export async function fetchPage(src: Source, attempts = 3): Promise<string> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(src.url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const host = new URL(res.url || src.url).host;
      if (host !== new URL(src.url).host) throw new Error(`redirected to ${host} (a sign-in wall?)`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes(src.expect)) {
        throw new Error(`page does not contain "${src.expect}" (sign-in page or a new layout)`);
      }
      return text;
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export type Pages = Partial<Record<SourceId, string | Error>>;

export async function fetchAll(): Promise<Pages> {
  const ids = Object.keys(SOURCES) as SourceId[];
  const got = await Promise.all(ids.map((id) => fetchPage(SOURCES[id]).catch((e: Error) => e)));
  return Object.fromEntries(ids.map((id, k) => [id, got[k]]));
}

export function readFixtures(dir: string): Pages {
  const out: Pages = {};
  for (const id of Object.keys(SOURCES) as SourceId[]) {
    try {
      out[id] = readFileSync(join(dir, SOURCES[id].fixture), 'utf8');
    } catch (e) {
      out[id] = e as Error;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface Table {
  $comment?: string;
  lastReviewed: string;
  models: ModelPrice[];
}

export interface Watch {
  /** Name prefixes per provider. A listed model in one of these is "in a family we track". */
  families: Record<Provider, string[]>;
  /** Models listed on the pages that the table deliberately leaves out. */
  known: Record<Provider, string[]>;
}

export interface Diff {
  field: Field;
  old: number;
  new: number;
  quote: string;
}

export interface Presence {
  field: Field;
  table?: number;
  vendor?: Quoted;
}

export interface RowResult {
  id: string;
  provider?: Provider;
  label: string;
  /** verified: every page read and the row found. */
  status: 'verified' | 'missing' | 'unverifiable';
  reason?: string;
  diffs: Diff[];
  presence: Presence[];
  problems: string[];
  schedule: string[];
  /** Re-read in full today, so its seenAt may move. */
  reread: boolean;
}

export interface SourceResult {
  id: SourceId;
  url: string;
  ok: boolean;
  error?: string;
}

export interface Report {
  today: string;
  sources: SourceResult[];
  rows: RowResult[];
  newModels: { provider: Provider; names: string[] }[];
  changeDates: { id: string; date: string }[];
  /** Providers whose pages all parsed. */
  readProviders: Provider[];
}

function tableValue(row: ModelPrice, field: Field): number | undefined {
  const rate = (r?: Rate) => (r ? (r.unit === 'per_1m_tokens' ? r.value : r.value * 1000) : undefined);
  switch (field) {
    case 'input':
    case 'output':
    case 'cacheWrite':
    case 'cacheWriteLong':
    case 'cacheRead':
      return rate(row[field]);
    case 'longContext.aboveTokens':
      return row.longContext?.aboveTokens;
    case 'longContext.input':
    case 'longContext.output':
    case 'longContext.cacheWrite':
    case 'longContext.cacheWriteLong':
    case 'longContext.cacheRead': {
      const k = field.slice('longContext.'.length) as 'input';
      return rate(row.longContext?.[k]);
    }
    case 'batchMultiplier':
    case 'cacheMinimumTokens':
    case 'toolSystemPromptTokens':
      return row[field];
  }
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Every dollar or plain figure written in a note, as numbers. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
}

/** The rows' vendor data, merged across a provider's pages. */
function vendorView(provider: Provider, parsed: Partial<Record<SourceId, ParsedSource | Map<string, Quoted>>>) {
  if (provider === 'anthropic') {
    const main = parsed['anthropic-pricing'] as ParsedSource;
    const mins = parsed['anthropic-caching'] as Map<string, Quoted>;
    return {
      names: main.names,
      get(label: string): VendorModel | undefined {
        const m = main.models.get(label);
        if (!m) return undefined;
        const min = mins.get(label);
        return min ? { ...m, fields: { ...m.fields, cacheMinimumTokens: min } } : m;
      },
    };
  }
  const src = parsed[PROVIDERS[provider].pages[0]!] as ParsedSource;
  return { names: src.names, get: (label: string) => src.models.get(label) };
}

export function runCheck(pages: Pages, table: Table, watch: Watch, today: string): Report {
  const sources: SourceResult[] = [];
  const parsed: Partial<Record<SourceId, ParsedSource | Map<string, Quoted>>> = {};
  for (const id of Object.keys(SOURCES) as SourceId[]) {
    const page = pages[id];
    const res: SourceResult = { id, url: SOURCES[id].url, ok: false };
    try {
      if (page === undefined) throw new Error('not fetched');
      if (page instanceof Error) throw page;
      parsed[id] =
        id === 'anthropic-pricing'
          ? parseAnthropicPricing(page)
          : id === 'anthropic-caching'
            ? parseAnthropicCacheMinimums(page)
            : id === 'openai-pricing'
              ? parseOpenAIPricing(page)
              : id === 'deepseek-pricing'
                ? parseDeepSeekPricing(page)
                : parseGooglePricing(page, today);
      res.ok = true;
    } catch (e) {
      res.error = (e as Error).message;
    }
    sources.push(res);
  }
  const okSource = (id: SourceId) => sources.find((s) => s.id === id)!.ok;
  const readProviders = (Object.keys(PROVIDERS) as Provider[]).filter((p) => PROVIDERS[p].pages.every(okSource));

  const rows: RowResult[] = table.models.map((row) => {
    const provider = providerFor(row);
    const base = { id: row.id, provider, diffs: [], presence: [], problems: [], schedule: [], reread: false };
    if (!provider) {
      return { ...base, label: row.displayName, status: 'unverifiable', reason: `no parser for the cited page ${row.sourceUrl}` };
    }
    const spec = PROVIDERS[provider];
    const label = spec.label(row);
    if (!readProviders.includes(provider)) {
      const failed = spec.pages.filter((p) => !okSource(p)).map((p) => SOURCES[p].url);
      return { ...base, label, status: 'unverifiable', reason: `could not verify automatically: ${failed.join(', ')} could not be read` };
    }
    const vendor = vendorView(provider, parsed).get(label);
    if (!vendor) {
      return { ...base, label, status: 'missing', reason: `"${label}" is not on ${spec.cites} (layout change, renamed, or retired)` };
    }
    const result: RowResult = { ...base, label, status: 'verified', problems: [...vendor.problems] };
    for (const field of spec.fields) {
      const t = tableValue(row, field);
      const v = vendor.fields[field];
      if (t !== undefined && v !== undefined) {
        if (!same(t, v.value)) result.diffs.push({ field, old: t, new: v.value, quote: v.quote });
      } else if (t !== undefined || v !== undefined) {
        result.presence.push({ field, table: t, vendor: v });
      }
    }
    // Announced changes. The table marks one with priceChangesOn and spells the
    // new rates out in the note; check both against what the vendor says now.
    const dates = [...new Set(vendor.scheduled.map((s) => s.from))];
    if (dates.length > 1) result.schedule.push(`vendor announces changes on more than one date: ${dates.join(', ')}`);
    if (dates.length && row.priceChangesOn === undefined) {
      result.schedule.push(`vendor announces new rates from ${dates.join(', ')}; the row has no priceChangesOn`);
    } else if (dates.length && !dates.includes(row.priceChangesOn!)) {
      result.schedule.push(`vendor now announces new rates from ${dates.join(', ')}; the row says ${row.priceChangesOn}`);
    } else if (!dates.length && row.priceChangesOn && today < row.priceChangesOn) {
      result.schedule.push(`the row expects new rates on ${row.priceChangesOn}, but the vendor page no longer announces a change (cancelled?)`);
    }
    const noted = numbersIn(row.note ?? '');
    for (const s of vendor.scheduled) {
      if (!noted.some((n) => same(n, s.value))) {
        result.schedule.push(`vendor announces ${s.field} $${s.value} from ${s.from}; the note does not mention that figure. Vendor line: ${s.quote}`);
      }
    }
    result.reread = result.problems.length === 0;
    return result;
  });

  const newModels = readProviders
    .map((provider) => {
      const view = vendorView(provider, parsed);
      const tabled = new Set(rows.filter((r) => r.provider === provider).map((r) => r.label));
      const known = new Set(watch.known[provider] ?? []);
      const fam = watch.families[provider] ?? [];
      const names = [...new Set(view.names)].filter(
        (n) => fam.some((f) => n.startsWith(f)) && !tabled.has(n) && !known.has(n),
      );
      return { provider, names };
    })
    .filter((x) => x.names.length);

  const changeDates = table.models
    .filter((m) => m.priceChangesOn && today >= m.priceChangesOn)
    .map((m) => ({ id: m.id, date: m.priceChangesOn! }));

  return { today, sources, rows, newModels, changeDates, readProviders };
}

// ---------------------------------------------------------------------------
// Updating the table
// ---------------------------------------------------------------------------

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type UpdateKind = 'prices' | 'refresh';

/**
 * The table to propose, or undefined on a quiet day.
 *
 * A PR is opened when a number differs, or — with no differences — when the
 * table has gone REFRESH_AFTER_DAYS without a re-dated row, so that the
 * shipped table's date tracks the last real check rather than the last price
 * change. Only rows re-read in full today get a new seenAt; lastReviewed moves
 * only when every row was.
 */
export function applyUpdates(tableText: string, report: Report): { text: string; kind: UpdateKind } | undefined {
  const table = JSON.parse(tableText) as Table;
  const diffs = report.rows.flatMap((r) => r.diffs);
  const reread = report.rows.filter((r) => r.reread);
  const refreshDue = daysBetween(table.lastReviewed, report.today) >= REFRESH_AFTER_DAYS;
  if (!diffs.length && !(refreshDue && reread.length)) return undefined;

  for (const r of report.rows) {
    const row = table.models.find((m) => m.id === r.id)!;
    for (const d of r.diffs) setValue(row, d.field, d.new);
    if (r.reread) row.seenAt = report.today;
  }
  if (report.rows.every((r) => r.reread)) table.lastReviewed = report.today;
  const text = JSON.stringify(table, null, 2) + '\n';
  return text === tableText ? undefined : { text, kind: diffs.length ? 'prices' : 'refresh' };
}

function setValue(row: ModelPrice, field: Field, value: number) {
  const setRate = (r: Rate | undefined) => {
    if (!r) throw new Error(`${row.id}.${field}: no rate to update`);
    r.value = r.unit === 'per_1m_tokens' ? value : value / 1000;
  };
  if (field.startsWith('longContext.')) {
    const k = field.slice('longContext.'.length);
    if (k === 'aboveTokens') row.longContext!.aboveTokens = value;
    else setRate(row.longContext?.[k as 'input']);
  } else if (field === 'batchMultiplier' || field === 'cacheMinimumTokens' || field === 'toolSystemPromptTokens') {
    row[field] = value;
  } else {
    setRate(row[field as 'input']);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmt = (n: number | undefined) => (n === undefined ? 'none' : String(n));
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** The PR body: every change, old -> new, with the vendor's own line. */
export function renderPrBody(report: Report, table: Table, kind: UpdateKind, runUrl?: string): string {
  const out: string[] = [];
  const changed = report.rows.filter((r) => r.diffs.length);
  if (kind === 'prices') {
    out.push(`The daily price check found ${changed.reduce((a, r) => a + r.diffs.length, 0)} number(s) on the vendor pages that differ from \`src/pricing.json\` on ${report.today}.`);
  } else {
    out.push(`No price differs. The table was last re-dated ${table.lastReviewed}, more than ${REFRESH_AFTER_DAYS} days ago, so this PR only moves the dates of the rows re-read today.`);
  }
  out.push('', '**This PR is never merged automatically.** Check each quoted line against the page, merge, then tag a release so the npm package carries the new table.', '');
  for (const r of changed) {
    const row = table.models.find((m) => m.id === r.id)!;
    out.push(`### ${r.id}`, '', `Source: ${row.sourceUrl}`, '');
    for (const d of r.diffs) {
      out.push(`- **${d.field}**: ${fmt(d.old)} → **${fmt(d.new)}**`, `  > ${code(d.quote)}`);
    }
    const noted = numbersIn(row.note ?? '');
    const stale = r.diffs.filter((d) => noted.some((n) => same(n, d.old)));
    if (stale.length) {
      out.push('', `⚠️ The row's \`note\` mentions ${stale.map((d) => fmt(d.old)).join(', ')}. Notes are prose and are not edited by the bot; fix it by hand in this PR before merging.`);
    }
    out.push('');
  }
  const reread = report.rows.filter((r) => r.reread).map((r) => r.id);
  const notReread = report.rows.filter((r) => !r.reread).map((r) => r.id);
  out.push(`**seenAt → ${report.today}** for the ${reread.length} row(s) re-read in full: ${reread.join(', ') || 'none'}.`);
  out.push(
    notReread.length
      ? `**lastReviewed not moved**: ${notReread.join(', ')} could not be fully re-read (see the open \`price-check\` issues).`
      : `**lastReviewed → ${report.today}**: every row was re-read.`,
  );
  if (runUrl) out.push('', `Run: ${runUrl}`);
  out.push('', '<!-- price-check-pr -->');
  return out.join('\n');
}

export function renderReport(report: Report): string {
  const out: string[] = [`## Price check ${report.today}`, ''];
  out.push('| Source | Read |', '|---|---|');
  for (const s of report.sources) out.push(`| ${s.url} | ${s.ok ? 'yes' : `**no** — ${s.error}`} |`);
  out.push('', '| Model | Status | Differences | Other |', '|---|---|---|---|');
  for (const r of report.rows) {
    const other = [...r.problems, ...r.presence.map((p) => `${p.field}: table ${fmt(p.table)}, vendor ${fmt(p.vendor?.value)}`), ...r.schedule, ...(r.reason ? [r.reason] : [])];
    out.push(
      `| ${r.id} | ${r.status} | ${r.diffs.map((d) => `${d.field} ${d.old} → ${d.new}`).join('; ') || '—'} | ${other.join('; ').replace(/\|/g, '\\|') || '—'} |`,
    );
  }
  for (const n of report.newModels) out.push('', `New ${n.provider} models in a tracked family: ${n.names.join(', ')}`);
  for (const c of report.changeDates) out.push('', `${c.id}: priceChangesOn ${c.date} has arrived.`);
  return out.join('\n');
}

export function hasFindings(report: Report): boolean {
  return (
    report.sources.some((s) => !s.ok) ||
    report.rows.some((r) => r.status !== 'verified' || r.diffs.length || r.presence.length || r.problems.length || r.schedule.length) ||
    report.newModels.length > 0 ||
    report.changeDates.length > 0
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function loadTable(): { text: string; table: Table } {
  const text = readFileSync(TABLE_PATH, 'utf8');
  return { text, table: JSON.parse(text) as Table };
}

export function loadWatch(): Watch {
  return JSON.parse(readFileSync(WATCH_PATH, 'utf8')) as Watch;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const today = value('--today') ?? new Date().toISOString().slice(0, 10);

  if (flag('--save-fixtures')) {
    mkdirSync(FIXTURES, { recursive: true });
    const meta: Record<string, string> = {};
    for (const src of Object.values(SOURCES)) {
      const text = await fetchPage(src);
      writeFileSync(join(FIXTURES, src.fixture), text);
      meta[src.fixture] = src.url;
      console.log(`saved ${src.fixture} (${text.length} bytes) from ${src.url}`);
    }
    writeFileSync(join(FIXTURES, 'SOURCES.json'), JSON.stringify({ fetchedOn: today, files: meta }, null, 2) + '\n');
    return;
  }

  const fixtures = value('--fixtures');
  const pages = fixtures ? readFixtures(fixtures) : await fetchAll();
  const { text, table } = loadTable();
  const watch = loadWatch();
  const report = runCheck(pages, table, watch, today);

  if (flag('--acknowledge')) {
    for (const n of report.newModels) {
      watch.known[n.provider] = [...new Set([...(watch.known[n.provider] ?? []), ...n.names])].sort();
    }
    writeFileSync(WATCH_PATH, JSON.stringify(watch, null, 2) + '\n');
    console.log(`acknowledged: ${report.newModels.map((n) => `${n.provider}: ${n.names.join(', ')}`).join('; ') || 'nothing new'}`);
    return;
  }

  const update = applyUpdates(text, report);

  if (flag('--github')) {
    const { syncGitHub } = await import('./price-github.ts');
    const md = renderReport(report);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n', { flag: 'a' });
    await syncGitHub({ report, table, update, cwd: ROOT });
    return;
  }

  if (flag('--json')) console.log(JSON.stringify({ report, update: update?.kind ?? null }, null, 2));
  else {
    console.log(renderReport(report));
    if (update) console.log(`\nWould open a PR (${update.kind}).`);
  }
  process.exit(hasFindings(report) || update ? 1 : 0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

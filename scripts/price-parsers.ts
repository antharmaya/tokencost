/**
 * Vendor pricing-page parsers.
 *
 * Pure functions: page text in, numbers out, every number paired with the exact
 * vendor line it came from. No fetching, no comparison, no GitHub — those live
 * in check-prices.ts, so these can be tested against saved copies of the pages
 * in test/fixtures/.
 *
 * The rule throughout: a parser that does not recognise what it is reading
 * says so (LayoutError, or a per-row problem). It never falls back to "the
 * nearest number", because a guessed price that happens to parse is exactly
 * the silent failure this machinery exists to prevent.
 */

/** Thrown when a page no longer has the shape a parser was written for. */
export class LayoutError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = 'LayoutError';
  }
}

/** Every numeric field the checker knows how to compare. */
export type Field =
  | 'input'
  | 'output'
  | 'cacheWrite'
  | 'cacheWriteLong'
  | 'cacheRead'
  | 'longContext.aboveTokens'
  | 'longContext.input'
  | 'longContext.output'
  | 'longContext.cacheWrite'
  | 'longContext.cacheWriteLong'
  | 'longContext.cacheRead'
  | 'batchMultiplier'
  | 'cacheMinimumTokens'
  | 'toolSystemPromptTokens';

export interface Quoted {
  value: number;
  /** The vendor's own line, verbatim, so a reviewer can check it at a glance. */
  quote: string;
}

/** A rate the vendor has announced for a later date. */
export interface Scheduled {
  field: Field;
  value: number;
  from: string; // ISO date
  quote: string;
}

export interface VendorModel {
  /** The vendor's name for the model, as matched against the table. */
  label: string;
  /** Fields the vendor publishes for this model. A field not here is "none". */
  fields: Partial<Record<Field, Quoted>>;
  scheduled: Scheduled[];
  /** Cells that were present but could not be read. Never guessed around. */
  problems: string[];
}

export interface ParsedSource {
  models: Map<string, VendorModel>;
  /** Every model name the page lists, for spotting new ones. */
  names: string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function model(label: string): VendorModel {
  return { label, fields: {}, scheduled: [], problems: [] };
}

function getModel(map: Map<string, VendorModel>, label: string): VendorModel {
  let m = map.get(label);
  if (!m) {
    m = model(label);
    map.set(label, m);
  }
  return m;
}

/** `[text](url)` -> `text`, drop `<sup>..</sup>` footnote markers. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove every parenthetical, e.g. "(retired, except on Google Cloud)". */
function dropParentheticals(s: string): string {
  return s.replace(/\s*\([^)]*\)/g, '').trim();
}

/** "$0.125 / MTok" -> 0.125, "$5.00" -> 5. Anything else -> undefined. */
export function dollars(cell: string): number | undefined {
  const m = /^\$\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?$/.exec(stripMarkdown(cell));
  return m ? Number(m[1]) : undefined;
}

/** A dash, an empty cell or "Not available" means the vendor publishes none. */
function isNone(cell: string): boolean {
  const c = stripMarkdown(cell);
  return c === '' || c === '-' || c === '—' || /^not available$/i.test(c);
}

function ratio(a: number, b: number): number {
  return Math.round((a / b) * 1e6) / 1e6;
}

interface MdTable {
  header: string[];
  rows: { cells: string[]; line: string }[];
  /** Line index of the header row. */
  at: number;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

/** Every pipe table in a markdown document, in order. */
export function markdownTables(md: string): MdTable[] {
  const lines = md.split('\n');
  const tables: MdTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i]!.trim();
    const sep = lines[i + 1]!.trim();
    if (!head.startsWith('|') || !/^\|[\s:|-]+\|$/.test(sep) || !sep.includes('-')) continue;
    const table: MdTable = { header: splitRow(head).map(stripMarkdown), rows: [], at: i };
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) {
      table.rows.push({ cells: splitRow(lines[j]!), line: lines[j]!.trim() });
    }
    tables.push(table);
    i = j - 1;
  }
  return tables;
}

function columns(source: string, table: MdTable, wanted: string[]): number[] {
  return wanted.map((w) => {
    const idx = table.header.indexOf(w);
    if (idx === -1) {
      throw new LayoutError(source, `column "${w}" not found; header is: ${table.header.join(' | ')}`);
    }
    return idx;
  });
}

/** Collapse a markdown table row's padding so the quote is readable. */
function tidyQuote(line: string): string {
  return line.replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Anthropic — platform.claude.com/docs/en/about-claude/pricing.md
// ---------------------------------------------------------------------------

const ANTHROPIC = 'anthropic pricing page';

/** "Claude Haiku 5.5 (for prompts over 100,000 tokens)" -> label + tier. */
function anthropicLabel(cell: string): { label: string; over?: number; upTo?: number } {
  const text = stripMarkdown(cell);
  const tier = /\(for prompts (up to|over) ([\d,]+) tokens\)/.exec(text);
  const label = dropParentheticals(text);
  if (!tier) return { label };
  const n = Number(tier[2]!.replace(/,/g, ''));
  return tier[1] === 'over' ? { label, over: n } : { label, upTo: n };
}

export function parseAnthropicPricing(md: string): ParsedSource {
  const tables = markdownTables(md);
  const models = new Map<string, VendorModel>();
  const names: string[] = [];

  const main = tables.find(
    (t) => t.header.includes('Base input tokens') && t.header.includes('Output tokens'),
  );
  if (!main) throw new LayoutError(ANTHROPIC, 'model pricing table not found');
  const [cModel, cIn, c5m, c1h, cHit, cOut] = columns(ANTHROPIC, main, [
    'Model',
    'Base input tokens',
    '5m cache writes',
    '1h cache writes',
    'Cache hits and refreshes',
    'Output tokens',
  ]);

  for (const row of main.rows) {
    const { label, over } = anthropicLabel(row.cells[cModel!] ?? '');
    if (!label) continue;
    if (!names.includes(label)) names.push(label);
    const m = getModel(models, label);
    const quote = tidyQuote(row.line);
    const prefix = over !== undefined ? 'longContext.' : '';
    const cells: [string, number][] = [
      ['input', cIn!],
      ['cacheWrite', c5m!],
      ['cacheWriteLong', c1h!],
      ['cacheRead', cHit!],
      ['output', cOut!],
    ];
    for (const [field, idx] of cells) {
      const cell = row.cells[idx] ?? '';
      if (isNone(cell)) continue;
      const v = dollars(cell);
      if (v === undefined) {
        m.problems.push(`could not read ${prefix}${field} from "${stripMarkdown(cell)}" in: ${quote}`);
      } else {
        m.fields[`${prefix}${field}` as Field] = { value: v, quote };
      }
    }
    if (over !== undefined) m.fields['longContext.aboveTokens'] = { value: over, quote };
  }

  // Batch: a multiplier on the standard rates. Read both columns, and refuse
  // to report one number if input and output disagree.
  const batch = tables.find((t) => t.header.includes('Batch input'));
  if (!batch) throw new LayoutError(ANTHROPIC, 'batch pricing table not found');
  const [bModel, bIn, bOut] = columns(ANTHROPIC, batch, ['Model', 'Batch input', 'Batch output']);
  for (const row of batch.rows) {
    const { label, over } = anthropicLabel(row.cells[bModel!] ?? '');
    if (over !== undefined) continue; // the multiplier is read on the base tier
    const m = models.get(label);
    if (!m) continue;
    const bi = dollars(row.cells[bIn!] ?? '');
    const bo = dollars(row.cells[bOut!] ?? '');
    const si = m.fields.input?.value;
    const so = m.fields.output?.value;
    if (bi === undefined || bo === undefined || si === undefined || so === undefined) {
      m.problems.push(`could not read batch rates in: ${tidyQuote(row.line)}`);
      continue;
    }
    const ri = ratio(bi, si);
    const ro = ratio(bo, so);
    if (ri !== ro) {
      m.problems.push(`batch input is ${ri}x and output ${ro}x; not one multiplier: ${tidyQuote(row.line)}`);
      continue;
    }
    m.fields.batchMultiplier = { value: ri, quote: tidyQuote(row.line) };
  }

  // Tool-use system prompt: the "auto, none" column is the one every request
  // with tools pays.
  const tools = tables.find((t) =>
    t.header.some((h) => h.startsWith('Tool use system prompt tokens: auto')),
  );
  if (!tools) throw new LayoutError(ANTHROPIC, 'tool use system prompt table not found');
  const autoCol = tools.header.findIndex((h) => h.startsWith('Tool use system prompt tokens: auto'));
  const [tModel] = columns(ANTHROPIC, tools, ['Model']);
  for (const row of tools.rows) {
    const { label } = anthropicLabel(row.cells[tModel!] ?? '');
    const m = models.get(label);
    if (!m) continue;
    const cell = stripMarkdown(row.cells[autoCol] ?? '');
    if (isNone(cell)) continue;
    const t = /^([\d,]+) tokens$/.exec(cell);
    if (!t) {
      m.problems.push(`could not read tool-use system prompt from "${cell}": ${tidyQuote(row.line)}`);
      continue;
    }
    m.fields.toolSystemPromptTokens = { value: Number(t[1]!.replace(/,/g, '')), quote: tidyQuote(row.line) };
  }

  return { models, names };
}

const ANTHROPIC_CACHING = 'anthropic prompt-caching page';

/**
 * Minimum cacheable prompt length per model, from the "Cache limitations"
 * section's bullet list: "* 512 tokens for Claude Opus 5.5, ..., and Claude
 * Haiku 5.5".
 */
export function parseAnthropicCacheMinimums(md: string): Map<string, Quoted> {
  const start = md.indexOf('### Cache limitations');
  if (start === -1) throw new LayoutError(ANTHROPIC_CACHING, '"Cache limitations" section not found');
  const end = md.indexOf('\n#', start + 5);
  const section = md.slice(start, end === -1 ? undefined : end);
  const out = new Map<string, Quoted>();
  for (const line of section.split('\n')) {
    const m = /^\s*[*-]\s+([\d,]+) tokens for (.+)$/.exec(line);
    if (!m) continue;
    const value = Number(m[1]!.replace(/,/g, ''));
    const list = dropParentheticals(stripMarkdown(m[2]!));
    for (const name of list.split(/,\s*(?:and\s+)?|\s+and\s+/)) {
      const n = name.trim();
      if (n) out.set(n, { value, quote: line.trim() });
    }
  }
  if (out.size === 0) throw new LayoutError(ANTHROPIC_CACHING, 'no "N tokens for <models>" bullets under Cache limitations');
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI — developers.openai.com/api/docs/pricing.md
// ---------------------------------------------------------------------------

const OPENAI = 'openai pricing page';

const OPENAI_COLUMNS = [
  'Model',
  'Short context input',
  'Short context cached input',
  'Short context cache writes',
  'Short context output',
  'Long context input',
  'Long context cached input',
  'Long context cache writes',
  'Long context output',
] as const;

const OPENAI_FIELDS: Field[] = [
  'input',
  'cacheRead',
  'cacheWrite',
  'output',
  'longContext.input',
  'longContext.cacheRead',
  'longContext.cacheWrite',
  'longContext.output',
];

function tableAfterHeading(source: string, md: string, heading: string): MdTable {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at === -1) throw new LayoutError(source, `heading "${heading}" not found`);
  const t = markdownTables(md).find((x) => x.at > at);
  if (!t) throw new LayoutError(source, `no table after "${heading}"`);
  return t;
}

export function parseOpenAIPricing(md: string): ParsedSource {
  const models = new Map<string, VendorModel>();
  const names: string[] = [];
  const std = tableAfterHeading(OPENAI, md, '### Standard pricing data');
  const cols = columns(OPENAI, std, [...OPENAI_COLUMNS]);

  // "Short context: ≤272K input tokens. Long context: >272K input tokens."
  const lc = /^.*Long context:\s*>\s*([\d.]+)\s*K input tokens.*$/m.exec(md);
  const longLine = lc ? { value: Math.round(Number(lc[1]) * 1000), quote: lc[0].trim() } : undefined;

  for (const row of std.rows) {
    const label = dropParentheticals(stripMarkdown(row.cells[cols[0]!] ?? ''));
    if (!label) continue;
    names.push(label);
    const m = getModel(models, label);
    const quote = row.line;
    let hasLong = false;
    OPENAI_FIELDS.forEach((field, k) => {
      const cell = row.cells[cols[k + 1]!] ?? '';
      if (isNone(cell)) return;
      const v = dollars(cell);
      if (v === undefined) {
        m.problems.push(`could not read ${field} from "${stripMarkdown(cell)}" in: ${quote}`);
        return;
      }
      m.fields[field] = { value: v, quote };
      if (field.startsWith('longContext.')) hasLong = true;
    });
    if (hasLong) {
      if (longLine) m.fields['longContext.aboveTokens'] = longLine;
      else m.problems.push('long-context rates are listed but the "Long context: >NK input tokens" line was not found');
    }
  }

  const batch = tableAfterHeading(OPENAI, md, '### Batch pricing data');
  const [bModel, bIn] = columns(OPENAI, batch, ['Model', 'Short context input']);
  for (const row of batch.rows) {
    const label = dropParentheticals(stripMarkdown(row.cells[bModel!] ?? ''));
    const m = models.get(label);
    const si = m?.fields.input?.value;
    const bi = dollars(row.cells[bIn!] ?? '');
    if (!m || si === undefined || bi === undefined) continue;
    m.fields.batchMultiplier = { value: ratio(bi, si), quote: row.line };
  }

  return { models, names };
}

// ---------------------------------------------------------------------------
// HTML helpers (DeepSeek, Google)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function htmlText(s: string): string {
  return s
    .replace(/<sup>.*?<\/sup>/gs, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (all, e: string) =>
      ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : all),
    )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function htmlRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of tableHtml.matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => htmlText(c[1]!));
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DeepSeek — api-docs.deepseek.com/quick_start/pricing/
// ---------------------------------------------------------------------------

const DEEPSEEK = 'deepseek pricing page';

/**
 * The table uses rowspans, so a row's leading cells vary. The model columns
 * are always the LAST n cells, where n is the number of models in the MODEL
 * row. The category (cache hit / cache miss / output) is carried down from the
 * row that names it. PEAK is what the table stores.
 */
export function parseDeepSeekPricing(html: string): ParsedSource {
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]).find((t) => /CACHE MISS/i.test(t));
  if (!table) throw new LayoutError(DEEPSEEK, 'pricing table (with a CACHE MISS row) not found');
  const rows = htmlRows(table);
  const modelRow = rows.find((r) => r[0] === 'MODEL');
  if (!modelRow || modelRow.length < 2) throw new LayoutError(DEEPSEEK, 'MODEL row not found');
  const names = modelRow.slice(1);
  const n = names.length;
  const models = new Map<string, VendorModel>(names.map((l) => [l, model(l)]));

  let category: 'cacheRead' | 'input' | 'output' | undefined;
  let categoryText = '';
  const seen = new Set<string>();
  for (const r of rows) {
    const cat = r.find((c) => /INPUT TOKENS|OUTPUT TOKENS/i.test(c));
    if (cat) {
      categoryText = cat.replace(/\n/g, ' ');
      category = /CACHE HIT/i.test(cat)
        ? 'cacheRead'
        : /CACHE MISS/i.test(cat)
          ? 'input'
          : /OUTPUT/i.test(cat)
            ? 'output'
            : undefined;
    } else if (!r.includes('PEAK') && !r.includes('OFF-PEAK')) {
      category = undefined;
    }
    if (!category || !r.includes('PEAK')) continue;
    const values = r.slice(-n);
    const quote = `${categoryText} | ${r.slice(r.indexOf('PEAK')).join(' | ')}`;
    values.forEach((cell, k) => {
      const m = models.get(names[k]!)!;
      const v = dollars(cell);
      if (v === undefined) m.problems.push(`could not read peak ${category} from "${cell}" in: ${quote}`);
      else m.fields[category!] = { value: v, quote };
    });
    seen.add(category);
  }
  for (const c of ['cacheRead', 'input', 'output']) {
    if (!seen.has(c)) throw new LayoutError(DEEPSEEK, `no PEAK row found for ${c}`);
  }
  return { models, names };
}

// ---------------------------------------------------------------------------
// Google — ai.google.dev/gemini-api/docs/pricing
// ---------------------------------------------------------------------------

const GOOGLE = 'google gemini pricing page';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "December 1, 2026" -> "2026-12-01". */
export function isoDate(text: string): string | undefined {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month === -1) return undefined;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface PaidCell {
  /** The rate in force on `today`. */
  current?: number;
  /** A later rate the vendor has announced. */
  next?: { value: number; from: string };
  problem?: string;
}

/**
 * Read a "Paid Tier" cell. Two shapes are understood:
 *   "$2.00"                                              — one rate
 *   "$2.00 through November 30, 2026. $4.00 starting December 1, 2026."
 * Per-hour storage prices in the same cell are ignored. Anything else is a
 * problem, not a guess.
 */
export function readPaidCell(text: string, today: string): PaidCell {
  const through = /\$([\d.]+) through ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text);
  const starting = /\$([\d.]+) starting ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text);
  if (through || starting) {
    if (!through || !starting) return { problem: `only one side of a dated price change: "${text}"` };
    const until = isoDate(through[2]!);
    const from = isoDate(starting[2]!);
    if (!until || !from) return { problem: `unreadable date in "${text}"` };
    if (addDays(until, 1) !== from) return { problem: `"through ${through[2]}" and "starting ${starting[2]}" are not consecutive days` };
    const before = Number(through[1]);
    const after = Number(starting[1]);
    return today >= from ? { current: after } : { current: before, next: { value: after, from } };
  }
  // Drop storage prices ("$0.50 / 1,000,000 tokens per hour") before looking.
  const rates = [...text.replace(/\$[\d.]+ \/ [\d,]+ tokens per hour[^.]*\.?/g, '').matchAll(/\$([\d.]+)/g)].map((m) => Number(m[1]));
  if (rates.length === 1) return { current: rates[0] };
  if (rates.length === 0) return {};
  return { problem: `more than one rate and no date to choose between them: "${text}"` };
}

const GOOGLE_ROWS: [RegExp, Field][] = [
  [/^Input price/, 'input'],
  [/^Output price/, 'output'],
  [/^Context caching price/, 'cacheRead'],
];

function googleTable(source: string, sectionHtml: string, tab: string): string[][] | undefined {
  const h3 = new RegExp(`<h3[^>]*>\\s*${tab}\\s*</h3>\\s*(<table[\\s\\S]*?</table>)`, 'i').exec(sectionHtml);
  if (!h3) return undefined;
  const rows = htmlRows(h3[1]!);
  const head = rows[0] ?? [];
  if (!/Paid Tier/i.test(head[head.length - 1] ?? '')) {
    throw new LayoutError(source, `${tab} table's last column is "${head[head.length - 1]}", expected "Paid Tier…"`);
  }
  return rows.slice(1);
}

export function parseGooglePricing(html: string, today: string): ParsedSource {
  if (!/class="pricing-table"/.test(html)) throw new LayoutError(GOOGLE, 'no pricing tables on the page (sign-in page or new layout?)');
  const models = new Map<string, VendorModel>();
  const names: string[] = [];
  const heads = [...html.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)];
  heads.forEach((h, k) => {
    const id = h[1]!;
    const section = html.slice(h.index!, heads[k + 1]?.index ?? html.length);
    if (!/<table class="pricing-table"/.test(section)) return;
    names.push(id);
    const m = getModel(models, id);
    let std: string[][] | undefined;
    let batch: string[][] | undefined;
    try {
      std = googleTable(GOOGLE, section, 'Standard');
      batch = googleTable(GOOGLE, section, 'Batch');
    } catch (e) {
      m.problems.push((e as Error).message);
      return;
    }
    if (!std) {
      m.problems.push('no "Standard" pricing table in this section');
      return;
    }
    const quoteOf = (r: string[]) => `${htmlText(h[2]!)} · Standard · ${r[0]} | ${r[r.length - 1]!.replace(/\n/g, ' ')}`;
    for (const [re, field] of GOOGLE_ROWS) {
      const r = std.find((row) => re.test(row[0] ?? ''));
      if (!r) continue;
      const cell = r[r.length - 1]!;
      if (isNone(cell) || /free of charge/i.test(cell)) continue;
      const p = readPaidCell(cell.replace(/\n/g, ' '), today);
      if (p.problem) m.problems.push(`${field}: ${p.problem}`);
      if (p.current !== undefined) m.fields[field] = { value: p.current, quote: quoteOf(r) };
      if (p.next) m.scheduled.push({ field, value: p.next.value, from: p.next.from, quote: quoteOf(r) });
    }
    const bi = batch?.find((row) => /^Input price/.test(row[0] ?? ''));
    if (bi && m.fields.input) {
      const p = readPaidCell(bi[bi.length - 1]!.replace(/\n/g, ' '), today);
      if (p.current !== undefined) {
        m.fields.batchMultiplier = {
          value: ratio(p.current, m.fields.input.value),
          quote: `${htmlText(h[2]!)} · Batch · ${bi[0]} | ${bi[bi.length - 1]!.replace(/\n/g, ' ')}`,
        };
      }
    }
  });
  if (names.length === 0) throw new LayoutError(GOOGLE, 'no model sections with pricing tables');
  return { models, names };
}

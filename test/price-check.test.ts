/**
 * The price check, run against saved copies of the vendor pages.
 *
 * The first block pins what each parser reads off today's pages. When a vendor
 * changes layout, refresh the fixtures (`bun scripts/check-prices.ts
 * --save-fixtures`) and these fail, instead of the daily job quietly reading a
 * wrong number. The rest mutate a fixture to simulate each thing that can
 * happen to a vendor page, and assert the checker opens a PR only for a real
 * number change and an issue for everything else.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseAnthropicCacheMinimums,
  parseAnthropicPricing,
  parseDeepSeekPricing,
  parseGooglePricing,
  parseOpenAIPricing,
  readPaidCell,
  LayoutError,
} from '../scripts/price-parsers.ts';
import {
  FIXTURES,
  TABLE_PATH,
  applyUpdates,
  hasFindings,
  loadTable,
  loadWatch,
  readFixtures,
  renderPrBody,
  runCheck,
  type Pages,
} from '../scripts/check-prices.ts';
import { GitHub, desiredIssues, planIssues, syncGitHub } from '../scripts/price-github.ts';

const TODAY = '2026-10-14';
const fx = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const { text: tableText, table } = loadTable();
const watch = loadWatch();
const pages = () => readFixtures(FIXTURES);
const check = (p: Pages, today = TODAY, t = table) => runCheck(p, t, watch, today);
const with_ = (id: keyof Pages, f: (s: string) => string): Pages => {
  const p = pages();
  p[id] = f(p[id] as string);
  return p;
};

describe('parsers read the saved vendor pages', () => {
  test('Anthropic: rates, long-context tier, batch, tool prompt', () => {
    const a = parseAnthropicPricing(fx('anthropic-pricing.md'));
    const opus = a.models.get('Claude Opus 5.5')!;
    expect(opus.fields.input!.value).toBe(4);
    expect(opus.fields.output!.value).toBe(20);
    expect(opus.fields.cacheWrite!.value).toBe(5);
    expect(opus.fields.cacheWriteLong!.value).toBe(8);
    expect(opus.fields.cacheRead!.value).toBe(0.2);
    expect(opus.fields.batchMultiplier!.value).toBe(0.5);
    expect(opus.fields.toolSystemPromptTokens!.value).toBe(286);
    expect(opus.fields.input!.quote).toContain('| Claude Opus 5.5');
    const haiku = a.models.get('Claude Haiku 5.5')!;
    expect(haiku.fields['longContext.aboveTokens']!.value).toBe(100000);
    expect(haiku.fields['longContext.input']!.value).toBe(0.5);
    expect(haiku.fields['longContext.output']!.value).toBe(2.5);
    expect(a.models.get('Claude Fable 5.1')!.fields.toolSystemPromptTokens).toBeUndefined();
  });

  test('Anthropic caching page: per-model minimums', () => {
    const m = parseAnthropicCacheMinimums(fx('anthropic-prompt-caching.md'));
    expect(m.get('Claude Opus 5.5')!.value).toBe(512);
    expect(m.get('Claude Opus 4.8')!.value).toBe(1024);
    expect(m.get('Claude Opus 4.7')!.value).toBe(2048);
    expect(m.get('Claude Opus 4.6')!.value).toBe(4096);
    expect(m.get('Claude Sonnet 5')!.value).toBe(1024);
  });

  test('OpenAI: short and long context, the >272K line, batch', () => {
    const o = parseOpenAIPricing(fx('openai-pricing.md'));
    const a = o.models.get('gpt-6-astra')!;
    expect([a.fields.input!.value, a.fields.cacheRead!.value, a.fields.cacheWrite!.value, a.fields.output!.value]).toEqual([10, 1, 12.5, 50]);
    expect(a.fields['longContext.aboveTokens']!.value).toBe(272000);
    expect(a.fields['longContext.aboveTokens']!.quote).toContain('>272K input tokens');
    expect(a.fields['longContext.output']!.value).toBe(75);
    const g55 = o.models.get('gpt-5.5')!; // listed as "gpt-5.5 (<272K context length)"
    expect(g55.fields.cacheWrite).toBeUndefined();
    expect(g55.fields['longContext.input']!.value).toBe(10);
    expect(o.models.get('gpt-5.4-mini')!.fields['longContext.input']).toBeUndefined();
    expect(o.models.get('gpt-5.4-mini')!.fields.batchMultiplier!.value).toBe(0.5);
  });

  test('DeepSeek: PEAK, not off-peak', () => {
    const d = parseDeepSeekPricing(fx('deepseek-pricing.html'));
    expect(d.names).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const pro = d.models.get('deepseek-v4-pro')!;
    expect([pro.fields.input!.value, pro.fields.output!.value, pro.fields.cacheRead!.value]).toEqual([1.32, 3.96, 0.044]);
    expect(pro.fields.input!.quote).toContain('CACHE MISS');
    expect(pro.fields.input!.quote).toContain('PEAK | $0.3 | $1.32');
  });

  test('Google: launch rate in force, scheduled rate recorded', () => {
    const g = parseGooglePricing(fx('google-pricing.html'), TODAY);
    const argon = g.models.get('gemini-4-argon')!;
    expect([argon.fields.input!.value, argon.fields.output!.value, argon.fields.cacheRead!.value]).toEqual([2, 10, 0.1]);
    expect(argon.scheduled.map((s) => [s.field, s.value, s.from])).toEqual([
      ['input', 4, '2026-12-01'],
      ['output', 20, '2026-12-01'],
      ['cacheRead', 0.2, '2026-12-01'],
    ]);
    expect(argon.fields.batchMultiplier!.value).toBe(0.5);
    // After the switch date the later rate is the one in force.
    expect(parseGooglePricing(fx('google-pricing.html'), '2026-12-01').models.get('gemini-4-argon')!.fields.input!.value).toBe(4);
  });

  test('readPaidCell refuses what it does not understand', () => {
    expect(readPaidCell('$0.30', TODAY)).toEqual({ current: 0.3 });
    expect(readPaidCell('$1 through November 30, 2026. $2 starting December 1, 2026.', TODAY).next).toEqual({ value: 2, from: '2026-12-01' });
    expect(readPaidCell('$1.25, prompts <= 200k tokens $2.50, prompts > 200k', TODAY).problem).toBeDefined();
    expect(readPaidCell('$1 through November 30, 2026. $2 starting December 5, 2026.', TODAY).problem).toContain('not consecutive');
  });

  test('a renamed column is a LayoutError, not a guess', () => {
    expect(() => parseAnthropicPricing(fx('anthropic-pricing.md').replace('Base input tokens', 'Input'))).toThrow(LayoutError);
    expect(() => parseOpenAIPricing(fx('openai-pricing.md').replace(/Short context output/g, 'Output'))).toThrow(LayoutError);
    expect(() => parseDeepSeekPricing('<html>sign in</html>')).toThrow(LayoutError);
  });
});

describe('the check against the table', () => {
  test('the shipped table matches every saved page', () => {
    const r = check(pages());
    expect(r.sources.every((s) => s.ok)).toBe(true);
    expect(r.rows.map((x) => [x.id, x.status, x.diffs.length, x.presence.length, x.problems.length, x.schedule.length])).toEqual(
      table.models.map((m) => [m.id, 'verified', 0, 0, 0, 0]),
    );
    expect(r.newModels).toEqual([]);
    expect(hasFindings(r)).toBe(false);
    expect(applyUpdates(tableText, r)).toBeUndefined(); // quiet day: nothing committed
  });

  test('pricing.json is canonical, so the bot rewrites only what changed', () => {
    expect(JSON.stringify(JSON.parse(tableText), null, 2) + '\n').toBe(readFileSync(TABLE_PATH, 'utf8'));
  });

  test('a changed price becomes a PR: old -> new, quoted line, re-dated rows', () => {
    const p = with_('anthropic-pricing', (s) => s.replace(/(\| Claude Opus 5\.5 [^\n]*?)\$0\.20 \/ MTok/, '$1$0.25 / MTok'));
    const r = check(p);
    const opus = r.rows.find((x) => x.id === 'claude-opus-5-5')!;
    expect(opus.diffs).toEqual([{ field: 'cacheRead', old: 0.2, new: 0.25, quote: expect.stringContaining('$0.25 / MTok') }]);
    expect(opus.diffs[0]!.quote).toStartWith('| Claude Opus 5.5 |');
    const up = applyUpdates(tableText, r)!;
    expect(up.kind).toBe('prices');
    const next = JSON.parse(up.text);
    const row = next.models.find((m: any) => m.id === 'claude-opus-5-5');
    expect(row.cacheRead.value).toBe(0.25);
    expect(row.seenAt).toBe(TODAY);
    expect(next.lastReviewed).toBe(TODAY);
    // Only the rate and the dates moved.
    const changed = up.text.split('\n').filter((l, i) => l !== tableText.split('\n')[i]);
    expect(changed.every((l) => /"(value|seenAt|lastReviewed)"/.test(l))).toBe(true);
    const body = renderPrBody(r, table, 'prices');
    expect(body).toContain('**cacheRead**: 0.2 → **0.25**');
    expect(body).toContain('$0.25 / MTok');
    expect(body).toContain('never merged automatically');
  });

  test('an input change the batch table contradicts is a problem, and the row is not re-dated', () => {
    const r = check(with_('anthropic-pricing', (s) => s.replace(/(\| Claude Opus 5\.5 +\| )\$4 \/ MTok/, '$1$5 / MTok')));
    const opus = r.rows.find((x) => x.id === 'claude-opus-5-5')!;
    expect(opus.diffs.map((d) => [d.field, d.new])).toEqual([['input', 5]]);
    expect(opus.problems[0]).toContain('not one multiplier');
    expect(opus.reread).toBe(false);
    const next = JSON.parse(applyUpdates(tableText, r)!.text);
    expect(next.models.find((m: any) => m.id === 'claude-opus-5-5').seenAt).toBe('2026-10-13');
    expect(next.lastReviewed).toBe('2026-10-13');
  });

  test('a note that quotes the old figure is flagged in the PR', () => {
    const p = with_('anthropic-pricing', (s) => s.replace(/(\| Claude Opus 5\.5 [^\n]*?)286 tokens/, '$1300 tokens'));
    const r = check(p);
    expect(r.rows.find((x) => x.id === 'claude-opus-5-5')!.diffs[0]).toMatchObject({ field: 'toolSystemPromptTokens', old: 286, new: 300 });
    expect(renderPrBody(r, table, 'prices')).toContain("note` mentions 286");
  });

  test('DeepSeek peak change and the OpenAI long-context line', () => {
    const d = check(with_('deepseek-pricing', (s) => s.replace('<td>$1.32</td>', '<td>$1.50</td>')));
    expect(d.rows.find((x) => x.id === 'deepseek-v4-pro')!.diffs).toMatchObject([{ field: 'input', old: 1.32, new: 1.5 }]);
    const o = check(with_('openai-pricing', (s) => s.replace('>272K input tokens', '>300K input tokens')));
    const moved = o.rows.filter((x) => x.diffs.some((d) => d.field === 'longContext.aboveTokens')).map((x) => x.id);
    expect(moved).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5']);
  });

  test('a layout change means an issue and no PR', () => {
    const r = check(with_('anthropic-pricing', (s) => s.replace('Base input tokens', 'Input')));
    expect(r.sources.find((s) => s.id === 'anthropic-pricing')!.ok).toBe(false);
    const claude = r.rows.filter((x) => x.provider === 'anthropic');
    expect(claude.every((x) => x.status === 'unverifiable' && !x.reread)).toBe(true);
    expect(applyUpdates(tableText, r)).toBeUndefined();
    const { desired } = desiredIssues(r);
    expect(desired.map((d) => d.key)).toEqual(['source:anthropic-pricing']);
    expect(desired[0]!.body).toContain('could not be verified automatically');
  });

  test('a retired row is reported, not deleted', () => {
    const r = check(with_('anthropic-pricing', (s) => s.split('\n').filter((l) => !l.startsWith('| Claude Sonnet 5 ')).join('\n')));
    const row = r.rows.find((x) => x.id === 'claude-sonnet-5')!;
    expect(row.status).toBe('missing');
    expect(desiredIssues(r).desired.map((d) => d.key)).toEqual(['row:claude-sonnet-5']);
  });

  test('Google behind sign-in: Gemini rows say "could not verify automatically"', () => {
    const p = pages();
    p['google-pricing'] = new Error('redirected to accounts.google.com (a sign-in wall?)');
    const r = check(p);
    const gem = r.rows.filter((x) => x.provider === 'google');
    expect(gem.map((x) => x.status)).toEqual(['unverifiable', 'unverifiable']);
    expect(gem[0]!.reason).toContain('could not verify automatically');
    const issue = desiredIssues(r).desired.find((d) => d.key === 'source:google-pricing')!;
    expect(issue.body).toContain('gemini-4-argon');
    expect(hasFindings(r)).toBe(true);
    // Every other row was still re-read, but lastReviewed must not move.
    const refreshed = runCheck(p, table, watch, '2026-11-20');
    const next = JSON.parse(applyUpdates(tableText, refreshed)!.text);
    expect(next.lastReviewed).toBe(table.lastReviewed);
    expect(next.models.find((m: any) => m.id === 'gemini-4-argon').seenAt).toBe('2026-10-13');
    expect(next.models.find((m: any) => m.id === 'gpt-5.5').seenAt).toBe('2026-11-20');
  });

  test('a new model in a tracked family opens an issue listing it', () => {
    const r = check(
      with_('anthropic-pricing', (s) =>
        s.replace(/(\| Claude Opus 5\.5 [^\n]*\n)/, '$1| Claude Opus 6 | $6 / MTok | $7.50 / MTok | $12 / MTok | $0.60 / MTok | $30 / MTok |\n'),
      ),
    );
    expect(r.newModels).toEqual([{ provider: 'anthropic', names: ['Claude Opus 6'] }]);
    expect(desiredIssues(r).desired.find((d) => d.key === 'new-models:anthropic')!.body).toContain('- Claude Opus 6');
  });

  test('priceChangesOn arriving opens an issue', () => {
    const r = check(pages(), '2026-12-01');
    expect(r.changeDates).toEqual([{ id: 'gemini-4-argon', date: '2026-12-01' }]);
    // On that day the page's rate in force is the new one, so a PR follows too.
    expect(r.rows.find((x) => x.id === 'gemini-4-argon')!.diffs.map((d) => [d.field, d.new])).toEqual([
      ['input', 4],
      ['output', 20],
      ['cacheRead', 0.2],
    ]);
    expect(desiredIssues(r).desired.map((d) => d.key)).toContain('change-date:gemini-4-argon');
  });

  test('a moved or cancelled announced change is reported', () => {
    const moved = check(
      with_('google-pricing', (s) =>
        s.replaceAll('through November 30, 2026', 'through December 31, 2026').replaceAll('starting December 1, 2026', 'starting January 1, 2027'),
      ),
    );
    expect(moved.rows.find((x) => x.id === 'gemini-4-argon')!.schedule[0]).toContain('2027-01-01; the row says 2026-12-01');
    const cancelled = check(
      with_('google-pricing', (s) => s.replace(/<h2 id="gemini-4-argon"[\s\S]*?<h2 id="gemini-3\.8-flash"/, (sec) => sec.replace(/\$([\d.]+) through November 30, 2026\.<br>\$[\d.]+ starting December 1, 2026\./g, '$$$1'))),
    );
    expect(cancelled.rows.find((x) => x.id === 'gemini-4-argon')!.schedule[0]).toContain('no longer announces a change');
  });

  test('after 30 quiet days a refresh PR re-dates the rows', () => {
    expect(applyUpdates(tableText, check(pages(), '2026-11-11'))).toBeUndefined();
    const up = applyUpdates(tableText, check(pages(), '2026-11-12'))!;
    expect(up.kind).toBe('refresh');
    expect(JSON.parse(up.text).lastReviewed).toBe('2026-11-12');
  });
});

describe('GitHub', () => {
  test('issues are deduplicated by key, and closed only when this run looked', () => {
    const existing = [
      { number: 1, title: 'x', body: '<!-- price-check-key: row:claude-sonnet-5 -->' },
      { number: 2, title: 'y', body: '<!-- price-check-key: row:gemini-4-argon -->' },
      { number: 3, title: 'z', body: 'unrelated, no key' },
    ];
    const p = pages();
    p['google-pricing'] = new Error('down');
    const r = check(p);
    const { desired, judged } = desiredIssues(r);
    const plan = planIssues(existing, desired, judged);
    expect(plan.close.map((c) => c.number)).toEqual([1]); // sonnet re-read and fine; gemini not looked at today
    expect(plan.create.map((c) => c.key)).toEqual(['source:google-pricing']);
  });

  test('end to end: branch pushed, PR opened, refused PR becomes an issue', async () => {
    // A local bare remote and a fake REST API, so the real git and HTTP paths run.
    const dir = mkdtempSync(join(tmpdir(), 'tc-gh-'));
    const sh = (cwd: string, ...a: string[]) => {
      const x = spawnSync('git', a, { cwd, encoding: 'utf8' });
      if (x.status !== 0) throw new Error(x.stderr);
      return x.stdout;
    };
    sh(dir, 'init', '--bare', '-b', 'main', 'remote.git');
    const work = join(dir, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    cpSync(TABLE_PATH, join(work, 'src/pricing.json'));
    sh(work, 'init', '-b', 'main');
    sh(work, 'remote', 'add', 'origin', join(dir, 'remote.git'));
    sh(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    sh(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
    sh(work, 'push', 'origin', 'main');

    const calls: string[] = [];
    let refusePr = false;
    const issues: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const key = `${req.method} ${u.pathname}`;
        calls.push(key);
        const body = req.method === 'GET' ? undefined : await req.json();
        if (key.endsWith('/labels/price-check')) return Response.json({ name: 'price-check' });
        if (key === 'GET /repos/o/r/pulls') return Response.json([]);
        if (key === 'POST /repos/o/r/pulls') {
          if (refusePr) return Response.json({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }, { status: 403 });
          return Response.json({ number: 9, html_url: 'https://github.com/o/r/pull/9' });
        }
        if (key === 'GET /repos/o/r/issues') return Response.json(issues);
        if (key === 'POST /repos/o/r/issues') {
          issues.push({ number: issues.length + 10, ...body });
          return Response.json({ number: issues.length + 9 });
        }
        return Response.json({});
      },
    });
    try {
      const gh = new GitHub('token', 'o/r', `http://localhost:${server.port}`);
      const r = check(with_('deepseek-pricing', (s) => s.replace('<td>$1.32</td>', '<td>$1.50</td>')));
      const update = applyUpdates(tableText, r)!;
      const res = await syncGitHub({ report: r, table, update, cwd: work, gh, runUrl: 'RUN' });
      expect(res.pr).toBe('https://github.com/o/r/pull/9');
      const pushed = JSON.parse(sh(join(dir, 'remote.git'), 'show', 'price-check/update:src/pricing.json'));
      expect(pushed.models.find((m: any) => m.id === 'deepseek-v4-pro').input.value).toBe(1.5);
      expect(sh(join(dir, 'remote.git'), 'rev-parse', 'main')).toBe(sh(work, 'rev-parse', 'main')); // main untouched
      expect(calls).not.toContain('PUT /repos/o/r/pulls/9/merge');

      refusePr = true;
      const res2 = await syncGitHub({ report: r, table, update, cwd: work, gh, runUrl: 'RUN' });
      expect(res2.pr).toBeUndefined();
      const blocked = issues.find((i) => i.body.includes('price-check-key: pr-blocked'));
      expect(blocked.body).toContain('compare/main...price-check/update');
      expect(blocked.body).toContain('**input**: 1.32 → **1.5**');
    } finally {
      server.stop(true);
    }
  });
});

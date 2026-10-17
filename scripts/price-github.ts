/**
 * Turn a price-check Report into GitHub state: one PR for number changes, one
 * issue per thing a human has to look at. Uses only the workflow's
 * GITHUB_TOKEN. Never merges anything.
 *
 * Issues carry a hidden key (`<!-- price-check-key: ... -->`) so a daily run
 * updates the same issue instead of opening a new one, and closes it when the
 * finding goes away — but only when this run actually looked (a source that
 * failed to load does not close the issues about its rows).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Report, type Table, type UpdateKind, PROVIDERS, renderPrBody } from './check-prices.ts';

export const LABEL = 'price-check';
export const BRANCH = 'price-check/update';
const KEY_RE = /<!-- price-check-key: (.+?) -->/;

export interface Issue {
  number: number;
  title: string;
  body: string;
}

export interface DesiredIssue {
  key: string;
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

function withKey(key: string, lines: string[], runUrl?: string, today?: string): string {
  return [...lines, '', `Last confirmed by the daily price check on ${today}${runUrl ? ` — ${runUrl}` : ''}.`, '', `<!-- price-check-key: ${key} -->`].join('\n');
}

/** What issues should be open after this run, and which keys this run was able to judge. */
export function desiredIssues(report: Report, runUrl?: string): { desired: DesiredIssue[]; judged: Set<string> } {
  const desired: DesiredIssue[] = [];
  const judged = new Set<string>();
  const d = (key: string, title: string, lines: string[]) =>
    desired.push({ key, title, body: withKey(key, lines, runUrl, report.today) });

  for (const s of report.sources) {
    const key = `source:${s.id}`;
    judged.add(key);
    if (s.ok) continue;
    const affected = report.rows.filter(
      (r) => r.provider && PROVIDERS[r.provider].pages.includes(s.id) && r.status === 'unverifiable',
    );
    d(key, `Price check could not read ${s.url}`, [
      `The daily price check could not use ${s.url}:`,
      '',
      `> ${s.error}`,
      '',
      'Nothing was guessed. These rows **could not be verified automatically** today and keep their current numbers and dates:',
      '',
      ...affected.map((r) => `- \`${r.id}\` (${r.label})`),
      '',
      'If the page changed shape, refresh the fixture (`bun scripts/check-prices.ts --save-fixtures`), fix the parser until `bun test` passes, and re-read the rows by hand meanwhile.',
    ]);
  }

  for (const r of report.rows) {
    const key = `row:${r.id}`;
    const sourceFailure = r.status === 'unverifiable' && r.provider && !report.readProviders.includes(r.provider);
    if (sourceFailure) continue; // reported on the source issue; not judged today
    judged.add(key);
    const lines: string[] = [];
    if (r.status === 'missing') lines.push(`- **Row not found**: ${r.reason}. The row was left alone.`);
    if (r.status === 'unverifiable') lines.push(`- **Could not verify automatically**: ${r.reason}.`);
    for (const p of r.problems) lines.push(`- **Could not read**: ${p}`);
    for (const p of r.presence) {
      lines.push(
        p.vendor
          ? `- **${p.field}**: the vendor now lists ${p.vendor.value}; the table has none.\n  > \`${p.vendor.quote}\``
          : `- **${p.field}**: the table has ${p.table}; the vendor page lists none.`,
      );
    }
    for (const s of r.schedule) lines.push(`- **Announced change**: ${s}`);
    if (!lines.length) continue;
    d(key, `Price check: ${r.id} needs a human`, [
      `The daily price check found something about \`${r.id}\` it will not change on its own:`,
      '',
      ...lines,
    ]);
  }

  for (const p of Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]) {
    const key = `new-models:${p}`;
    if (!report.readProviders.includes(p)) continue;
    judged.add(key);
    const n = report.newModels.find((x) => x.provider === p);
    if (!n) continue;
    d(key, `Price check: new ${p} models listed`, [
      `${PROVIDERS[p].cites} lists model(s) in a family the table already covers, which are not in \`src/pricing.json\`:`,
      '',
      ...n.names.map((x) => `- ${x}`),
      '',
      'Add a row (with sourceUrl and seenAt), or add the name to `known` in `scripts/price-watch.json` (`bun scripts/check-prices.ts --acknowledge` does that for everything listed) to close this.',
    ]);
  }

  for (const r of report.rows) judged.add(`change-date:${r.id}`);
  for (const c of report.changeDates) {
    d(`change-date:${c.id}`, `Price check: ${c.id} priceChangesOn ${c.date} has arrived`, [
      `\`${c.id}\` carries \`priceChangesOn: ${c.date}\`, and that day has come. The CLI now warns that the figure uses the earlier rates.`,
      '',
      'Re-read the vendor page, update the rates and the note, and remove `priceChangesOn` (or move it, if the vendor moved the date).',
    ]);
  }
  return { desired, judged };
}

export interface IssuePlan {
  create: DesiredIssue[];
  update: { number: number; title: string; body: string }[];
  close: { number: number; key: string }[];
}

export function planIssues(existing: Issue[], desired: DesiredIssue[], judged: Set<string>): IssuePlan {
  const byKey = new Map<string, Issue>();
  for (const i of existing) {
    const k = KEY_RE.exec(i.body ?? '')?.[1];
    if (k && !byKey.has(k)) byKey.set(k, i);
  }
  const plan: IssuePlan = { create: [], update: [], close: [] };
  const want = new Set(desired.map((x) => x.key));
  for (const x of desired) {
    const cur = byKey.get(x.key);
    if (!cur) plan.create.push(x);
    else if (cur.body !== x.body || cur.title !== x.title) plan.update.push({ number: cur.number, title: x.title, body: x.body });
  }
  for (const [key, i] of byKey) {
    if (!want.has(key) && judged.has(key)) plan.close.push({ number: i.number, key });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// GitHub REST
// ---------------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GitHub {
  constructor(
    private token: string,
    public repo: string,
    private api = 'https://api.github.com',
  ) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'tokencost-price-check',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ensureLabel() {
    try {
      await this.req('GET', `/repos/${this.repo}/labels/${LABEL}`);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      await this.req('POST', `/repos/${this.repo}/labels`, {
        name: LABEL,
        color: 'd4c5f9',
        description: 'Opened by the daily vendor price check',
      });
    }
  }

  async openIssues(): Promise<Issue[]> {
    const out: Issue[] = [];
    for (let page = 1; page < 20; page++) {
      const batch = await this.req<any[]>('GET', `/repos/${this.repo}/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
      out.push(...batch.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? '' })));
      if (batch.length < 100) break;
    }
    return out;
  }

  createIssue(title: string, body: string) {
    return this.req<{ number: number }>('POST', `/repos/${this.repo}/issues`, { title, body, labels: [LABEL] });
  }
  updateIssue(n: number, patch: Record<string, unknown>) {
    return this.req('PATCH', `/repos/${this.repo}/issues/${n}`, patch);
  }
  comment(n: number, body: string) {
    return this.req('POST', `/repos/${this.repo}/issues/${n}/comments`, { body });
  }
  async openPr(): Promise<{ number: number; html_url: string } | undefined> {
    const owner = this.repo.split('/')[0];
    const prs = await this.req<any[]>('GET', `/repos/${this.repo}/pulls?state=open&head=${owner}:${BRANCH}`);
    return prs[0];
  }
  createPr(title: string, body: string, base: string) {
    return this.req<{ number: number; html_url: string }>('POST', `/repos/${this.repo}/pulls`, { title, body, head: BRANCH, base });
  }
  updatePr(n: number, patch: Record<string, unknown>) {
    return this.req('PATCH', `/repos/${this.repo}/pulls/${n}`, patch);
  }
}

// ---------------------------------------------------------------------------
// git (the bot branch only; main is never written)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.status === 0 ? r.stdout : '';
}

/** Commit the proposed table to BRANCH and push it. Returns false when the branch already holds it. */
export function pushBranch(cwd: string, text: string, message: string): boolean {
  git(cwd, ['config', 'user.name', 'github-actions[bot]']);
  git(cwd, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const remote = git(cwd, ['ls-remote', '--heads', 'origin', BRANCH]).trim();
  if (remote) {
    git(cwd, ['fetch', '--depth=1', 'origin', BRANCH]);
    const onBranch = git(cwd, ['show', 'FETCH_HEAD:src/pricing.json'], true);
    if (onBranch === text) return false;
  }
  git(cwd, ['switch', '-C', BRANCH]);
  writeFileSync(join(cwd, 'src/pricing.json'), text);
  git(cwd, ['add', 'src/pricing.json']);
  git(cwd, ['commit', '-m', message]);
  // The bot branch is rebuilt from main on every change, so it is replaced,
  // never merged into. main itself is never pushed.
  git(cwd, ['push', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  return true;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncInput {
  report: Report;
  table: Table;
  update?: { text: string; kind: UpdateKind };
  cwd: string;
  gh?: GitHub;
  runUrl?: string;
  base?: string;
}

export async function syncGitHub(input: SyncInput): Promise<{ plan: IssuePlan; pr?: string }> {
  const env = process.env;
  const gh =
    input.gh ??
    new GitHub(
      env.GITHUB_TOKEN ?? (() => { throw new Error('GITHUB_TOKEN is not set'); })(),
      env.GITHUB_REPOSITORY ?? (() => { throw new Error('GITHUB_REPOSITORY is not set'); })(),
      env.GITHUB_API_URL,
    );
  const runUrl =
    input.runUrl ??
    (env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${gh.repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined);
  const base = input.base ?? 'main';
  const { report, table, update } = input;

  await gh.ensureLabel();
  const { desired, judged } = desiredIssues(report, runUrl);
  let prUrl: string | undefined;

  // The PR first, because a refused PR becomes an issue.
  const blockedKey = 'pr-blocked';
  const open = await gh.openPr();
  if (update) {
    const title =
      update.kind === 'prices'
        ? `fix(pricing): vendor price change found ${report.today}`
        : `chore(pricing): re-verified against vendor pages ${report.today}`;
    const body = renderPrBody(report, table, update.kind, runUrl);
    pushBranch(input.cwd, update.text, title);
    try {
      if (open) {
        await gh.updatePr(open.number, { title, body });
        prUrl = open.html_url;
      } else {
        prUrl = (await gh.createPr(title, body, base)).html_url;
      }
      judged.add(blockedKey);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 403) throw e;
      // "GitHub Actions is not permitted to create or approve pull requests":
      // a repository setting. The branch is pushed; hand the human the link.
      desired.push({
        key: blockedKey,
        title: 'Price check: a price PR could not be opened',
        body: withKey(
          blockedKey,
          [
            `The price check pushed \`${BRANCH}\` but GitHub refused to open the pull request:`,
            '',
            `> ${e.message}`,
            '',
            'Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**, or open it by hand:',
            `https://github.com/${gh.repo}/compare/${base}...${BRANCH}?expand=1`,
            '',
            '---',
            '',
            body,
          ],
          runUrl,
          report.today,
        ),
      });
      judged.add(blockedKey);
    }
  } else {
    judged.add(blockedKey);
    if (open) {
      await gh.comment(open.number, `The ${report.today} price check found the table matches the vendor pages, so this PR is no longer needed.${runUrl ? ` ${runUrl}` : ''}`);
      await gh.updatePr(open.number, { state: 'closed' });
    }
  }

  const plan = planIssues(await gh.openIssues(), desired, judged);
  for (const x of plan.create) await gh.createIssue(x.title, x.body);
  for (const x of plan.update) await gh.updateIssue(x.number, { title: x.title, body: x.body });
  for (const x of plan.close) {
    await gh.comment(x.number, `No longer reported by the ${report.today} price check.${runUrl ? ` ${runUrl}` : ''}`);
    await gh.updateIssue(x.number, { state: 'closed', state_reason: 'completed' });
  }
  console.log(
    `GitHub: PR ${prUrl ?? (update ? 'blocked' : 'none needed')}; issues +${plan.create.length} ~${plan.update.length} -${plan.close.length}`,
  );
  return { plan, pr: prUrl };
}


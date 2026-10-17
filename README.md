# @antharmaya/tokencost

**Price a whole agent run, not one request.**

Every public LLM cost calculator checked in August 2026 prices a single
message: you give it a token count, it multiplies by a rate. That misses where
the money actually goes.

An agent's transcript is resent on **every turn** — the system prompt again,
every prior message again, every reply the model already wrote, again — because
the API is stateless and the conversation lives in your request. Twenty turns of
a coding agent on Claude Opus sends **124,280 input tokens**, starting from a
first request of 115. Nothing grew. It just kept resending.

```
turn  1     115 tokens
turn 20  12,313 tokens
```

Multiply the first number by twenty and you are wrong by more than double.

[**Try it in a browser →**](https://antharmaya.com/tools/token-cost) · no install, nothing uploaded

---

## What it models that others don't

| | |
|---|---|
| **Context regrowth** | the transcript resent each turn, so cost bends |
| **Minimum cacheable prefix** | below it there is no cache, no write, and **no error** |
| **Cache write premium** | 1.25× input for 5-minute, 2× for 1-hour |
| **Cache TTL expiry** | wall clock, not compute — a slow agent never collects a read |
| **Long-context rates** | past a prompt-length line the whole request is re-priced: 5× on Claude Haiku 5.5, about 2× on GPT-5.5 and GPT-6 |
| **Tool definitions** | resent every turn, plus the vendor's own tool-use system prompt |
| **Thinking tokens** | billed at the output rate, and they do *not* compound |
| **Tool-change invalidation** | editing the tools array wipes tools, system *and* messages |
| **ChatML overhead** | ~4 tokens/message + 2 priming, which nothing else counts |
| **Dated provenance** | every price carries the URL it came from and the day a human read it |

## Install

```bash
npm i @antharmaya/tokencost
# optional: exact BPE counts for models with a public tokenizer
npm i gpt-tokenizer
```

## Use

```ts
import {
  compareCaching,
  staticPricing,
  tokenizerForModel,
  formatUsd,
} from "@antharmaya/tokencost";

const price = staticPricing.priceFor("claude-opus-5-5")!;
// Exact for models with a public tokenizer; otherwise the higher of two
// estimates plus the vendor's documented correction.
const tokenizer = await tokenizerForModel(price);

const result = compareCaching(
  {
    modelId: price.id,
    turns: [
      { role: "system", content: "You are an autonomous coding agent…" },
      { role: "user", content: "The checkout flow throws a 500…" },
    ],
    turnCount: 20,
    outputTokensPerTurn: 600,
    reasoningTokensPerTurn: 0,
    toolDefinitionTokens: 0,
    cacheEnabled: true,
    toolsChangeEachTurn: false,
    cacheTtl: "5m",
    secondsBetweenTurns: 5,
    batchEnabled: false,
  },
  price,
  tokenizer,
);

formatUsd(result.uncached.totalCostUsd); // "$0.7131"
formatUsd(result.cached.totalCostUsd);   // "$0.3204"
result.multiple.toFixed(2);              // "2.23"
```

Those are the numbers this exact snippet prints with `gpt-tokenizer` installed
and the prompts truncated as shown. The figures quoted elsewhere in this README
use the full coding-agent prompt, which is longer, on Claude Opus 5.5 at the
prices read on 2026-10-13. Paste the snippet and you should get what the
comments say; if you don't, that is a bug worth reporting.

## Four findings this produced

**Your cache does not exist until the prompt is long enough.** Anthropic will
not cache a prefix below a per-model minimum, and the thresholds are not
monotonic: 512 on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, 1,024 on Opus
4.8 and Sonnet 5, 2,048 on Opus 4.7, 4,096 on Opus 4.6. Switching models can
silently change whether your prompt caches at all: this run caches from its
second turn on Opus 5.5 and from its third on Opus 4.8. Under the threshold the
request is processed uncached — no hit, no write, no premium, and no error. It
returns 200 and caches nothing.

**Caching can lose money forever.** A cache entry expires on wall clock. If the
gap between turns outlives the TTL, every turn pays the write premium and
collects nothing, at any turn count. That is what a human-in-the-loop agent
looks like, not an edge case.

**Thinking tokens dominate everything else.** Billed at the output rate, and
measured traces show 2–8× more thinking than visible output. At the top of that
range a run costs **6.92×** what a model ignoring it would report — larger than
the multi-turn curve itself.

**Changing your tools zeroes the cache.** The prefix is ordered
`tools → system → messages`, and editing the tools array invalidates all three.
An agent that swaps tools per turn gets zero cache hits: on a 20-turn run with
3,286 tokens of tools that is **3.37×** the frozen-tools cost, and **1.19×**
what you would pay with caching switched off entirely. Turning the cache on
makes it worse. Changing `tool_choice` instead invalidates only the messages, so
declare the full set once and steer with that.

## Audit a real run

The webpage prices a hypothetical. The CLI reads what actually happened.

```bash
npx @antharmaya/tokencost run.jsonl
cat session.json | npx @antharmaya/tokencost --json
```

```
  5 turns · claude-opus-5-5
  22,370 input · 3,000 output · 6,840 from cache
  ~$0.1390 at Claude Opus 5.5 list prices
  prices read 2026-10-13 · https://platform.claude.com/docs/en/about-claude/pricing

  MEASURED — these are facts from your log
  ✗ Tool definitions changed (turn 4)
      Tools hash went 7e267eb19128 → cd3e8a485e6d. The cached prefix is
      ordered tools → system → messages, so this invalidated all three…
  ! Gap exceeded the cache TTL (turn 5)
      730s between turn 4 and 5, past the 300s lifetime…
  · Achieved cache hit rate: 30.6%
      6,840 of 22,370 input tokens were cache reads.
```

That is the real output for [`examples/run.jsonl`](https://github.com/antharmaya/tokencost/blob/main/examples/run.jsonl),
trimmed where the `…` is.

The two vendor families report the same quantities in opposite shapes, and the
CLI normalises them. Anthropic and Bedrock split a prompt into three counters
that do not overlap: `input_tokens` is only what was neither read from nor
written to the cache, so the prompt is the sum of all three. OpenAI reports the
total and breaks the cached part out under `input_tokens_details` or
`prompt_tokens_details`. "Input" above always means the whole prompt, and the
cost bills fresh, read and written tokens each at their own rate.

Findings are split into **measured** and **inferred**, and the split is load
bearing. Where a log carries the cache counters, the hit rate is a fact. Where
it carries only a prompt total, the same number would be a guess — and the CLI
says so rather than printing one. A tool that shows a guess in the same typeface
as a measurement is worse than one that stays quiet.

Exits `1` when a measured critical finding is present, so it works in CI.

Accepts JSONL or a JSON array; records may be raw provider requests or
`{ request, response, timestamp }` wrappers. Tool arrays are compared on a
canonicalised form, so a JSON serialiser reordering keys is reported as the
serialisation bug it is rather than as a deliberate tool change.

## Honest limits

- **Full transcript resend is an assumption, not a universal.** It is the
  default in the OpenAI Agents SDK and unconfigured LangChain. CrewAI
  (`respect_context_window=True`) and LlamaIndex compact by default, and the
  orchestrator+subagent pattern returns summaries. Treat the curve as a ceiling.
- **Anthropic, Google and DeepSeek publish no offline tokenizer.** Those models
  are counted with the larger of two credible estimators, then corrected by
  Anthropic's own documented ~30% uplift for Claude Opus 4.7 and later. The
  GPT-6 models are counted with `o200k_base` because OpenAI's model pages do
  not name their tokenizer. All of these are marked `approximate`, never
  silently. `tokenizerForModel(price)` applies this policy for you.
- **Some cache minimums are absent, not zero.** Google and DeepSeek publish
  none, and OpenAI says the minimum for GPT-5.5 and earlier varies by request
  settings. An invented threshold would silently change every short-prompt
  result while being indistinguishable from a correct one, so those rows carry
  none.
- **DeepSeek is stored at its peak rate.** Off-peak is half. The peak rate is
  the one kept so that an estimate lands over the invoice, not under it.
- **Not modelled yet:** vision/audio tokens, server-side tool charges (web
  search is billed per call), Gemini's per-hour cache storage fee, Anthropic's
  fast mode and US-only inference multiplier, and Anthropic's 20-block cache
  lookback window — a single-breakpoint agent exhausts it after roughly ten
  turns and then misses on a prefix that is still byte-identical, just out of
  range. When pricing a real log, cache writes are billed at the short-lifetime
  rate, because a log does not reliably say which lifetime was bought.

## Prices go stale — that is the point of the dates

Every record carries `sourceUrl` and `seenAt`, the day a person read the vendor
page. The table in this version was read on **2026-10-13** and covers 15 models
from Anthropic, OpenAI, Google and DeepSeek.

Prices move in both directions, and announced changes do not always happen.
Anthropic scheduled Sonnet 5 to rise from $2/$10 to $3/$15 on 2026-09-01 and
then cancelled it; an earlier version of this table carried a note saying the
row was about to become wrong, and it was the note that was wrong. So a row with
an announced change carries `priceChangesOn` (Gemini 4 Argon on 2026-12-01,
Gemini 3.8 Flash on 2027-01-01), and from that date the CLI says the figure uses
the earlier rates instead of quietly printing them. A test asserts every price
has provenance.

### How the table stays current

1. **Daily check.** A GitHub Actions job (`.github/workflows/price-check.yml`)
   re-reads every page the table cites: Anthropic's pricing and prompt-caching
   pages, OpenAI's pricing page, DeepSeek's pricing page and Google's Gemini
   pricing page. For every row it extracts the rates, the long-context line,
   the batch multiplier, the cache minimum and the tool-use system prompt,
   wherever the vendor publishes them. Then it compares them with
   `src/pricing.json`.
2. **PR for a changed number.** If a number differs, the job opens a pull
   request, or updates the open one. The PR shows old → new and quotes the
   vendor's own line. It moves `seenAt` only for the rows it re-read in full,
   and moves `lastReviewed` only when every row was re-read.
3. **Issue for everything else.** These never become a PR: a page that would
   not load (Google sends browser-like clients to a sign-in page, so its rows
   then say *could not verify automatically*), a row that is no longer on the
   page, a cell it cannot read, a new model in a family the table already
   covers, and a `priceChangesOn` date that has arrived. The issue closes
   itself once a later run sees the problem gone.
4. **A person merges.** Nothing is merged automatically. Check the quoted
   line against the page and merge.
5. **Release.** Pushing a `v*` tag that matches `package.json` publishes to
   npm with provenance (`.github/workflows/release.yml`). A merged price
   change reaches users only after a release.

On a quiet day the job commits nothing. After 30 quiet days it opens a PR
that only moves the dates. That keeps `lastReviewed` tracking the last real
check, not the last price change.

**If the loop stops, you will see it.** When the bundled table's
`lastReviewed` is more than 45 days old, the CLI prints a warning on every
run, and `--json` reports `priceTable.stale: true`. The cases are an old
install, an unmerged PR, or a dead job. GitHub disables scheduled workflows
in a repository with no activity for 60 days. The 30-day re-dating PR is
meant to prevent that, but only if someone merges it. If the job has been
disabled, re-enable it under Actions → Price check.

Each parser is tested against a saved copy of its page in `test/fixtures/`.
When a vendor changes its layout, the parser reports an error rather than
picking the nearest number. To refresh the copies:
`bun scripts/check-prices.ts --save-fixtures`, then `bun test`. To check the
live pages by hand: `bun run check-prices`.

**Found a stale rate? A PR updating `src/pricing.json` is the most useful thing
you can send.** Include the vendor URL and the date you read it — a price
without both will not be merged.

## Tests

```bash
bun test    # 100 tests
```

They assert behaviour, not implementation: that input rises every turn, that
doubling turns more than doubles input, that a flat per-request model understates
a 20-turn agent by more than 2×, that thinking never joins the transcript, that
a run crossing a long-context line is re-priced from that turn, that no
shipped price is missing its source, and that the price-check parsers read
the saved vendor pages to the same numbers the table carries.

## License

MIT

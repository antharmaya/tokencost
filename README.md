# @antharmaya/tokencost

**Price a whole agent run, not one request.**

Every public LLM cost calculator I could find in August 2026 prices a single
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
  guardrailTokenizer,
  formatUsd,
} from "@antharmaya/tokencost";

const price = staticPricing.priceFor("claude-opus-4-8")!;

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
  guardrailTokenizer,
);

formatUsd(result.uncached.totalCostUsd); // "$0.8879"
formatUsd(result.cached.totalCostUsd);   // "$0.4293"
result.multiple;                          // 2.07
```

Those are the numbers this exact snippet prints, with the prompts truncated as
shown. The figures quoted elsewhere in this README use the full coding-agent
prompt, which is longer — paste the snippet and you should get what the comments
say, or one of us has a bug.

## Four findings this produced

**Your cache does not exist for the first two turns.** Anthropic will not cache
a prefix below a per-model minimum, and the thresholds are not monotonic: 512 on
Opus 5, 1,024 on Opus 4.8 and Sonnet 5, 2,048 on Opus 4.7, 4,096 on Opus 4.6.
Upgrading a model can silently change whether your prompt caches at all. Under
the threshold the request is processed uncached — no hit, no write, no premium,
and no error. It returns 200 and caches nothing.

**Caching can lose money forever.** A cache entry expires on wall clock. If the
gap between turns outlives the TTL, every turn pays the write premium and
collects nothing, at any turn count. That is what a human-in-the-loop agent
looks like, not an edge case.

**Thinking tokens dominate everything else.** Billed at the output rate, and
measured traces show 2–8× more thinking than visible output. At the top of that
range a run costs **6.49×** what a model ignoring it would report — larger than
the multi-turn curve itself.

**Changing your tools zeroes the cache.** The prefix is ordered
`tools → system → messages`, and editing the tools array invalidates all three.
An agent that swaps tools per turn gets zero cache hits: on a 20-turn run with
3,290 tokens of tools that is **3.07×** the frozen-tools cost, and **1.19×**
what you would pay with caching switched off entirely. Turning the cache on
makes it worse. Changing `tool_choice` instead invalidates only the messages, so
declare the full set once and steer with that.

## Honest limits

- **Full transcript resend is an assumption, not a universal.** It is the
  default in the OpenAI Agents SDK and unconfigured LangChain. CrewAI
  (`respect_context_window=True`) and LlamaIndex compact by default, and the
  orchestrator+subagent pattern returns summaries. Treat the curve as a ceiling.
- **Anthropic, Google and DeepSeek publish no browser tokenizer.** Those models
  are counted with the larger of two credible estimators, then corrected by
  Anthropic's own documented ~30% uplift for Claude 4.7+. Marked `approximate`,
  never silently.
- **Gemini and DeepSeek cache minimums are absent, not zero.** No source I
  verified publishes them, and an invented threshold would silently change every
  short-prompt result while being indistinguishable from a correct one.
- **Not modelled yet:** vision/audio tokens, server-side tool charges (web
  search is billed per call), long-context pricing tiers, and Anthropic's
  20-block cache lookback window — a single-breakpoint agent exhausts it after
  roughly ten turns and then misses on a prefix that is still byte-identical,
  just out of range.

## Prices go stale — that is the point of the dates

Every record carries `sourceUrl` and `seenAt`. Prices do **not** only move
downward: Anthropic's Sonnet 5 introductory rate ends 2026-08-31 and the row is
scheduled to become wrong. A test asserts every price has provenance.

**Found a stale rate? A PR updating `src/pricing.json` is the most useful thing
you can send.** Include the vendor URL and the date you read it — a price
without both will not be merged.

## Tests

```bash
bun test    # 50 tests
```

They assert behaviour, not implementation: that input rises every turn, that
doubling turns more than doubles input, that a flat per-request model understates
a 20-turn agent by more than 2×, that thinking never joins the transcript, and
that no shipped price is missing its source.

## License

MIT

# Changelog

All notable changes to `@antharmaya/tokencost`. Dates are UTC.

## [Unreleased]

## [0.1.1] — not yet tagged

### Added

- The CLI warns when the bundled price table's `lastReviewed` is more than 45
  days old, and `--json` output carries
  `priceTable: { lastReviewed, ageDays, stale }`. `STALE_AFTER_DAYS` and
  `tableAgeDays()` are exported.
- A daily GitHub Actions price check (`.github/workflows/price-check.yml`,
  `scripts/check-prices.ts`). It re-reads every vendor page the table cites
  and opens a PR when a number differs, quoting the vendor's own line. When a
  page or a row cannot be read, it opens an issue instead. Parser tests run
  against saved copies of each page in `test/fixtures/`.
- Release automation (`.github/workflows/release.yml`): publishes to npm with
  trusted publishing and provenance when a `v*` tag matching `package.json` is
  pushed.

- `billRun(transcript, priceFor, override?)` prices each turn at its own
  model and returns per-model subtotals; `cacheTtlSeconds(transcript, price?)`,
  `lookupPrice`, `normaliseModelId` and `MODEL_ALIASES` are exported.
  `ModelPrice.exactMatchOnly` keeps a row out of normalised matching.

### Fixed

Each was confirmed against 0.1.0 by a review on 2026-10-17 and has a test.

- Anthropic 1-hour cache writes were billed at the 5-minute rate. The parser
  now reads `usage.cache_creation.ephemeral_1h_input_tokens` and
  `ephemeral_5m_input_tokens` and bills each at its own rate. A turn with 1,000
  fresh, 1,000 5-minute and 2,000 1-hour tokens on Claude Opus 5.5 was $0.0190
  and is now $0.0250.
- DeepSeek's native `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
  were ignored, so cache hits were billed as fresh input. 100,000 prompt
  tokens at 90% hits plus 1,000 output on DeepSeek Flash was $0.0312 and is
  now $0.00474 (6.6x over; 8.5x with no output).
- Gemini `usageMetadata` was not parsed, so Gemini logs showed no tokens and
  no cost. `promptTokenCount`, `toolUsePromptTokenCount`,
  `cachedContentTokenCount`, `candidatesTokenCount` and `thoughtsTokenCount`
  are now read; thoughts bill at the output rate. The model is also read from
  the response's `modelVersion`.
- `priceFor` matched exact ids only, so dated snapshots, Bedrock and Vertex
  ids, provider-prefixed ids and `deepseek-v4-flash` got no price. Ids are now
  normalised after an exact match fails.
- Mixed-model logs were priced entirely at the first turn's model. Each turn
  is now priced at its own; `--json` adds `byModel` and `unpricedTurns`;
  `--model` overrides every turn.
- The gap finding always used a 300s TTL. It now uses the model's
  `cacheLifetimeSeconds` when set, and 3600s when the log shows 1-hour writes.
- The hit rate could exceed 100% (a turn with cache reads but no prompt total
  printed "50000.0%"). It is now computed only over turns that report a prompt
  total, and capped at 100%.
- The CLI printed ANSI colours when stdout was not a terminal. It now respects
  `isatty` and `NO_COLOR`.
- `src/tokenizer.ts` cited a stale repository path.

### Changed

- The `gpt-tokenizer` peer range is widened to `^3.0.0 || ^4.0.0`. The test
  suite passes on 4.0.0, which the dev dependency now uses.
- `src/pricing.json` is now stored in canonical `JSON.stringify` form. Four
  `1.0`/`2.0` literals became `1`/`2`; no value changed.
- CI uses `actions/checkout@v7`.

## [0.1.0] — 2026-10-13

First published release (`3b2fdb2`).

- Prices a conversation, not a single request. It models the transcript being
  resent on every turn, prompt-cache write premiums and TTL expiry, the
  minimum cacheable prefix, tool definitions resent each turn, the vendor
  tool-use system prompt, and thinking tokens billed at the output rate
  without compounding.
- Anthropic's documented tool-change invalidation: editing the tools array
  wipes the tools, system and messages caches.
- Long-context rates: past a prompt-length line, the whole request is
  re-priced.
- The `tokencost` CLI audits a real transcript (JSONL or JSON; Anthropic,
  Bedrock and OpenAI usage shapes). It splits findings into measured and
  inferred, and exits 1 on a measured critical finding.
- Every price has `sourceUrl` and `seenAt`, and `priceChangesOn` marks
  announced changes. The table was re-read from every vendor page on
  2026-10-13 and covers 15 models from Anthropic, OpenAI, Google and DeepSeek.
- Exact BPE counts through the optional `gpt-tokenizer` peer. Other models use
  a conservative estimate plus Anthropic's documented ~30% tokenizer uplift,
  and those counts are marked approximate.
- Fixed in development: the Opus 4.8 cache minimum (1,024, not 2,048).

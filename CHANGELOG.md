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

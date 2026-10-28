# Benchmark Guide

This document describes the benchmark suite under `bench/`.

## Purpose

The suite measures the runtime cost of the folder-priority / link-rank code
paths against a deterministic, large mock vault (14 000 markdown files). It is
used to keep suggestions inside the frame budget (≈16.7 ms at 60 fps) and to
catch regressions, especially the kind that makes a per-save or per-keystroke
operation scale with vault size instead of with the matched candidate count.

## Running

```sh
pnpm benchmark            # full run: 21 iterations per scenario
pnpm benchmark -- --quick # smoke run: 7 iterations per scenario (~1/3 runtime)
pnpm benchmark:bundle     # build only, no run
```

- `--quick` sets `BENCH_N=7` for the child process.
- `BENCH_N=<n> node bench/run.mjs` overrides the iteration count directly; an
  explicit `BENCH_N` always wins over `--quick`.
- Results are written to `bench/results/latest.json` and `bench/results/latest.md`
  (both gitignored) and echoed to stdout.

Under the hood `bench/run.mjs` bundles `bench/main.ts` with esbuild, aliasing
`obsidian` to `bench/obsidian-stub.ts`, and runs the bundle with
`node --expose-gc`.

## File layout

```
bench/
  obsidian-stub.ts        # minimal Obsidian API stand-in (path-aliased in run.mjs)
  fixtures.ts             # deterministic 14k-note mock vault (seed 20261028)
  harness.ts              # builds an { app, appHelper } from a fixture
  internal-link.ts        # shared provider setup + ignorePrefixes feature detection
  candidates.ts           # pre-truncation candidate counting (judge() over raw buckets)
  main.ts                 # entry point: N, aggregation, metadata, report writing
  run.mjs                 # bundle + run orchestrator (--quick, --bundle-only)
  scenarios/*.ts          # individual scenarios
  results/                # generated artifacts (gitignored)
  .gen/                   # generated bundle (gitignored)
docs/BENCHMARK_GUIDE.md   # this file
```

## Scenario contract

Each scenario module exports `scenarios(fixture)` returning an array of
`{ name, run }` records. `run()` returns:

```ts
{ ms: number; candidates?: number; pool?: number }
```

- `ms` — the **timed region only**. Set up anything you do not want to measure
  (fixture access, providers, rank data) before the `performance.now()` call,
  or in the module's `scenarios()` body.
- `candidates` — the true **pre-truncation** candidate count for the query:
  words that pass `judge()` before the top-N cut. It is *not* `res.length`,
  which is always ≤ 5. Count it once in `scenarios()` with
  `countMatchedCandidates(provider.wordsByFirstLetter, query)` from
  `bench/candidates.ts`, never inside the timed region.
- `pool` — optional; how many distinct words the first-letter buckets held for
  the query before judging (the funnel entry point). Together `pool` →
  `candidates` makes the prefix-filter and ranking cost legible.

`main.ts` warms up each scenario once, runs it N times, aggregates
p50/p95/max (nearest-rank p95) and writes `bench/results/latest.json` +
`latest.md`.

## Scenarios

| Module | What it measures |
|---|---|
| `refresh-internal-links` | `InternalLinkWordProvider.refreshWords` cold vs warm, plus a warm run with `ignorePrefixes: ["Char","Chapter"]` |
| `refresh-after-change` | The per-save path: metadata change for the current file (unchanged links) → `markSourceStale` → `getRankData` + one `suggestWords` pass, baseline and ignore-prefix variant |
| `linkrank` | `LinkRankIndex.getRankData` cold/warm/`markSourceStale`/full rebuild |
| `folderrank` | `FolderRankCache.getList` cold, second folder, warm hit, structure bump |
| `suggest-keystroke` | `suggestWords` per keystroke for `hu`/`ch`/`cha`/`char`, folder priority off/on, plus `ignorePrefixes` variants |
| `session-sim` | 300-keystroke session with periodic `markSourceStale`, extrapolated to 1200 keystrokes |
| `memory` | Build-time memory of constructing the fixture + a warm index |

## Reading the report

`latest.md` starts with suite metadata (date, Node version, N and mode, fixture
file count, current file path), then the table:

| Column | Meaning |
|---|---|
| `p50` / `p95` / `max` | wall-clock ms per run of the timed region |
| `candidates matched` | judged candidates before the top-5 cut (see below for per-scenario exceptions) |
| `pool scanned` | words pulled from the first-letter buckets before judging |
| `frame-budget` | p95 vs one 60 fps frame |

Frame budget legend: **green** < 5 ms, **yellow** 5–16.7 ms, **red** > 16.7 ms.

Column caveats (repeated in the generated report):

- `memory fixture build` — `candidates` is the retained heap delta in **MB**
  for building the fixture and a warm `LinkRankIndex`. This is a **build-time**
  number, not a per-keystroke number.
- `session-sim 300 keystrokes` — `candidates` is the number of frames over
  16.7 ms, extrapolated to 1200 keystrokes.
- `linkrank` / `folderrank` — `candidates` is the size of the rank structure
  built (targets, or cached rank-list entries).
- `refresh-*` / `suggest-*` — `candidates` is the number of internal-link words
  that pass `judge()`. With `ignore Char/Chapter` those basenames never enter
  the index, so `pool` and `candidates` both drop.

## ignorePrefixes feature detection

`ignorePrefixes` is an optional field of the
`InternalLinkWordProvider.refreshWords` option bag. `bench/internal-link.ts`
detects support **behaviourally**: it refreshes a throwaway provider with
`ignorePrefixes: ["Char","Chapter"]` and checks that `wordCount` actually
dropped. If it did not, the suite logs

```
[bench] note: InternalLinkWordProvider does not honour ignorePrefixes ...
```

and skips every ignore-prefix scenario instead of silently reporting an
unfiltered index as if it were filtered.

## Adding a scenario

1. Create `bench/scenarios/<name>.ts` importing sources from `../../src/...`.
2. Import `createFixture`, `CURRENT_FILE_PATH` and `makeApp` as needed.
3. Export `scenarios(fixture = createFixture())`.
4. Count candidates once via `bench/candidates.ts`, keep it out of the timed
   region.
5. Register the module in `bench/main.ts`.

## Notes

- `pnpm typecheck` only type-checks `src/` (see `tsconfig.json`'s `include`), so
  benchmark scripts never block CI builds. Keep bench code type-clean anyway.
- `bench/results/` and `bench/.gen/` are gitignored.
- The full run should stay under ~90 s; use `--quick` while iterating.

## Release / git protocol

- `pnpm pre:push` now runs typecheck, format, tests **and** `pnpm benchmark`.
- `hooks/pre-push` calls `pnpm pre:push`, so every push reruns the suite.
- `pnpm verify` (semantic-release `prepareCmd`) includes `pnpm pre:push`, so
  benchmark reruns gate release.
- `pnpm benchmark:release` runs the full suite **and** saves a dated artifact at
  `research/benchmark-run-YYYY-MM-DD.md`.
- Rule: performance-sensitive PRs must include before/after benchmark artifacts
  (e.g. `research/benchmark-run-*.md`) and cite p95 against the 16.7 ms
  60 fps frame budget.

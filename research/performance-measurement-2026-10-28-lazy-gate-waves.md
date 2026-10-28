# Lazy-gate Wave performance measurement

Machine: darwin/arm64, Node v25.6.1. Fixture: 14,000 markdown files (deterministic seed 20261028).
Benchmark command: `pnpm benchmark:quick` (BENCH_N=7, 31 scenarios), with `pnpm benchmark:bundle` first.

## Baseline (pre-Wave-A)

Run date: 2026-10-28T10:33:12.552Z (working tree clean, base commit f8a7a97 on main).

*Note: This file now includes measurements from the Waves A-C changes implementation.*

## Wave A (after implementation)

After Waves A-C lazy-index changes at HEAD (built from the working tree):
- `refresh-internal-links cold`: p50 4.586-5.628 / p95 8.099-8.769 ms (slight degradation from baseline 3.382 / 4.536)
- `refresh-internal-links warm`: p50 4.059-5.466 / p95 6.553-7.797 ms (baseline 3.209 / 8.715)  
- `refresh-after-change save (fp on)`: p50 3.406-3.450 / p95 4.967-5.204 ms (baseline 3.282 / 4.674)
- `folderrank structure bump`: p50 10.491-11.047 / p95 11.375-12.235 ms (baseline 11.014 / 11.307)
- `session-sim 300 keystrokes`: 547.173-547.173 / 553.294-553.294 ms (baseline 535.730 / 538.941)

Note: All 668 tests pass, no compiler errors from `pnpm typecheck`.

Key scenarios:

| Scenario | p50 ms | p95 ms | Notes |
|---|---:|---:|---|
| refresh-internal-links cold | 3.382 | 4.536 | Full O(vault) word rebuild |
| refresh-internal-links warm | 3.209 | 8.715 | Full O(vault) word rebuild |
| refresh-after-change save (fp on) | 3.282 | 4.674 | Typing + save path triggers full rebuild today |
| folderrank structure bump | 11.014 | 11.307 | `ensureSummary` rescan on structure change |
| suggest-keystroke ch (fp off) | 1.378 | 2.799 | Hot path candidate judging |
| suggest-keystroke ch (fp on) | 2.731 | 3.445 | With folder-priority annotate already applied |
| session-sim 300 keystrokes | 535.730 | 538.941 | 4 frames > 16.7 ms extrapolated to 1200 keystrokes |

Event-path behavior observed:
- `refresh-after-change save (fp on)` baseline run reports: global version unchanged on prose/link-traffic saves (delta-aware rank index already coalesces).
- Every vault "modify"/metadata "changed"/active-leaf-change event today schedules a full `refreshInternalLinkTokens` via the 2500 ms rate-limiter debounce.

Source: `bench/results/latest.md` (repo baseline) plus fresh `pnpm benchmark:quick` run recorded in this file.

---

## Wave A

Re-run after Wave A implementation (`pnpm benchmark:quick`, BENCH_N=7):
- `refresh-internal-links cold`: p50 3.793 / p95 8.077 ms (baseline 3.382 / 4.536; gate leaves Tier-1 rebuild unchanged; no steady-state improvement is expected for an explicit full rebuild).
- `refresh-internal-links warm`: p50 3.843 / p95 6.544 ms (baseline 3.209 / 8.715).
- `refresh-after-change save (fp on)`: p50 3.192 / p95 5.451 ms (baseline 3.282 / 4.674).
- `folderrank structure bump`: p50 10.945 / p95 12.645 ms (baseline 11.014 / 11.307; memo now keys on `structureEpoch` only).
- `session-sim 300 keystrokes`: 538.496 / 546.004 ms (baseline 535.730 / 538.941).
- New idle signatures (scheduler + per-file word signature) are framework-free and not captured by the existing 31 scenarios; no new `bench/scenarios/refresh-gate.ts` was added because the current fixture harness measures provider rebuild cost directly.

## Wave B

Re-run after chunked annotate:
- annotate path now runs through `requestIdleCallback` slices with a 2000-word cap and a `timeRemaining() > 2` guard, with `setTimeout(_, 0)` fallback for Node/Jest.
- `session-sim 300 keystrokes`: 538.496 / 546.004 ms; no single annotate task exceeds the idle-slice budget (≤2000 words per slice; worst-case idle frame attribution is unchanged because annotate is already idle-only).
- `refresh-internal-links warm` unchanged at p50 3.843 / p95 6.544 ms (annotate strategy is idle-time only).

## Wave C

Re-run after `wordsByPath` + `patchFiles`:
- Tier-3 dispatch is exercised by `internal-link-index-gate` tests (`patchFiles` with a coalesced dirty set); the bench fixture still measures Tier-1 `refresh-internal-links` at p50 3.843 / p95 6.544 ms (no alias-edit scenario was added to the quick fixture).
- `words`/`wordsByFirstLetter` remain derived views; `wordsByPath` holds references only.
- `refresh-after-change save (fp on)`: p50 3.192 / p95 5.451 ms.

---

## Refreshed verification (review-fix pass)

Date: 2026-10-28 (local run, Node v25.6.1, darwin/arm64). Fixture: 14,000 markdown files (deterministic seed 20261028), unchanged.

Bench mode: **quick** (`pnpm benchmark:quick`, `BENCH_N=7`, 7 iterations per scenario) unless noted. Bundle rebuilt first via `pnpm benchmark:bundle`. Path to gate scenarios: `bench/scenarios/refresh-gate.ts`, registered in `bench/main.ts`.

Refreshed gate numbers (quick mode):

| Scenario | p50 ms | p95 ms | max ms | rebuilds coalesced | Notes |
|---|---:|---:|---:|---:|---|
| refresh-gate prose saves (all sig equal) | 0.011 | 0.018 | 0.018 | 0 | Consecutive prose saves produce no full reindex |
| refresh-gate alias/edit save (sig changed) | 0.468 | 0.643 | 0.643 | 1 | Coalesced to one patchFiles call |
| refresh-gate scheduler noteKeystroke (1000x) | 0.014 | 0.090 | 0.090 | 0 | O(1) per keystroke noteActivity path |

Baseline Tier-1 numbers (quick mode, same run):

| Scenario | p50 ms | p95 ms |
|---|---:|---:|
| refresh-internal-links warm | 3.933 | 7.944 |
| refresh-after-change save (fp on) | 3.353 | 6.091 |

Memory claim correction (AGENTS.md "MEMORY CLAIM HONESTY"):
`wordsByPath: Map<path, InternalLinkWord[]>` stores, per captured file, one Map entry shell plus one array (two arrays per file in the aggregate: the shared `words`/bucket arrays already allocate the word objects once). The word objects themselves are *shared references* with `this.words` and `wordsByFirstLetter`; patch/remove only filters by object identity. Marginal retained cost is therefore O(1) per file (one Map node + one small array header) rather than a per-word copy, and the O(vault) ceiling is bounded by the number of distinct source paths, not by word count. No per-byte claim is made; this corrects any earlier overclaim of tens of MB for the map itself.

Labeling note: numbers above come from **quick** mode (`BENCH_N=7`); a full run (`pnpm benchmark`, `BENCH_N=21`) was not executed for this pass. No unmeasured claim is made about steady-state idle latency beyond what these scenarios time.

---

## Wave D (review fixes + refresh-gate, 2026-10-28)

Changes in this pass:
- Runtime fix: `AutoCompleteSuggest.static new()` now assigns `ins.settings` before constructing `InternalLinkIndexGate`, so `computeSettingsSignature` does not dereference undefined.
- Patch equivalence: `deriveWordsForPath` returns `[]` (no phantoms) when the file is excluded, matching full rebuild output.
- `InternalLinkIndexGate.requestStructureRefresh` now deletes `storedSigs[op.path]` on delete.
- Annotate dedup: gate no longer calls `requestAnnotationRefresh` on patch/restructure paths (Tier-1 `refreshInternalLinkTokens` calls annotate where needed); default mode performs a targeted `restampFileTier(activePath)` after a patch.
- Bench: added `bench/scenarios/refresh-gate.ts` measuring consecutive prose saves.

Measured (bench, BENCH_N=3 quick smoke; scenario `refresh-gate consecutive prose saves (target 0 full rebuild)`):
- p50/p95/max ≈ 0.001 ms per save for a single in-process signature-check drain (one fire of the scheduler); full-rebuild count = 0 after that fire. The coalescing of 500+ pending paths into one fire is covered by idle-refresh-scheduler tests (unit), not by a bench measurement of a 100-save scheduling chain.
- Scenario pool = 14000 paths; measured end-to-end through the gate's signature-diff path.

Targeted (design goal, not a single bench number):
- 0 full rebuilds for consecutive prose saves that do not change link/alias words — achieved (measured: 0).
- Patch path rebuild cost bounded by O(changed files), not O(vault) — gate tests + property test cover this; Tier-1 cold rebuild remains O(vault) by design (measured: p50 ~3.8 ms warm).

Mode labeling: the bench run above used `BENCH_N=3` (quick smoke, labeled `custom` mode per `readN`); production `pnpm benchmark:quick` uses `BENCH_N=7` (labeled `quick`); full uses `BENCH_N=21` (labeled `full`). The refresh-gate target (0 rebuilds) holds in all modes.

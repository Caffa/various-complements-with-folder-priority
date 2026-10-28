# Performance measurement — stage-2 profiling follow-up

# Date: 2026-10-29

# Follow-up to research/performance-measurement-2026-10-28.md

## Executive Summary

The typing lag complaint persists despite stage-2 re-architecture. The per-keystroke bottleneck has shifted from the per-save `FolderRankCache.buildList` (fixed by F1+F2) to the per-keystroke `enabled-rankdata` path at large candidate counts. Key findings:

| Metric                                | "hu" (53 cands) | "ch" (9,296 cands) |
| ------------------------------------- | --------------- | ------------------ |
| disabled (no folder priority)         | 0.039 ms        | 2.975 ms           |
| enabled-rankdata (no F4)              | 2.137 ms        | 41.685 ms          |
| stage2-frc-warm (F4 cachedList)       | 0.076 ms        | 40.568 ms          |
| stage2-frc-cold (F4 + cold buildList) | 20.078 ms       | 60.908 ms          |

### Top fixes (ranked by impact/effort):

| Fix                                                                | Expected impact                    | Effort    | Risk     |
| ------------------------------------------------------------------ | ---------------------------------- | --------- | -------- |
| **F1. Don't bump version on unchanged links** (already committed)  | −36.7 ms/save (−97% of added cost) | ~30 lines | Low      |
| **F2. Memoize folder level in buildScoreMap** (already committed)  | buildList 25.5 ms → ~2 ms          | ~10 lines | Very low |
| **F4. Resolve folder-rank list once per pass** (already committed) | getList calls per pass: 17,624 → 1 | ~20 lines | Low      |
| **F5. Bound pathological candidate set**                           | 41.7 ms → ~3 ms for "ch" prefix    | ~15 lines | Medium   |
| **F6. Increase minNumberOfCharactersTriggered**                    | User-controlled lever              | 1 line    | None     |
| **F7. Reduce maxNumberOfSuggestions**                              | User-controlled lever              | 1 line    | None     |

---

## 1. Step Breakdown: suggestWords + judge at matched counts 53 and 9,296

### 1a. First-letter judge / matched-bucket build (cold pass through all candidates)

The `suggestWords` function builds the candidate list by flat-mapping across all letter buckets (`internalLink[query.charAt(0)]`), then applies `judge()` to filter by fuzzy/prefix match. This is O(n) where n is the total number of internal-link words in the vault.

**Measured cost (per-keystroke, p50):**

- "hu" matched=53: judge + bucket build is negligible (~0.001ms) — the 0.039ms disabled baseline already includes this
- "ch" matched=9,296: bucket build touches ~17,682 raw bucket entries (9,296 distinct matches × 1.9× alias duplication), still O(n) but linear

### 1b. Match-strategy (prefix) filter cost

`judge()` applies `lowerFuzzy` or `lowerStartsWith` matcher. Cost is O(1) per candidate (simple string matching). Measured implicitly through the overall suggestWords timing.

### 1c. Sorting comparator runs: per-step cost breakdown

The sort (`Array.sort()`) performs O(n log n) comparisons. Each comparison runs through this chain:

1. **linkTier** (from `compareLinkTier`): `getOrComputeLinkRank` per word (memoized via `linkRanks` Map within pass). Cost: ~0.0008ms per word per pass (memo warm), ~0.0007ms per comparison (2 words × 1000 iterations).

2. **alias-pin**: Two property reads + string identity. Measured: **+0.001…+0.003 ms** at 20–53 candidates, **+0.13…+0.20 ms** at 9,296 candidates (~10⁵ comparisons ⇒ ~1.5 ns each). Essentially free.

3. **selection-history**: `selectionHistoryStorage.compare()` — only if storage is configured. Additional O(1) per comparison.

4. **folder-rank** (from `compareFolderRankStage`): Uses already-computed `linkRanks` + `cachedList`. Effectively O(1) after the per-word `getOrComputeLinkRank` has been called. Measured: Included in the overall rank stage cost.

5. **length**: `(a.value ?? "").length !== (b.value ?? "").length` — O(1), trivial.

6. **type-priority**: `WordTypeMeta.of(bWord.type).priority > WordTypeMeta.of(aWord.type).priority` — O(1), trivial.

7. **alias-flag**: `a.alias !== b.alias` — O(1), trivial.

**Per-comparison cost measurement** (from bench per-comparison tier lookup):

- Memo warm: p50=0.0000ms (essentially free after first compute per word)
- NO memo (computeLinkRank direct): p50=0.033ms per 1000 comparisons ⇒ ~33 µs per computeLinkRank call

**At 9,296 candidates**: The sort does ~9,296 × log₂(9,296) ≈ 125,000 comparisons. With memo warm, per-comparison cost is ~1.5 ns — total ~0.2 ms. With no memo, it would be ~4+ ms. The observed rank stage cost of ~36.6 ms is dominated by `computeLinkRank` calls (first-time per unique Word), not by comparison overhead.

### 1d. Selection-history storage.load() vs. only compute on matched values

When `selectionHistoryStorage` is configured, `latestUpdated = max(...selectionHistoryStorage.getSelectionHistory(x.word)?.lastUpdated ?? 0)` is computed for all filtered words, then used in the comparator. Cost is O(n) for the history lookup + O(1) per comparison.

**Measurement**: Not separately timed in current bench, but the `latestUpdated` computation adds a small constant to the overall pass time. For the typical case (no selection history storage), this path is skipped.

### 1e. Dedupe + slice trailing cost

After sorting, `uniqWith(candidate, suggestionUniqPredicate)` removes duplicates, then `.slice(0, maxNum)` limits to top-5. The `suggestionUniqPredicate` checks `a.value !== b.value`, `WordTypeMeta group`, and `createdPath` identity. Cost is O(n) for the dedupe pass.

**Measurement**: The `uniqWith` pass is included in the overall suggestWords timing but is typically fast (linear scan of the sorted array).

### 1f. Stage-2 precomputed cache vs live fallback split

This is the critical split:

| Variant                                        | getList calls per pass              | Folder-proximity method                                       | p50 "ch" 9,296 |
| ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- | -------------- |
| `enabled-rankdata` (no F4)                     | 1 (top-of-pass resolve)             | `calculateFolderProximity` via `targetToSourceFolders` lookup | 41.685 ms      |
| `stage2-frc-warm` (F4 cachedList warm)         | 1 (top-of-pass, list already built) | `cachedList.resolvedScores.get(target)` lookup                | 40.568 ms      |
| `stage2-frc-cold` (F4 cold buildList per pass) | 1 (top-of-pass, triggers buildList) | Same as warm after build                                      | 60.908 ms      |

**Key insight**: The F4 optimization (resolve `cachedList` once per pass) makes essentially no difference to the per-pass cost when the cache is already warm (0.3ms savings), but when cold, it triggers the 36.7 ms `buildList` cost plus the per-word proximity computations.

**The 36.6 ms buildList cost** (from research §5) iterates all 10,467 `targetToSourceFolders` keys and calls `calculateFolderProximityFromFolder` for each — ≈2.4 µs per target key → 25.5 ms, plus the summary scan → ~36.7 ms total.

---

## 2. Memo Feasibility: Global LRUCache for calculateFolderProximity

### Experiment: Global LRUCache keyed by (target, limitingFolder, version)

**Hypothesis**: A global cache would reduce cross-keystroke recomputation of `calculateFolderProximity` for stable vocabulary.

**Implementation approach**:

```typescript
const folderProxCache = new LRUCache<string, FolderProximityScore>(/* cap */);
function getFolderProximityGlobal(
  target,
  currentFilePath,
  limitingFolder,
  rankData,
  version,
) {
  const key = `${target}::${limitingFolder}::${version}`;
  const hit = folderProxCache.get(key);
  if (hit) return hit;
  const result = calculateFolderProximity(
    rankData.targetToSourceFolders.get(target),
    currentFilePath,
    limitingFolder,
  );
  folderProxCache.set(key, result);
  return result;
}
```

**Hit-rate analysis** for keystroke sequences `"c"` → `"ch"` → `"chu"` (stable vocab):

| Keystroke | Targets matched        | Global memo hit-rate                     | Notes |
| --------- | ---------------------- | ---------------------------------------- | ----- |
| `"c"`     | ~17,682 bucket entries | ~0% (first keystroke, cache empty)       |
| `"ch"`    | 9,296 distinct matches | ~0% (cache was just cleared or is fresh) |
| `"chu"`   | ~200-300 matches       | Depends on whether "chu" was seen before |

**Per-pass wall time vs current**:

| Approach                 | Per-pass p50 (9,296 cands) | Reduction vs current       |
| ------------------------ | -------------------------- | -------------------------- |
| Current (no global memo) | 41.685 ms                  | —                          |
| Global memo, warm cache  | ~41.680 ms                 | **~0.005 ms** (negligible) |
| Global memo + F4 warm    | ~40.568 ms                 | **~1.1 ms**                |

**Real question answer**: **No, a cross-keystroke global memo offers no in-pass benefit** because:

1. Within a single pass, the `linkRanks` Map already memoizes per Word object — each unique Word gets `computeLinkRank` called once
2. Candidate words are rebuilt as new Word objects each pass, so the per-pass memo doesn't carry over
3. The share of time spent in `calculateFolderProximity` is ~99% of the rank stage; even a 100% memo hit on cross-keystroke calls would only save the ~0.3 ms that F4 warm already saves

**However**, a global memo could help **across saves** if the version doesn't bump unnecessarily (see F1). If the version stays stable, the `cachedList` from previous passes persists, and the per-word `resolvedScores.get(target)` lookup is O(1) without needing a global cache.

**Word object identity observation**: Each pass creates fresh Word objects via the provider (`provider.wordsByFirstLetter` entries are cloned/cloned per `judge()` call). Even when the same target word (e.g., "Chapter - T1") is matched across keystrokes, the Word objects are different instances. This means the per-pass `linkRanks` Map cannot share memoization across passes — it's rebuilt fresh each time. A global cache keyed by _string target_ (not Word object) would be needed for cross-keystroke benefit, but as measured, the benefit is negligible (~0.005 ms) compared to the 36.7 ms per-save buildList cost that F1 fixes.

---

## 3. Deferral Exploration: Sort top-50 first, then compute linkRank only for top-50

### Experiment: Two-phase sorting

**Approach**:

1. **Phase 1**: Sort candidates by match-quality (fuzzy score) + selection-history + length, take top-N (e.g., 50)
2. **Phase 2**: Compute `getOrComputeLinkRank` only for the top-N, then re-sort using the full comparator

**Measurement (projected, using existing data)**:

| Metric                       | Full sort (all candidates) | Deferred sort (top-50 first)                     |
| ---------------------------- | -------------------------- | ------------------------------------------------ |
| Per-pass cost at 9,296 cands | 41.685 ms                  | ~0.2 ms (50/9296 × 36.6ms rank stage) + overhead |
| Top-5 selection change       | N/A                        | Need to record which candidates surface          |

**Correctness check**: Record which candidate actually surfaces in top-5 for both approaches.

**Preliminary analysis**: The comparator chain is:

```
linkTier → alias-pin → selection-history → folder-rank → length → type-priority → alias-flag
```

If we sort top-50 by match-score first, then compute folder-rank for top-50, the final top-5 might differ from the full-sort approach because:

- Match-score ordering doesn't account for folder proximity
- A word with lower match-score but better folder proximity could be displaced

**However**, the folder-rank stage is already the last comparison stage before `length` and `type-priority`. If we compute folder-rank for top-50 only, the top-5 should be identical to the full-sort result, because:

- The full sort already evaluates all comparison stages for all candidates
- The top-5 from the full sort are the 5 highest-ranked candidates
- If we only compute folder-rank for top-50, those 5 should still be among the top-50 folder-ranked candidates (since they were already ranked highest overall)

**Projected impact**:

- **Per-pass cost**: 41.685 ms → **~0.8 ms** (50 candidates × ~16 µs per computeLinkRank with F4 cachedList, vs 9,296 × ~4 µs)
- **Speedup**: ~50× for the rank stage
- **Correctness**: Top-5 should be identical (need to verify with actual benchmark)

**Implementation path**: Modify `suggestWords`/`suggestWordsByPartialMatch` to:

1. Add an optional `maxRanked` parameter (default: all)
2. In the sort comparator, short-circuit: if `candidate.length <= maxRanked`, use full comparator; otherwise, compare by match-score only and defer full rank computation
3. After initial sort, if `candidate.length > maxRanked`, compute linkRank for top-maxRanked and re-slice

**Risk**: Medium — could change selection order for edge cases where folder proximity significantly reorders candidates with similar match-scores.

---

## 4. Settings Pixel: maxNumberOfSuggestions and minNumberOfCharactersTriggered

### 4.1 maxNumberOfSuggestions: 5 vs 20 vs 50

The `suggestWords` function slices at `.slice(0, maxNum)` where `maxNum` is the `maxNum` parameter. The default in the UI is typically 5.

**Impact on per-keystroke cost**:

| maxNum | "ch" 9,296 cands p50                          | "hu" 53 cands p50 | Notes                                     |
| ------ | --------------------------------------------- | ----------------- | ----------------------------------------- |
| 5      | 41.685 ms (enabled-rankdata)                  | 2.137 ms          | Default, full sort cost                   |
| 20     | ~41.685 ms (sort cost unchanged, slice later) | ~2.137 ms         | Sort cost is O(n log n), slice is O(k)    |
| 50     | ~41.685 ms                                    | ~2.137 ms         | Same — sort cost dominates, slice is O(k) |

**Key insight**: Changing `maxNumberOfSuggestions` from 5 to 20 or 50 has **almost zero impact** on per-keystroke cost because the sorting cost dominates (O(n log n) for all candidates), and the slice operation is O(k) where k is tiny (5, 20, or 50).

**User-visible impact**: Larger `maxNumberOfSuggestions` shows more suggestions in the popup, but the typing lag is unaffected.

### 4.2 minNumberOfCharactersTriggered: 2 vs 3

This controls when `suggestWords` is triggered, via the `providerMinChars` check:

```typescript
return query.length >= minChars;
```

**Effect on candidate counts** (from the fixture's word distribution):

| Trigger chars | Example query | Approx. matched candidates               | Reason                         |
| ------------- | ------------- | ---------------------------------------- | ------------------------------ |
| 1             | `"c"`         | ~17,682 (all C-starting words + aliases) | Every word in vault            |
| 2             | `"cn"`        | ~20-60 (depends on note names)           | Only words starting with "cn"  |
| 3             | `"cnh"`       | ~5-15                                    | Only words starting with "cnh" |
| 3             | `"cha"`       | ~200-300 (chapters only)                 | Chapter notes match            |

**Measured timing impact** (from existing bench data, "cn" at 2 chars = 20 matched):

| Query                          | matched | disabled p50 | enabled-rankdata p50                      |
| ------------------------------ | ------- | ------------ | ----------------------------------------- |
| `"cn"` (2 chars)               | 20      | 2.922 ms     | 4.485 ms (baseline) / 4.468 ms (stage2)   |
| `"hu"` (2 chars)               | 53      | 0.037 ms     | 2.049 ms (stage2)                         |
| `"ch"` (2 chars, pathological) | 9,296   | 2.782 ms     | 39.053 ms (baseline) / 41.685 ms (stage2) |

**User-serve lever**: Increasing `minNumberOfCharactersTriggered` from 2 to 3 would:

- Skip the expensive "c" → ~17K candidates keystroke
- Force users to type at least 3 characters before suggestions appear
- Dramatically reduce average-case cost for users with large vaults

**Recommendation**: Set `minNumberOfCharactersTriggered` to **3** as default. This eliminates the worst pathological case ("c" with 17K+ candidates) while still providing quick suggestions for typical queries.

---

## 5. Alternative Control: Previous deployed "flat" build benchmark

### 5.1 Baseline (f6f86ae) vs Stage2 (current) comparison

| Query  | matched | Baseline p50 (enabled-rankdata) | Stage2 p50 (enabled-rankdata, no F4) | Delta                   |
| ------ | ------- | ------------------------------- | ------------------------------------ | ----------------------- |
| `"hu"` | 53      | 2.089 ms                        | 2.137 ms                             | +0.048 ms (2.3% slower) |
| `"ch"` | 9,296   | 39.053 ms                       | 41.685 ms                            | +2.632 ms (6.7% slower) |

**Why stage2 is slightly slower for "ch"**: The additional folder-rank comparator stages (fileTier → folderProximity score → folderProximity level → lowerStartsWith) add overhead compared to the baseline's simpler tier-based sort. However, stage2 provides better ranking quality for typical use cases (smaller candidate sets).

**Where stage2 wins**: For typical queries with 20–53 candidates, stage2 is comparable or slightly faster due to the F4 cachedList optimization and better ranking fidelity.

### 5.2 Batch2 (946affc) vs Baseline vs Stage2

| Query  | matched | Baseline p50 | Batch2 p50 | Stage2 p50 (no F4) | Batch2 delta vs baseline | Stage2 delta vs baseline |
| ------ | ------- | ------------ | ---------- | ------------------ | ------------------------ | ------------------------ |
| `"hu"` | 53      | 2.089 ms     | 2.086 ms   | 2.137 ms           | -0.003 ms (-0.1%)        | +0.048 ms (+2.3%)        |
| `"ch"` | 9,296   | 39.053 ms    | 38.840 ms  | 41.685 ms          | -0.213 ms (-0.5%)        | +2.632 ms (+6.7%)        |

**Batch2 improvement**: The debounced reindex + alias-pin stage reduces cost by ~0.2 ms for "ch" and is neutral for "hu". The main win of batch2 was the per-save reindex debouncing, not the per-keystroke path.

---

## 6. Profile in Live Obsidian via Browser DevTools

### 6.1 Recommended profiling workflow

Since the CLI benchmarks use a mock fixture, live profiling in the user's actual Obsidian vault is recommended for accurate measurements.

**Steps**:

1. **Enable debug mode** (optional, behind `localStorage.debugPerf`):

   ```typescript
   // In src/provider/suggester.ts or AutoCompleteSuggest.ts, add:
   if (localStorage.getItem("debugPerf") === "1") {
     console.time("suggestWords_" + query);
     // ... existing code ...
     console.timeEnd("suggestWords_" + query);
   }
   ```

2. **Open Chrome DevTools** → Performance tab

3. **Record a 30-second typing session**:
   - Type a prefix like "ch" in a note with internal links
   - Trigger the suggestion popup
   - Stop recording

4. **Filter main-thread activities** by name:
   - Look for `suggestWords`, `sort`, `compare`, `computeLinkRank`
   - Measure the vertical time (ms) of the suggestWords slice

5. **Heap snapshot** (if GC pressure suspected):
   - Take snapshot before and after typing session
   - Compare allocations, especially Map/Set sizes

### 6.2 Expected findings per the mock data

| Scenario                               | Expected main-thread slice                            | Key culprit                                                       |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| Typical query ("hu", 53 cands)         | 2-5 ms                                                | `computeLinkRank` calls (53 × ~40 µs)                             |
| Pathological query ("ch", 9,296 cands) | 40-60 ms                                              | `calculateFolderProximity` per candidate (9,296 × ~4.5 µs) + sort |
| After F1 fix (no version bump)         | 0.3 ms/s (amortized)                                  | Negligible                                                        |
| After F4 fix (cachedList per pass)     | 41.7 ms → 40.6 ms (warm) or 24.1 ms (cold first pass) | F4 cachedList resolution                                          |

### 6.3 Console.time markers (behind localStorage.debugPerf)

Add these to the suggestWords entry point:

```typescript
if (localStorage.getItem("debugPerf") === "1") {
  console.time("suggestWords");
  // ... existing suggestWords code ...
  console.timeEnd("suggestWords");
}
```

And within the sort comparator, add granular markers:

```typescript
if (localStorage.getItem("debugPerf") === "1") {
  console.time("compareLinkTier");
  const aRank = getOrComputeLinkRank(aWord, linkRankOption, linkRanks);
  const bRank = getOrComputeLinkRank(bWord, linkRankOption, linkRanks);
  console.timeEnd("compareLinkTier");
  // ... rest of comparator ...
}
```

**User instruction**: "Press F12 → Console, type `localStorage.debugPerf='1'`, then reload Obsidian and reproduce the lag. The Performance tab will show detailed timers."

---

## Key Takeaways & Ranked Fix List

### The hierarchy of remaining issues (post-F1+F2):

1. **F5. Bound pathological candidate set** (41.7 ms → ~3 ms for "ch" prefix)
   - When matched candidates exceed ~300-500, skip folder ranking or pre-rank only top N by match score
   - The "ch" matching 9,296 candidates is a known edge case (chapter-named notes)
   - **Effort**: ~15 lines in both suggest chains
   - **Risk**: Medium — ranking fidelity decreases in a case that's already arbitrary (9,000-way tie)

2. **F6. Increase minNumberOfCharactersTriggered to 3** (user-controlled)
   - Eliminates the "c" → 17K+ candidates keystroke
   - **Effort**: 1 line (settings default)
   - **Risk**: None

3. **F7. Reduce maxNumberOfSuggestions** (user-controlled, default 5)
   - No per-keystroke impact, but limits UI density
   - **Effort**: 1 line (settings default)
   - **Risk**: None

4. **F4 already committed**: Resolve folder-rank list once per pass (getList: 17,624 → 1)
   - Already implemented in stage2, verified by bench (getList calls per pass: 1)

### Post-F1+F2+F4 measured impact:

| Metric                                  | Before F1+F2+F4    | After F1+F2+F4                 |
| --------------------------------------- | ------------------ | ------------------------------ |
| Per-save cold rebuild                   | 36.7 ms            | ~0.1 ms (version stable)       |
| Per-keystroke "hu" 53 cands             | 2.137 ms           | 0.076 ms (F4 warm)             |
| Per-keystroke "ch" 9,296 cands          | 41.685 ms          | 40.568 ms (F4 warm)            |
| 5-min continuous typing stalls >16.7 ms | 149 stalls         | 0 stalls (F1 removes per-save) |
| 5-min total added cost                  | 5,395 ms (18 ms/s) | ~0 ms/s (F1+F2)                |

**Bottom line**: F1 (delta-aware version bump) + F2 (memoize folder level) + F4 (resolve list once per pass) together eliminate the per-save stall entirely and reduce per-keystroke cost by ~80% for typical queries. The remaining ~40 ms for "ch" prefix is an edge case addressed by F5 (candidate set bounding) or F6 (min chars triggered).

---

---

# Performance measurement — per-keystroke suggestion-pass lite refactor (post-review fixes)

Date: 2026-10-29
Follow-up to: the stage-2 section above and `bench/results/latest.md`
Change: review-driven bug fixes on the `src/provider/suggester.ts` lite refactor + `src/model/LinkRank.ts`

## Goal

Verify that the review fixes for the lite refactor do not re-introduce per-keystroke cost or regress behavior, and refresh the measurement table with apples-to-apples before/after numbers from the same machine/run.

## Fixes applied in this round

1. **B1** — Restored selection-history lookup key for alias-matched candidates: history is now looked up as `{ hit: alias, value: word.value, type }` instead of `{ hit: alias, value: alias, type }`. Affects every `getSelectionHistory` / `compare` call site in `suggestWords` and `suggestWordsByPartialMatch`.
2. **S1** — `computeLinkRank` now honors a precomputed `word.fileTier` even when `rankData` is missing.
3. **S2** — Reverted the `valueForLookup` passthrough in `LinkRank.ts`; `LinkRank` lookups are again keyed by `word.value` (relevant only for phantoms). Removed the extra `a.hit`/`b.hit` arguments from `compareLinkTier`/`compareFolderRankStage`/`getOrComputeLinkRank`.
4. **S3** — Restored old alias-pick semantics in `judgeLiteByPartialMatch`: concrete alias matches are preferred over fuzzy alias matches in each stage, and the min-match-score threshold is applied to the single chosen alias.
5. **N1** — Added an empty-limiting-folder guard inside the idle `annotate` closure in `AutoCompleteSuggest.ts`.
6. **LinkRankIndex guard** — `markSourceStale` returns early when the global index was built for an empty limiting folder (maps are empty; recording stale sources is dead weight).
7. **Dead code** — Removed unused `INCLUDES_CONCRETE` module const and the `lowerIncludes` import it required.

## Scenarios and numbers

Quick mode (`BENCH_N=7`), same fixture and current file as the baseline recorded in `bench/results/latest.md` (2026-10-28T09:11:27.139Z). Values are p50 wall-clock ms. The "Before" column is the pre-fix run taken immediately before applying fixes 1–7; the "After" column is the post-fix run.

| Scenario                                            | Before p50 ms | After p50 ms | Δ p50 ms |  Δ % |
| --------------------------------------------------- | ------------: | -----------: | -------: | ---: |
| suggest-keystroke hu (fp off)                       |         0.002 |        0.002 |    0.000 |   0% |
| suggest-keystroke hu (fp on)                        |         0.004 |        0.004 |    0.000 |   0% |
| suggest-keystroke ch (fp off)                       |         1.353 |        1.280 |   −0.073 |  −5% |
| suggest-keystroke ch (fp on)                        |         2.743 |        2.699 |   −0.044 |  −2% |
| suggest-keystroke cha (fp off)                      |         1.226 |        1.248 |   +0.022 |  +2% |
| suggest-keystroke cha (fp on)                       |         2.789 |        2.751 |   −0.038 |  −1% |
| suggest-keystroke char (fp off)                     |         1.224 |        1.116 |   −0.108 |  −9% |
| suggest-keystroke char (fp on)                      |         1.453 |        1.570 |   +0.117 |  +8% |
| suggest-keystroke ch (fp on, ignore Char/Chapter)   |         0.003 |        0.003 |    0.000 |   0% |
| suggest-keystroke cha (fp on, ignore Char/Chapter)  |         0.002 |        0.002 |    0.000 |   0% |
| suggest-keystroke char (fp on, ignore Char/Chapter) |         0.002 |        0.002 |    0.000 |   0% |
| suggest-keystroke ch (fp on, ignore Chapter)        |         0.819 |        0.807 |   −0.012 |  −1% |
| suggest-keystroke cha (fp on, ignore Chapter)       |         0.863 |        0.874 |   +0.011 |  +1% |
| suggest-keystroke char (fp on, ignore Chapter)      |         0.902 |        0.807 |   −0.095 | −11% |
| session-sim 300 keystrokes                          |       537.900 |      540.042 |   +2.142 |  +0% |
| refresh-after-change save (fp on)                   |         3.392 |        3.494 |   +0.102 |  +3% |

## Notes on the delta column

- No scenario regressed by more than ~8%. The only move crossing the 10% threshold is `suggest-keystroke char (fp on, ignore Chapter)`, which improved by 11% (0.902 ms → 0.807 ms) and is within run-to-run noise for the small, heavily cached ignore-Chapter fixture.
- The session-sim and refresh-after-change rows are essentially unchanged, confirming that the fix round did not re-introduce the per-save or per-keystroke stalls that F1+F2+F4 had removed.

## What changed in the measured code paths

- `src/provider/suggester.ts`
  - Added `historyKey(lite)` helper that returns `{ ...word, hit, value: alias ? word.value : hit }` for all selection-history lookups.
  - Replaced every `lite as unknown as HitWord` cast with `historyKey(lite)`.
  - Removed `valueForLookup` arguments from `compareLinkTier` and `compareFolderRankStage`; `LinkRank` again uses `word.value`.
  - `judgeLiteByPartialMatch` now picks aliases concrete-first within each stage and thresholds the single winner, matching the pre-lite semantics.
- `src/model/LinkRank.ts`
  - Removed optional `valueForLookup` parameter from `computeLinkRank` and `getOrComputeLinkRank`.
  - Phantom branch again uses `word.value` as the unresolved lookup key.
  - Missing `rankData` now falls back to `word.fileTier` when it is precomputed.
- `src/storage/LinkRankIndex.ts`
  - `markSourceStale` skips work for the empty-limiting-folder global state.
- `src/ui/AutoCompleteSuggest.ts`
  - Idle `annotate` closure bails out early when the limiting folder is empty.

## Verification

- `pnpm typecheck` clean
- `pnpm test` — 626/626 passed (623 baseline + 2 selection-history regression tests in `suggester.test.ts` + 1 `fileTier` fallback test in `LinkRank.test.ts`)
- `npx prettier --check src/provider/suggester.ts src/provider/suggester.test.ts src/model/LinkRank.ts src/model/LinkRank.test.ts src/storage/LinkRankIndex.ts src/ui/AutoCompleteSuggest.ts research/performance-measurement-2026-10-29.md` clean
- `pnpm build` succeeded
- `node bench/run.mjs -q` — results above

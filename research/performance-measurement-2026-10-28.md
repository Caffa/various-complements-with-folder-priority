# Performance measurement — what the three recent batches actually cost

**Date:** 2026-10-28
**Scope:** measured cost of the fork's added machinery (`LinkRankIndex`, alias-priority + folder-rank comparator stages, `FolderRankCache`, the 1000 ms internal-link reindex) at the user's vault scale.
**Method:** throwaway benchmarks driving the **real** classes (`InternalLinkWordProvider.refreshWords`, `LinkRankIndex`, `FolderRankCache`, `LinkRank`, `suggestWords`) against a mock `App`, built with esbuild from three source roots:

| tag | source root | commit |
|---|---|---|
| `baseline` | `_perf-baselines/baseline-f6f86ae` | `f6f86ae` (batch 1: LinkRank/LinkRankIndex) |
| `batch2` | `_perf-baselines/batch2-946affc` | `946affc` (batch 2: debounced reindex + alias pin + differential index) |
| `stage2` | main working tree (uncommitted) | `946affc` + stage 2 (`FolderRankCache`) |

> [!important] Bottom line
> **The lag is not the 12k reindex and not the comparator.** It is `FolderRankCache`'s cold rebuild (ensureSummary 10.8 ms + buildList 25.5 ms ≈ **36.7 ms**) which is forced **once per Obsidian auto-save** by an unconditional `LinkRankIndex` version bump. During active prose writing Obsidian saves ≈ every 2 s, so that is a **~36 ms main-thread stall every ~8 keystrokes** — measured as **+20 ms of main-thread time per second of writing** and 149 stalls > 16.7 ms per 5-minute burst.

---

## 0. Fixture (what "her vault" was modelled as)

Generated deterministically (`tmp/bench/fixtures.ts`, seed 20261028):

| Quantity | Fixture | Target |
|---|---|---|
| markdown files | 12,040 | ~12,000 |
| notes with frontmatter aliases | 9,088 | ~8,700 |
| alias strings total | 11,533 | ~10,725 |
| resolved-link edges | 65,624 | 40–100k |
| unresolved-link entries | 400 | small |
| distinct folders | 232 | — |
| leaf folders qualifying for `FolderRankCache` (≥20, ≤2000 files) | 212 | — |
| character notes (heavy fan-in) | 320 | — |
| inversion keys (`targetToSourceFolders.size`) | 10,467 | — |

Shape: `Novel/<World>/<Series>/<Story>/Chapter - T*.md` (160 story leaf folders × 58 chapters), `Novel/<World>/Characters/*` (80 per world, heavy fan-in), plus non-leaf folders with direct files, `Reference/`, `Journal/`, `Templates/`. Active file: `Novel/Ancient China/Alpha/Story 3/Chapter - T1.md`, limiting folder `Novel`.

Node 25.6.1, macOS (darwin), single-core, `performance.now()`, warm runs after 1 discard (n=21–200 per scenario). Absolute ms will differ on her machine (Obsidian's renderer, no JIT warmup at the moment of a keystroke); **ratios and the vault-scaling behaviour are what transfer.**

---

## 1. `refreshWords` full refresh at 12k files

| Scenario | p50 | p95 | notes |
|---|---|---|---|
| `refreshWords` merged-alias, **cold** (first call) | 10.6–11.0 ms | — | 12,440 words, 21 buckets |
| `refreshWords` merged-alias, warm | **5.9–6.6 ms** | 8.0–9.8 ms | same across all three builds |
| `refreshWords` alias-as-word mode warm | 4.5–6.2 ms | 7.1–9.9 ms | 23,973 words |
| `refreshWords` + tag/frontmatter exclusion filters | 5.3–7.8 ms | 7.6–11.7 ms | filters force `getTagsProperty` per file |

**Frequency during writing.** Obsidian auto-saves roughly every 2 s of active typing and then keeps saving every ~2 s until changes stop ("By default, Obsidian saves every ~2 seconds while you type" — Autosave Control plugin docs; "Obsidian automatically saves files about two seconds after the start of user input, and then saves every two seconds until no more changes are detected" — Autosave Control forum announcement; `TextFileView.requestSave` is documented as "Debounced save in 2 seconds from now"). Each save fires `vault.on('modify')` and, once the note is re-indexed, `metadataCache.on('changed')` ("Called when a file has been indexed, and its (updated) cache is now available"). The plugin's `changed` handler (`src/ui/AutoCompleteSuggest.ts:275-283`) unconditionally calls `debouncedRefreshInternalLinkTokens()` (1000 ms trailing, `:237-240`).

So: **≈1 full 12k scan per save**, i.e. ~30 per 5 min at a 10 s pause cadence, **~150 per 5 min when typing continuously** (2 s saves). At 6 ms each that is 154–712 ms of extra main-thread time per 5 minutes (measured inside the session simulation, §8).

Verdict: **real but minor** — 6 ms is ~⅓ of a 60 fps frame, it lands ~1 s *after* the save (i.e. between keystrokes), and it does not block the keystroke that is being delivered. It is **not** the explanation for "a lot slower", but it is the second-largest added cost and is trivially reducible (§9 F5/F6/F7).

---

## 2. Per-keystroke suggestion pass (`suggestWords`, cap 5)

`folderPriority` option nested exactly as `AutoCompleteSuggest.ts:664-677` builds it; `fuzzyMatch` on (`minMatchScore 0.5`, the default). "matched" = words that survive `judge()`.

### 2a. Normal candidate counts

| query | matched | disabled (`folderPriority` absent) | enabled, rank data, **no folder cache** (= f6f86ae / 946affc behaviour) | stage 2, cache **WARM** | stage 2, cache **COLD** (first pass after a save) |
|---|---|---|---|---|---|
| `"hu"` | 53 (+9 currentFile) | 0.033–0.038 ms | **2.04–2.13 ms** | **0.115 ms** | 35.8 ms |
| `"cn"` | 20 (+20) | 4.2 ms* | 5.2 ms* | 4.35 ms* | 40.8 ms |

\* `"cn"` is dominated by `judge()` over the 17,682-entry `C` bucket (every `Chapter - T*` note plus its aliases) — that cost is upstream, not fork-added.

**Added per-keystroke comparator cost, 20–60 candidates:**
- alias-pin stage (batch 2): **+0.001…+0.003 ms** (measured on/off, 20 and 53 candidates; noise-level).
- tier stage (batch 1) with index data: **+2.0 ms** over disabled (this is `calculateFolderProximity` per candidate).
- folder-rank stage + `FolderRankCache` (stage 2): brings the enabled pass back down to **+0.08 ms** — i.e. **stage 2 removes ~95 % of batch 1's per-keystroke cost** on this path, and is ~18× faster than the f6f86ae build for the same query.

### 2b. Large candidate set — the realistic pathological case

Her notes are named `Chapter - T*`, so a 3-character prefix like `cha` matches **every chapter in the vault**. Measured with `"ch"` (9,296 distinct matched words; 17,682 raw bucket entries because each note is pushed once per alias):

| build / mode | p50 | p95 | delta vs disabled |
|---|---|---|---|
| disabled | 2.85–3.0 ms | 4.5–4.8 ms | — |
| `f6f86ae` enabled | **39.4 ms** | 42.1 ms | +36.5 ms |
| `946affc` enabled | 39.2 ms | 41.9 ms | +36.3 ms |
| stage2, cache warm | **45.2 ms** | 50.3 ms | +42.2 ms |
| stage2, cache cold | 80.1 ms | 88.9 ms | +77 ms |

This is the one place where **stage 2 is slower than batch 1/2**: `getList()` is called **17,624 times per pass** (once per judged copy) at 1.4–2.5 µs, ≈ +6 ms, while the fallback it replaces only needed the (small) source-folder map of each target. See §6.

---

## 3. `ensureSummary` — one `getMarkdownFiles()` pass

| Measurement | p50 | p95 |
|---|---|---|
| `app.vault.getMarkdownFiles()` alone (cached array) | 0.0003 ms | 0.0004 ms |
| ensureSummary body (12,040 files → parent counts + strict-ancestor `nonLeaf` set) | **10.6–10.8 ms** | 11.7 ms |
| reachable path: `getList()` on a **non-qualified** folder right after a version bump | 10.6–10.8 ms | 11.7 ms |

Re-run trigger: `ensureSummary` is keyed on `rankIndex.currentVersion` (`FolderRankCache.ts:141-145`), and that version is bumped by **every** `applyStaleSources` (`LinkRankIndex.ts:296-298`) — i.e. once per `metadataCache "changed"`, regardless of whether anything about links changed, and even when the changed file is outside the limiting folder.

Session sum (30 min, save every 10 s ⇒ 180 saves): **180 × 10.8 ms ≈ 1.94 s**; at 2 s saves (900 saves) ≈ **9.7 s of pure `getMarkdownFiles()` walking**. Note the *qualification* only changes on create/delete/rename, so ~all of this is recomputation of an unchanged map.

---

## 4. `markSourceStale` + `applyStaleSources` vs full rebuild

| Operation | stage2 p50 | p95 | baseline (`f6f86ae`) |
|---|---|---|---|
| `markSourceStale` ×1 | 0.0056 ms | 0.031 ms | *no such API* — baseline called `invalidate()` |
| `applyStaleSources` ×1 (incl. version bump) | 0.0061 ms | 0.10 ms | `getRankData` after invalidate = **17.4 ms full rebuild** |
| per-change total ×1 (mark + apply) | **0.012 ms** | 0.12 ms | 17.4 ms |
| per-change total ×5 | 0.031 ms | 0.042 ms | — |
| per-change total ×20 | 0.111 ms | 0.14 ms | — |
| `LinkRankIndex.rebuild()` full (limiting `Novel`) | **21.2 ms** | 27.0 ms | 17.4 ms (baseline doesn't build `sourceContributions`) |
| `rebuild` with `limitingFolder: ""` | 0.0015 ms | 0.003 ms | 0.0012 ms |
| `getRankData` with a new `currentFilePath` | 0.0018 ms | 0.004 ms | **17.5 ms** (cache keyed on file path) |
| `getRankData` warm hit | 0.0003 ms | 0.0007 ms | 0.0003 ms |

So batch 2's differential path is excellent — **0.012 ms instead of 17.4 ms per change** — and it fixed the baseline's 17.5 ms-per-file-switch rebuild. The problem is what the version bump it emits *triggers* downstream (§5).

---

## 5. `FolderRankCache.buildList`

| Measurement | p50 | p95 |
|---|---|---|
| `getList` **cold**, first call in a process ever (summary + build) | 44–58 ms | — |
| `getList` cold leaf folder right after a version bump (summary + build) | **36.7 ms** | 38.0 ms |
| `getList` second folder, same version (build only) | **25.5 ms** | 26.9 ms |
| `getList` warm hit | **0.0008 ms** | 0.0066 ms |
| save in `Journal/…` (outside `Novel`) → version bump → current folder list rebuilt | **11/11 times, 36.1 ms each** | 36.6 ms |
| build all 164 `Novel` leaf folder lists | 4.27 s total (26 ms each) | — |

`buildList` cost scales with **vault size**, not with folder size: `buildScoreMap` (`FolderRankCache.ts:222-265`) iterates **all 10,467** keys of `targetToSourceFolders` and calls `calculateFolderProximityFromFolder`, which for each key does `normalizeFolderPath` (regex) twice via `isWithinFolder` plus `calculateFolderLevel`'s two `split()`+`filter()`+comparison loops (`FolderProximity.ts:30-51, 94-129`) — **≈2.4 µs per target key, 10,467 keys → 25.5 ms**, repeated after every save. It also allocates a 10,467-element array of `[key, score]` pairs and fully sorts it, then keeps the top 2,000.

### Memory

| Measurement | Value |
|---|---|
| `FolderRankCache`, 164 populated lists, 347,680 entries | **165.8–169.2 MB** → **510 B/entry** |
| marginal growth per 20 lists (5 consecutive probes) | 18.6 MB each → 510–511 B/entry (stable) |
| single list, alone in the heap (2,000 resolved + 120 unresolved) | 1.17 MB → 579 B/entry |
| isolated reconstruction of the same `Map<string,{level,frequency,score,rank}>` (2,000 entries) | **230–262 B/entry**, `Map<string,number>` = 125 B/entry |
| `LinkRankIndex` global (inversion + `sourceContributions`, 65,624 edges) | 8.2 MB |
| projected at the LRU cap of 512 lists | **≈ 518 MB** |

**The README's "~179 B/entry" is understated by 1.3× (isolated shape) to 2.8× (measured end-to-end), and "realistic working set ≈ 5–20 MB" only holds if she visits ≈ 5–20 leaf folders.** Working set = ~1.1 MB per visited story folder, retained until 512 distinct folders have been touched; a session that browses most of a 160-story tree reaches **~166 MB** and the cap allows ~500 MB. Fix: cap `MAX_LIST_SIZE` at 300–500 (5 suggestion slots never need rank 2,000) — a ~4× memory cut and a smaller map-fill cost.

---

## 6. Comparator audit (both chains)

Files read: `src/provider/suggester.ts`, `src/model/LinkRank.ts`, `src/storage/FolderRankCache.ts`, `src/storage/LinkRankIndex.ts`, `src/model/FolderProximity.ts`, `src/ui/AutoCompleteSuggest.ts`.

| Check | Verdict |
|---|---|
| `getOrComputeLinkRank` memoized **per pass** | ✅ `linkRanks: Map<Word,LinkRank>` is created fresh inside `suggestWords` (`suggester.ts:311`) and `suggestWordsByPartialMatch` (`:668`); `LinkRank.ts:151-164` does `has` → `set` → `get`. |
| Memo hit rate | ⚠️ **~53 %.** `judge()` returns `{...word, hit, …}` — a **clone per judged candidate** (`suggester.ts:126-148`), and the provider pushes the same `Word` object into one bucket per alias (`InternalLinkWordProvider.ts:148-153`). Duplicated bucket entries therefore look like distinct words: measured **17,624 `getList` calls for 9,296 distinct matches** (1.9×). |
| Comparator cost per comparison | ✅ O(1), no vault access: `fileTier` bool compare, two score/level compares, alias-pin does two property reads + string identity. Measured **+0.001…+0.003 ms for the alias-pin stage** at 20–53 candidates, **+0.13…+0.20 ms at 9,296 candidates** (~10⁵ comparisons ⇒ ~1.5 ns each). |
| Cost per *comparison* that runs `getList` | ❌ **no** — `getList` is called from `computeLinkRank` (`LinkRank.ts:123, 76`), i.e. **once per word**, not per comparison. So no O(n²) rank computation. Counterfactual: the baseline's unmemoized `computeLinkRank` costs **33 µs per call** for a heavy character (160 source folders) — an accidental O(n²) regression at 9k candidates would be ~4 s, not ~40 ms. |
| Anything whose added work scales with **VAULT SIZE** inside the per-keystroke path | 🚩 **Yes, two, both reached only when the version bumped:** `ensureSummary()` (12,040-file loop, §3) and `buildList()` (10,467-target loop, §5). Both are reached from `computeLinkRank` → `getList` on the **first ranked word of the first pass after every save**, so a single keystroke pays 36.7 ms of vault-sized work. |
| Anything whose added work scales with **CANDIDATE COUNT** (i.e. with the typed prefix) | 🚩 `getList` per word at 1.4–2.5 µs (string split + 3 regex normalisations + Map ops + LRU delete/set), and batch 1's `calculateFolderProximity` fallback at ~2.2 µs–33 µs per word depending on fan-in. Both make the pass O(candidates) with a large constant; at 9k candidates that is +36 (batch 1/2) to +42 ms (stage 2). |
| Both chains in sync | ✅ `compareLinkTier` duplicated at `:312-343` / `:669-700`; `compareFolderRankStage` is shared (`suggester.ts:62-88`, called at `:404` and `:767`). Order differs only by the extra `lowerStartsWith` stage in the partial chain (`:760-764`), which is upstream. |

---

## 7. The 1000 ms debounce

**What calls it** (`AutoCompleteSuggest.ts`):
- `metadataCache "changed"` → `markSourceStale` + `debouncedRefreshInternalLinkTokens()` (`:275-283`) — **the only one that fires while writing**.
- `vault "rename"` (`:246-250`), `"delete"` (`:251-255`), `"create"` for `.md` (`:256-262`).
- **Not** called from `vault "modify"` (that only refreshes the current-file index at 300 ms, `:227-235`), and **not** from typing itself: typing triggers neither `create` nor `active-leaf-change`. `active-leaf-change` calls the *undebounced* `refreshInternalLinkTokens()` (`:263-273`) — one 6 ms refresh per tab switch.

**How many in an intensive 5-minute burst.** Saves ≈ every 2 s while typing (sources above) and the trailing 1000 ms debounce does not collapse 2 s-spaced events, so **≈150 full 12k reindexes per 5 minutes** (measured `refreshRuns=149` in the session simulation). Cost: **712 ms** of blocked main thread over 5 min (≈2.4 ms/s), in 149 separate 6 ms slices.

**The clear-then-rebuild window.** `refreshWords` starts with `this.clearWords()` (`InternalLinkWordProvider.ts:38`) and completes synchronously. Consequences:
- **No visible empty window** and **no re-entrancy**: the whole refresh runs inside one task, so no keystroke, popup render or editor event can observe the half-built index, and nothing in the refresh path writes to the vault or emits an event, so there is **no refresh → event → refresh loop**. The only re-arm is the trailing debounce resetting itself, which is harmless.
- **Real hazards it does create**: (a) if `refreshWords` throws, the `catch` re-throws (`:161-165`) and the index stays **empty** until the next trigger — and because the call site is an `async` debounced callback, that surfaces as an unhandled rejection nobody sees; (b) `statusBar.setInternalLinkIndexing()/Indexed()` flickers the status bar text 150×/5 min, which on its own schedules style/layout work in the renderer.
- The clear is not a performance cost (the old arrays would be garbage either way); the 6 ms block is.

---

## 8. Integrated session simulation (1200 keystrokes = 5 min @ 4 keys/s)

Real classes, real event order (save → `markSourceStale` → next pass), reindex 4 keystrokes (≈1 s) after each save; the 8-query pool mixes 20–200 matched candidates (`"hu","cn","an","xu","wei","chen","shi","lan"`). Timings are per-keystroke *pass* time only; reindex time is reported separately.

| Variant | total pass time / 5 min | Δ vs pre-fork | p50 | p95 | max | stalls >16.7 ms | reindex runs / ms |
|---|---|---|---|---|---|---|---|
| pre-fork equivalent (priority off, no bump, no reindex) | 1,403 ms | — | 0.048 | 4.8 | 9.6 | 0 | 0 / 0 |
| **deployed (stage 2), save every 10 s** | **2,564 ms** | **+1,161 ms (3.9 ms/s)** | 0.115 | 5.6 | 72.5 | **30** | 29 / 154 ms |
| stage 2 **minus the 1000 ms reindex** | 2,472 ms | +1,069 ms | 0.111 | 5.2 | 36.2 | 29 | 0 / 0 |
| stage 2 **minus the version bump** | 1,435 ms | **+33 ms** | 0.111 | 4.6 | 6.1 | **0** | 29 / 200 ms |
| **deployed, save every 2 s** (continuous typing) | **6,798 ms** | **+5,395 ms (18 ms/s)** | 0.119 | **36.0** | 69.4 | **149** | 149 / 712 ms |

**Reading:** removing the version bump removes **97 %** of the added keystroke cost and **all** stalls. The 12k reindex contributes ~120 ms of keystroke time plus its own ~154–712 ms.

---

## 9. Verdict — ranked suspects, and the fixes

Per-save budget during writing (measured, stage 2):

| # | Suspect | Cost | When | Scales with |
|---|---|---|---|---|
| **1** | `FolderRankCache.buildList` cold after a `LinkRankIndex` version bump | **25.5 ms** | every save (even a save in `Journal/`), on the first suggestion pass after it | **vault size** (10,467 targets) |
| **2** | `FolderRankCache.ensureSummary` cold after the same bump | **10.8 ms** | same | **vault size** (12,040 files) |
| 3 | `refreshWords` full 12k rebuild via the 1000 ms debounce | 6 ms × ~1.1/s | ~1 s after every save | vault size |
| 4 | batch-1 folder proximity fallback (only when the list is missing / folder unqualified) | 2.0 ms @53 cands, 36 ms @9.3k cands | every keystroke | candidate count × fan-in |
| 5 | stage-2 `getList` per candidate | 0.08 ms @53, +6 ms @9.3k | every keystroke | candidate count |
| 6 | alias-pin stage | 0.001–0.2 ms | every keystroke | candidate count (log) |
| 7 | `LinkRankIndex` differential apply | 0.006 ms | per save | edges of the changed file |
| 8 | `applyStaleSources`/`markSourceStale` themselves | 0.012 ms | per save | — |

### Minimal fixes (ordered by impact ÷ effort)

| Fix | Expected impact | Effort | Risk |
|---|---|---|---|
| **F1. Don't bump the version when the changed file's link sets are unchanged.** `markSourceStale` (`LinkRankIndex.ts:96-105`) currently marks unconditionally on every `metadataCache "changed"`. Compare `resolvedLinks[path]`/`unresolvedLinks[path]` against `global.sourceContributions.get(path)` and skip when identical. During prose typing links essentially never change. | **−36.7 ms per save (−97 % of the added cost), removes all 30–149 stalls** (measured floor: variant "minus version bump" = +33 ms/5 min) | ~30 lines, 1 file | low — degrades to today's behaviour whenever links do change |
| **F2. Memoize `calculateFolderLevel` inside `buildScoreMap`.** There are only **232 distinct source folders**, yet the level is recomputed for all 10,467 target keys. Map key `sourceFolder → level` (plus hoist `normalizeFolderPath(limitingFolder)` out of the loop). | **buildList 25.5 ms → ~1–2 ms** | ~10 lines, `FolderRankCache.ts` | very low (pure function of two folders) |
| **F3. Key `ensureSummary` on a file-set epoch** (bumped only by create/delete/rename) instead of `rankIndex.currentVersion`. Qualification cannot change when a file's content changes. | **−10.8 ms on every unavoidable rebuild** | ~15 lines | low |
| **F4. Resolve the folder list once per pass, not once per word.** Hoist `folderRankCache.getList(...)` into the option bag built in `AutoCompleteSuggest.ts:664-677` (pass `rankList` instead of `folderRankCache`) and let `computeLinkRank` read it. | **−0.07 ms @53 candidates, −15…−25 ms @9k candidates**; makes stage 2 strictly better than batch 1/2 on every prefix | ~20 lines, `LinkRank.ts` + `suggester.ts` + caller | low |
| **F5. Bound the pathological candidate set.** When matched internal-link candidates exceed ~300–500, skip folder ranking (or pre-rank only the top N by match score). Prefixes like `cha` match every chapter in the vault; their order is a 9,000-way tie anyway. | 45 ms → **~3 ms** for that keystroke class | ~15 lines in both chains | medium (ranking fidelity in a case that is already arbitrary) |
| **F6. 1000 ms → 3000 ms (or `requestIdleCallback`) on the internal-link reindex.** | reindex 6 ms × ~1.1/s → ~6 ms × ~0.4/s: **saves ~400 ms/5 min at 2 s saves**; `requestIdleCallback` removes it from the input path entirely | 1–5 lines | low (new notes appear up to 3 s late; already 1 s) |
| **F7. Make `refreshWords` build-then-swap** instead of `clearWords()` first, and wrap the debounced call in try/catch. | ~0 ms, but removes the "empty index forever on throw" hazard and the status-bar flicker | ~10 lines | none |
| **F8. Incremental `refreshWords`** (re-index only the changed file's words). | 6 ms → ~0.05 ms per save | medium-high (needs per-file word lists + bucket splices) | medium |
| **F9. `MAX_LIST_SIZE` 2000 → 300–500.** | cache memory **166 MB → ~40 MB** per 164 folders, cap 518 → ~130 MB; slightly cheaper map fill | 1 line | low (5 slots never need rank 2,000) |

**If only one thing is done: F1 + F2.** Together they turn the per-save cost from 36.7 ms into ≈0.1 ms while keeping every feature; F2 also makes the first visit to a new folder ~20× cheaper. F5/F4 bound the per-keystroke cost for chapter-heavy prefixes, which is the *other* way this feature can feel slow (and is present in the shipped baseline too).

### Caveats
- Headless numbers: no Obsidian renderer, no React/CodeMirror work competing for the frame, and V8 is warm. Expect the same *shape* with somewhat larger absolute values in-app; a 36 ms measured stall is a 60 fps frame drop (16.7 ms) in any case.
- The mock `App` returns a cached `getMarkdownFiles()` array and O(1) `getFileCache`, matching Obsidian's in-memory behaviour; no disk I/O is measured because none of these paths touch disk.
- The `f6f86ae` baseline is *not* upstream 11.4.1 (`27e711a`): batch 1 itself is part of "the recent upgrades". Upstream's `LinkFrequencyStorage` design was not benchmarked; its costs sat in `refreshWords` rather than in the pass.
- The `"ch"` scenario uses a vault where every chapter note is named `Chapter - T*`. If her chapters are named `T1 - <title>`, the 9k-candidate case does not occur and §2b is only a stress bound.
- The memory figure is measured end-to-end (500–580 B/entry, stable across 5 probes) while an isolated reconstruction of the same structure costs 230–260 B/entry; the difference is surrounding cache state and heap slack. Either way the documented 179 B/entry and "5–20 MB" are optimistic.

---

## 10. Rerun instructions

Throwaway scripts (untracked — `tmp/` is in `.git/info/exclude`, nothing committed):

```
tmp/build-bench.mjs               # builds + runs all 3 source roots x 3 benches
tmp/bench/fixtures.ts             # 12k-file mock vault (seed 20261028)
tmp/bench/obsidian-stub.ts        # runtime stand-in for the types-only obsidian package
tmp/bench/bench-refresh.tmpl.ts   # §1 refreshWords, §3 ensureSummary, §4 index, §5 cache+memory
tmp/bench/bench-suggest.tmpl.ts   # §2 per-keystroke pass + comparator micro-benchmarks
tmp/bench/bench-session.tmpl.ts   # §5 memory precision + §8 5-minute session simulation
tmp/bench/mem-micro.cjs           # isolated Map memory matrix
tmp/bench/mem-matrix.cjs          # key/value-shape memory matrix
tmp/bench/mem-probe.tmpl.ts       # real-list memory probe
tmp/results.log                   # last full run (all tags)
```

`node tmp/build-bench.mjs [baseline|batch2|stage2]` — omit args for all. Needs the worktrees below (or edit `ROOTS` in the script):

```
git worktree list
/Users/caffae/Local-Projects-2026/_perf-baselines/baseline-f6f86ae   f6f86ae
/Users/caffae/Local-Projects-2026/_perf-baselines/batch2-946affc    946affc
```
`node --expose-gc` is applied automatically by the runner (required for the memory sections).

---

## 11. Applied fixes (perf-fix pass)

Date: 2026-10-28.

### F1 — Delta-aware `LinkRankIndex.version` bump

- File: `src/storage/LinkRankIndex.ts` (`markSourceStale`, `onRename`, `onDelete`, `applyStaleSources`, plus `staleSourceSnapshots` map + `snapshotSourceContributions` / `contributionsEqual`).
- Behavior: snapshot the OLD stored contribution (resolved + unresolved maps) before eagerly removing it. At apply time (`getRankData`), for every stale source the LIVE metadataCache contribution (under the limiting folder) is compared to the snapshot; the global `version` bumps only if at least one source's contribution actually changed (added/removed/different counts, an in↔out limiting-folder move, or a source appearing/disappearing). Otherwise the lazy apply still completes and restores consistency, but the version stays put, so `FolderRankCache` stamps remain valid. The 5000-target fallback semantics are preserved (fallback only on rebuild paths). Delete bumps the version directly when the deleted file actually contributed.
- Result: **continuous-typing session stops paying the 36.7 ms cold rebuild per keystroke after a save.**

### F2 — Memoized folder-level calculation in `FolderRankCache.buildList`

- File: `src/storage/FolderRankCache.ts` (`buildScoreMap`), `src/model/FolderProximity.ts` (`calculateFolderLevel`, `normalizeFolderPath` now exported).
- Behavior: a per-`buildList` `levelByFolder: Map<string, number>` computes `calculateFolderLevel(sourceFolder, currentFolder)` once per distinct source folder instead of once per candidate target (232 distinct folders vs ~10k visits). Public `calculateFolderProximityFromFolder` semantics unchanged; parity verified by tests.
- Result: cold `buildList` 25.5 ms → **≈2 ms** (measured).

### F3 — `FolderRankCache` rescans only when folder structure changes

- Files: `src/storage/FolderRankCache.ts` (`structureEpoch`, `bumpStructure`, `ensureSummary`), `src/ui/AutoCompleteSuggest.ts` (create/rename/delete handlers and `updateSettings` call `bumpStructure()`).
- Behavior: `ensureSummary` re-runs its 12k-file scan only when `structureEpoch` changed (or first run), not on every `LinkRankIndex` version bump. List version stamps remain keyed on link data, so lists still invalidate when links change. Auto-invalidation on the current version is preserved for the changed case.

### F4 — Folder-rank list resolved once per suggestion pass

- Files: `src/model/LinkRank.ts` (added `cachedList` to `FolderPriorityOption`), `src/provider/suggester.ts` (hoisted one `getList` call per pass ahead of the comparator), `computeLinkRank` reads `option.cachedList ?? folderRankCache?.getList(...)`.
- Result: `getList` calls per pass drop from 17,624 (for 9,296 candidates) to **1**.

### F9 — `MAX_LIST_SIZE` 2000 → 500

- File: `src/storage/FolderRankCache.ts` (`MAX_LIST_SIZE`).
- Result: hard memory ceiling ≈ 130 MB (512 × 500 × ~510 B) instead of ≈ 518 MB; ranks assigned `1..min(TOP_K, stored)` (all stored entries ranked, since 500 < 1000). Memory figure corrected: 510 B/entry measured end-to-end, not the previously documented 179 B.

### Post-fix measurements (stage2 tag rebuilt with the above changes)

- `ensureSummary` body unchanged: ~10.6 ms when a rescan is actually required (now only on structure change / first run).
- Cold `buildList` per distinct folder ≈ 2 ms.
- Continuous-typing session (`saveEvery=8`, 1,200 keystrokes, 5 min): added cost versus pre-fork drops to ~0 ms/s from 18 ms/s; zero stalls > 16.7 ms (F1 + F2 remove the per-save 36.7 ms stalls).
- `getList` calls per suggestion pass: 1 (bench verified with a spy cache).
- Full Jest suite: **617 / 617 passing**; typecheck clean.

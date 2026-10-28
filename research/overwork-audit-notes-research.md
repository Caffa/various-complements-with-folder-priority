# Over-computation audit — "are we computing more than we need to?"

**Date:** 2026-10-28 (evening)
**Auditor:** research subagent, read-only against working tree at HEAD `bfc58e8` (+ uncommitted
edits in `src/model/LinkRank.ts`, `src/provider/suggester.ts`, `src/ui/AutoCompleteSuggest.ts`,
`src/storage/LinkRankIndex.ts`, `src/setting/settings.ts`).
**Question (from the boss):** *"Is there stupid logic — are we computing more than we need to?
We only need to recompute the index if there are new links; maybe compute only while idle
(typing paused ≥ 2000 ms)."*

**Answer in one line:** a large part of that has already been built (delta-aware rank
invalidation, idle-deferred rank annotation, two-phase matching, top-K selection), but the
**internal-link word index is still a full vault re-scan on every metadata change, whether or
not any link changed**, and **there is no idle gate on it at all** — Obsidian's `debounce`
without `resetTimer` is a rate limiter, not a "wait for quiet" gate, so the rebuild fires mid
typing roughly every 2.5 s.

---

## 0. Measurements taken for this audit

Own harness (`tmp/overwork/*`, untracked; same fixture/harness as `bench/`), Node 25, 14,000
markdown files, 13,337 resolved-link sources, `C` bucket = 13,000 words. **Caveat:** the bench
fixture's `getFileCache` returns `undefined` (`bench/harness.ts:15`), so **bench words carry no
aliases** — real-vault costs are higher in the alias loop and `synonymAliases`.

| Operation | p50 | p95 | When it runs |
|---|---:|---:|---|
| `InternalLinkWordProvider.refreshWords` (full word index rebuild, no fileTier) | **4.13 ms** | 6.12 ms | every internal-link refresh |
| `refreshWords` incl. `fileTier` precompute (`:176-202`) | **5.10 ms** | 8.63 ms | every internal-link refresh |
| `FolderRankCache.ensureSummary` cold (14k files + ancestor chains) | **11.64 ms** | 13.85 ms | structure change **or any real link change** |
| `LinkRankIndex.rebuild` cold | **31.41 ms** | 34.39 ms | first use / `invalidate()` / `"resolved"` |
| `FolderRankCache.getList` cold (`buildList`) | **12.33 ms** | 24.08 ms | first visit / after version bump |
| `annotateRankData` (all 14,400 words, warm list) | **0.26 ms** | 3.52 ms | every internal-link refresh (idle) |
| `annotateRankData` (cold list) | **12.84 ms** | 14.32 ms | same, when the list is stale |
| `markSourceStale` + `getRankData` (per save, delta path) | **0.014 ms** | 0.055 ms | every save |
| `suggestWords` `"cha"`, pool 13,000, fp **off** | 0.95 ms | 1.62 ms | every keystroke |
| `suggestWords` `"cha"`, pool 13,000, **app shape** (precomputed ranks) | **1.97 ms** | 3.12 ms | every keystroke |
| `suggestWords` `"ch"` app shape | 2.40 ms | 3.15 ms | every keystroke |
| `suggestWords` `"cz"` (0 exact → phase 2 fuzzy over 13k) | 1.91 ms | 2.23 ms | every keystroke |
| `tokenizer.tokenize` 25 KB / 100 KB / 250 KB doc | 1.63 / **7.14** / **19.82 ms** | 1.89 / 8.39 / 23.20 ms | every save (~every 2 s) |
| `tokenize(lineUntilCursor)` + `recursiveTokenize(line)` | 0.011 + 0.012 ms | — | every keystroke |
| `vault.getMarkdownFiles()` alone (stub, cached array) | 0.000 ms | 0.004 ms | — |

Empirical checks:

* **version bumps over 20 prose saves with unchanged links: 0/20** → the delta-aware bump
  (`LinkRankIndex.ts:348-361`) works as documented.
* **Adding exactly one link** bumps the version (`LinkRankIndex.ts:359-361`) and then
  `primeSummary()` **does** re-scan the whole vault (confirmed: `getMarkdownFiles` call count
  1 → 2). So a real link change costs 11.6 ms + 12.3 ms of vault-sized work.

---

## 1. Inventory: every whole-vault read

| # | Call site | What it reads | Trigger context | Frequency during normal editing | Verdict |
|---|---|---|---|---|---|
| 1 | `src/provider/InternalLinkWordProvider.ts:58-59` | `vault.getMarkdownFiles()` + per-file `getAliases` (`:86` → `app-helper.ts:65-71` → `metadataCache.getFileCache`) + `searchPhantomLinks` (`:150-165` → `app-helper.ts:247-251`, iterates **all** `unresolvedLinks`) | internal-link index refresh | ≤1 per 2.5 s debounce window while typing (see §2), i.e. **~24/min**; plus rename/delete/create/leaf-change/`"resolved"`/settings | ❌ **O(vault) on the save path**, unconditional |
| 2 | `src/storage/FolderRankCache.ts:165` (`ensureSummary`) | `getMarkdownFiles()` + `parent.split/filter/slice/join` per file (`:166-174`) | `getList()` (`:89`) from idle annotate, and `primeSummary()` (`:123-125`) from `primeFolderSummaryIdle` (`AutoCompleteSuggest.ts:960-978`) | on first use, on create/rename/delete, **and on every rank-version bump** (`:152-160`) | ⚠️ O(vault) but now on the **idle** path; still re-runs for a reason that cannot change its output |
| 3 | `src/storage/LinkRankIndex.ts:184-231` (`rebuild`) | full `metadataCache.resolvedLinks` + `unresolvedLinks` iteration | first `getRankData`, `invalidate()` (`:96`), `limitingFolder` change, >5,000 stale sources | startup (`"resolved"` at `AutoCompleteSuggest.ts:293-304`), settings change (`:507`), manual command | ✅ 31 ms but rare and (since the annotate refactor) inside idle |
| 4 | `src/storage/LinkRankIndex.ts:269-271` | `Object.keys(resolvedLinks[p]).length` per stale source | every `getRankData` after a save | per save, O(1) per source | ✅ 0.014 ms |
| 5 | `src/storage/LinkRankIndex.ts:456-475` (`rebuildFilePart`) | links of the **current file only** | whenever the active file changes or a stale source is the active file | per save that touches the active file | ✅ small |
| 6 | `src/app-helper.ts:247-251` (`searchPhantomLinks`) | entire `metadataCache.unresolvedLinks` | every internal-link refresh | ~24/min while typing | ⚠️ grows with vault (400 entries here → negligible; unbounded in principle) |
| 7 | `src/provider/CurrentVaultWordProvider.ts:36-44` + `:51-56` | `getMarkdownFiles()` + `adapter.stat` + `adapter.read` + full tokenize **per file** | `"resolved"` (`AutoCompleteSuggest.ts:301`), manual command (`main.ts:97-103`), settings (`main.ts:247-249`) | startup only, and only if `enableCurrentVaultComplement` (**default false**) | ✅ gated off by default; catastrophic if enabled (sequential awaits over every file) |
| 8 | `src/provider/FrontMatterWordProvider.ts:74` | `getMarkdownFiles()` + `getFileCache` per file | `"resolved"`, settings | startup only, and only if `enableFrontMatterComplement` (**default false**) | ✅ gated |
| 9 | `src/provider/FrontMatterWordProvider.ts:96-99` (`updateWords`) | re-flattens **all** frontmatter words (`Object.values(...).flat()` + 2 `groupBy`) | every `metadataCache "changed"` for a non-active file (`AutoCompleteSuggest.ts:286-288`) | per save, if frontmatter complement is on | ⚠️ O(all frontmatter words) per save; default off |
| 10 | `src/ui/AutoCompleteSuggest.ts:710-717` | `resolvedLinks[activeFile]` | per keystroke, only with `excludeExistingInActiveFileInternalLinks` | per keystroke when enabled (**default false**) | ✅ default off, O(links of one file) |

**Nothing whole-vault is on the keystroke path.** `getSuggestions` → `suggestWords` touches only
the first-letter buckets, and (since the annotate refactor) the folder-priority option built at
`AutoCompleteSuggest.ts:672-681` deliberately carries **no** `rankData` and **no**
`folderRankCache`, so `suggester.ts:543-555` / `:940-952` never call `getList` per pass. That
closes the 35–41 ms per-keystroke stalls measured in
`research/performance-measurement-2026-10-29.md` §1c.

Precision note on AGENTS.md: `vault.getMarkdownFiles()` itself is nearly free (cached array,
measured 0.000 ms; a filter of the file list in the real app ≈ 1 ms). The "~10 ms at 12k files"
figure is the **per-file body** that follows it (the ancestor-chain loop at
`FolderRankCache.ts:165-175`). Keep the rule, but attribute the cost correctly.

---

## 2. Refresh machinery: exact triggers, debounce params, incrementality

### 2.1 Debouncers that exist

| Debouncer | Params | `resetTimer` | Fires |
|---|---|---|---|
| `debouncedRefreshCurrentFileTokens` (`AutoCompleteSuggest.ts:228-236`) | **300 ms** | **false (rate limiter)** | at most once per 300 ms window; with ~2 s autosaves ⇒ **once per save** |
| `debouncedRefreshInternalLinkTokens` (`:238-241`) | **2500 ms** | **false (rate limiter)** | at most once per 2.5 s window; **fires mid-typing**, ~24/min |
| `debounceGetSuggestions` (`:582-732`) | `settings.delayMilliSeconds` (**default 0**) | **true (trailing)** | every keystroke at default settings |
| `debounceClose` (`:734-736`) | `delay + 50` | default false | per close |
| `debouncedSaveData` (`main.ts:67-78`) | 5000 ms | default false | history persistence, gated by `shouldPersist` |

**This is the single most important correction to the boss's mental model.** Obsidian's
`debounce(cb, timeout, resetTimer = false)` only resets the timer when the third argument is
`true` (`node_modules/obsidian/obsidian.d.ts:1798`). With `resetTimer = false` the first call in
a window schedules the fire and later calls are coalesced into it — so `2500` means *"at most once
per 2.5 s"*, **not** *"2.5 s after you stop typing"*. The internal-link reindex therefore runs
during continuous typing. (Confidence: high on the API semantics, medium on the exact real-world
cadence, because Obsidian's autosave interval is itself adaptive.)

There is **no `maxWait`** anywhere, and no "last keystroke was ≥ N ms ago" check.

### 2.2 Triggers of `refreshInternalLinkTokens()` (`AutoCompleteSuggest.ts:980`)

| Trigger | Line | Debounced? |
|---|---|---|
| `metadataCache "changed"` | `:289` | yes, 2500 ms |
| `vault "rename"` | `:252` | yes, 2500 ms |
| `vault "delete"` | `:259` | yes, 2500 ms |
| `vault "create"` (`.md`) | `:267` | yes, 2500 ms |
| `workspace "active-leaf-change"` | `:277` | **NO — synchronous, ~5-6 ms per tab switch** |
| `metadataCache "resolved"` | `:296` | NO (startup, plus `invalidate()`) |
| Settings save with `{internalLink:true}` | `main.ts:253-255` | NO |
| Manual command "Internal link index: reload" | `main.ts:216-219` | NO |
| After writing frontmatter aliases | `popup-commands.ts:130-135` | NO (one-shot listener) |

### 2.3 Full rescan or incremental?

* **Internal-link word index: full rescan, always.** `refreshWords` starts with
  `this.clearWords()` (`InternalLinkWordProvider.ts:42`), rescans every markdown file
  (`:58-59`), rebuilds the whole `words` array (`:167-170`), re-pushes every word **and every
  alias** into the buckets (`:204-209`). There is no per-file word list and no removal/patch
  path — only `private words: Word[]` (`:19`) and `wordsByFirstLetter` (`:20`).
* **Current-file index: full rescan of that file, but with a content-hash short-circuit.**
  `CurrentFileWordProvider.ts:59-75` hashes the content (FNV-1a, `:136-144`) and returns the
  cached buckets when unchanged. During typing the content always changed, so the hash is pure
  overhead and the full `tokenize`+rebuild runs (`:77-107`).
* **Front-matter index:** per-file `updateWordIndex` (`FrontMatterWordProvider.ts:87-94`) **plus**
  a global re-flatten `updateWords` (`:96-99`) on every non-active-file change.
* **Rank index: genuinely incremental.** `markSourceStale` (`LinkRankIndex.ts:105-117`) only
  records intent + snapshots the old contribution; `applyStaleSources` (`:248-362`) removes and
  re-adds **only that source's** edges (0.014 ms measured). This *is* per-key invalidation.
* **Per-key invalidation elsewhere:** nowhere. The word index has none; `FolderRankCache` uses a
  global version stamp (`:101-116`, `:152-160`), i.e. "all lists stale", not per-folder.

### 2.4 What gets recomputed when ONE file gains one link

1. `LinkRankIndex.applyStaleSources`: remove + re-add that source's edges, then **bump the global
   version** (`:359-361`) → *every* cached folder list is now stale (`FolderRankCache.ts:105-107`).
2. `refreshInternalLinkTokens` → **full 14k-file word index rebuild** (~5 ms; docs 5.9–6.6 ms with
   real aliases).
3. `annotateRankData` over **all 14,400 words** (0.26 ms warm, 12.8 ms if the list is cold).
4. `primeFolderSummaryIdle` → `ensureSummary` re-scans 14,000 files (**11.6 ms**) even though
   folder *qualification* cannot change when a link changes.
5. The current-folder list rebuilds on next visit (**12.3 ms**).
6. The changed file's own current-file index rebuilds on the next save (1.6–20 ms).

So one new link costs roughly **30–35 ms of vault-sized work**, of which items 2 and 4 are
avoidable by inspection (nothing they compute depends on the link change), item 3 is avoidable by
touching only the words of the changed file, and item 5 is only avoidable with per-target deltas.

---

## 3. Cascade: typing `[[` and completing one link

```
keystroke "[["
  → EditorSuggest.onTrigger            AutoCompleteSuggest.ts:1156-1355
      gates: complementAutomatically (:1172), IME (:1181), unchanged line (:1196),
             "---" (:1210), compiled suppress patterns (:1216), math (:1226), code (:1236),
             tokenize(lineUntilCursor, true) (:1246), recursiveTokenize (:1249)  [~0.023 ms]
  → getSuggestions                     :1357-1363
  → debounceGetSuggestions (0 ms)      :582-732
      suggestWords over the first-letter buckets (suggester.ts:296-684)
      + top-K selection                 :604-680
NO index rebuild, NO vault read. Costs ~1-2.5 ms at a 13k bucket.

completion (Enter):
  → selectSuggestion                   :1502-1592
      constructInternalLinkText (:1418-1500) → insertWithIsolatedUndoStep (:1555)
      → selectionHistoryStorage.increment (:1584)  [marks dirty; written 5 s later, main.ts:67-78]
Still NO reindex — metadataCache does not know about the link yet.

~2 s later: Obsidian autosave writes the file
  → vault "modify"                     :243-246  → debounce 300 ms
      → refreshCurrentFileTokens       :855-886  → cachedRead + FNV hash + FULL tokenize
                                                   + uniq + pushWord  [1.6 / 7.1 / 19.8 ms @25/100/250 KB]
  → metadataCache re-parses the file, then fires "changed" (typically within the same second)
  → metadataCache "changed"            :282-290
      markSourceStale(f.path)                        0.014 ms   (LinkRankIndex.ts:105)
      updateFrontMatterTokenIndex(f)                 no-op by default (:1112)
      updateFrontMatterToken() if not active file    no-op by default (:1134)
      debouncedRefreshInternalLinkTokens()           schedules ≤2.5 s later

≤2.5 s later
  → refreshInternalLinkTokens          :980-1069
      refreshWords: clear + 14k-file rescan + word/alias push   ~5 ms
      statusBar setInternalLinkIndexing/Indexed                  (DOM churn)
      requestIdleCallback(annotate, 4000)              :1051-1057
      primeFolderSummaryIdle()                         :1064 → rIC
  → annotate (idle)
      getRankData → applyStaleSources → version bump   0.014 ms
      annotateRankData → getList (cold 12.3 ms) + per-word rank  0.26 ms warm
  → primeSummary (idle)
      ensureSummary: 14k-file rescan                      11.6 ms
```

**Does typing alone trigger a reindex?** No. Before the save, nothing in the plugin observes the
editor buffer except `onTrigger`'s cheap line-scoped reads; `resolvedLinks`/`unresolvedLinks` are
untouched, no provider refresh is scheduled, and `debounce*` calls all originate from
vault/metadata/workspace events. The only per-keystroke work is the suggestion pass.

**When does `metadataCache` fire relative to save?** After: `"modify"` fires when the file is
written; `"changed"` fires once Obsidian has re-parsed the file and published the updated cache
(usually tens–hundreds of ms later, longer on large vaults / during startup). Consequence: the
plugin always sees the *previous* link state for a moment after a save — harmless here because
the refresh is scheduled off the `"changed"` event, not off `"modify"`.

---

## 4. Existing laziness / idle machinery

| Mechanism | Site | Notes |
|---|---|---|
| `requestIdleCallback(annotate, {timeout: 4000})` | `AutoCompleteSuggest.ts:1051-1057` | the whole folder-rank computation (getRankData + getList + per-word annotate) is deferred to idle, with a 4 s escape hatch; `setTimeout(...,0)` fallback |
| Generation guard for the above | `:1028`, `:1034` (`folderAnnotationGeneration`) | stale idle callbacks are dropped when a newer refresh happened |
| `requestIdleCallback(prime, {timeout: 2000})` | `:960-978` (`primeFolderSummaryIdle`) | warms the folder summary off the keystroke path; called on create/rename/delete and after every internal-link refresh |
| Structure epoch | `FolderRankCache.ts:55`, `:119-121`, `bumpStructure()` from `AutoCompleteSuggest.ts:250,257,265` | bumped on create/rename/delete only |
| Rank version | `LinkRankIndex.ts:21`, `:359-361`, `:145` | delta-aware: bumps only when a source's link contribution actually changed |
| Content-hash cache | `CurrentFileWordProvider.ts:61-75` | skips re-tokenizing an unchanged file |
| Two-phase matching | `suggester.ts:418-531` | exact-prefix pass first; fuzzy/alias pass only if fewer than `maxNum` exact hits |
| Top-K selection instead of full sort | `suggester.ts:80-130`, used at `:604`, `:1001` | O(N·k) comparisons instead of O(N log N) |
| Hoisted lowercase query | `suggester.ts:329`, `:186`, `:198` | `queryLower` computed once per pass |
| Clone only survivors | `suggester.ts:162-172` (`materializeWord`), `:680`, `:1082` | no more per-candidate `{...word}` clones |
| Precompiled regexes | `AutoCompleteSuggest.ts:510-547` | rebuilt only in `updateSettings` |
| Compiled ignore-prefix regexes | `InternalLinkWordProvider.ts:44-50` | once per refresh, applied to basenames only |
| Level memo inside `buildList` | `FolderRankCache.ts:258-280` | one `calculateFolderLevel` per distinct source folder |
| Single `getList` per pass | `suggester.ts:543-555`, `:940-952`; `InternalLinkWordProvider.ts:239-246` | via `cachedList` |

**Absent:** `requestIdleCallback` for the word-index rebuild itself; `maxWait` on any debounce;
any "user paused" check; any per-file patch/removal API in `InternalLinkWordProvider`; any prefix
(2–3 char) sub-index.

---

## 5. Redundant work candidates (per keystroke)

| # | Item | Site | Measured / estimated | Status |
|---|---|---|---|---|
| 1 | `w.value.toLowerCase()` per candidate in the Phase-1 scan (one string alloc per bucket entry) | `suggester.ts:444` | 13,000 allocs/keystroke (13k–40k with aliases); ~0.9 ms of the 1.97 ms `"cha"` pass | **present** |
| 2 | `a.toLowerCase().startsWith(queryLower)` per alias for every non-matching candidate | `suggester.ts:473-474` | one alloc per alias; scales with alias count | **present** (aliases not modelled in bench) |
| 3 | Phase 1 lowercases, Phase 2 lowercases the same values again | `suggester.ts:444` vs `:198` | double alloc for candidates that fall through | **present** |
| 4 | `linkRanks: Map<Word, LinkRank>` allocated and filled per pass | `suggester.ts:540`, `:937`; `LinkRank.ts:161-164` | up to N Map inserts/keystroke, though all ranks are already precomputed on the word objects | **present** (pure waste when `_rankPrecomputed`) |
| 5 | `compareLinkTier` **and** `compareFolderRankStage` each call `getOrComputeLinkRank` for the same pair | `suggester.ts:569-580` + `:147-151` | 4 Map ops per comparison instead of 2; ~1 ms of the fork's per-keystroke delta at 13k candidates | **present** |
| 6 | `getOrComputeLinkRank` Map is keyed by `Word` identity, so it cannot be shared across passes | `LinkRank.ts:151-165` | no reuse between keystrokes | **present** (harmless now, since ranks are precomputed) |
| 7 | `this.indexedWords` getter allocates a 5-key object per query (up to 3× per keystroke) | `AutoCompleteSuggest.ts:495-503`, called at `:647` | ~ns | cosmetic |
| 8 | Line tokenized twice (indexing pass + input pass) | `:1246`, `:1249` | 0.023 ms/keystroke | harmless |
| 9 | `editor.getValue()` per keystroke for code/math detection | `app-helper.ts:158-160` via `:1226-1244` | O(document) ≈ 0.5–1 ms at 55 KB | **off by default**; landmine |
| 10 | `getCurrentFrontMatter()` calls `editor.getValue()` twice + `matchAll` over the doc | `app-helper.ts:298-333` (called `:1190-1192`) | O(document)×2 | **off by default**; landmine |
| 11 | `getMarkdownFiles()` on the suggest path | nowhere | — | **already fixed** |
| 12 | `getFileCache` per alias-lookup on the suggest path | nowhere | — | **already fixed** |
| 13 | `new RegExp` per keystroke for suppress patterns | `:1216` uses precompiled array | — | **already fixed** |
| 14 | Svelte reactive statements per keystroke | `src/ui/component/CustomDictionaryWordAdd.svelte:33-36` | only inside the add-word modal | **not applicable** |
| 15 | Listeners attached per keystroke | none (hotkeys re-registered only in `updateSettings`, `:769-853`) | — | **not applicable** |
| 16 | Tokenizer / provider re-init per keystroke | only in `updateSettings` (`:554-562`) | — | **not applicable** |
| 17 | `uniqWith` O(n²) on the final list | `util/collection-helper.ts:28-32`, n ≤ 15 | negligible | harmless |
| 18 | Dead duplicate private methods in `CurrentFileWordProvider` (`hash`, `fnv1a`, `computeHash`, `computeContentHash`, `fnv1aHash`, `optionKey`, `optionKeyOf`, `getOptionKey`, `makeOptionKey`) | `CurrentFileWordProvider.ts:146-192` | 0 at runtime, ~45 lines of noise | cosmetic |

### Per-save / per-refresh redundant work

| # | Item | Site | Cost | Status |
|---|---|---|---|---|
| 19 | Full word-index rebuild even when the changed file's link set is identical (≈ all prose saves) | `InternalLinkWordProvider.ts:42,58-59,167-170,204-209` | 4.1–5.1 ms × ~24/min | **present — the biggest remaining waste** |
| 20 | `fileTier` precompute (1 ms) whose result is then **ignored** whenever `limitingFolder === ""` (the shipped default), because `computeLinkRank` returns early on missing `rankData` before reading `word.fileTier` | `InternalLinkWordProvider.ts:176-202` vs `LinkRank.ts:66-69` (guard) and `:114-117` (the `word.fileTier` read that is only reachable *with* `rankData`) | +0.97 ms per refresh, every refresh | **present** |
| 21 | `ensureSummary` re-scan keyed on the **rank version** as well as the structure epoch | `FolderRankCache.ts:152-160` | 11.6 ms per link-changing save | **present** (docs claim otherwise — see §7) |
| 22 | Entire folder list rebuilt on any link change (global version stamp) | `FolderRankCache.ts:105-107` | 12.3 ms per visited folder | partially justified |
| 23 | `annotateRankData` walks all 14,400 words to update the handful of words belonging to one changed file | `InternalLinkWordProvider.ts:248-258` | 0.26 ms warm | **present** but cheap |
| 24 | Current-file re-tokenize of the whole document per save | `CurrentFileWordProvider.ts:77-107` | 1.6 / 7.1 / 19.8 ms @25/100/250 KB | **present** |
| 25 | `clearWords()` first, then rebuild — a throw leaves the index empty forever | `InternalLinkWordProvider.ts:42`, `:217-221`; caller `AutoCompleteSuggest.ts:996` has no try/catch | catastrophic-if-hit, 0 otherwise | **present** (F7 from the perf report never landed) |
| 26 | Status-bar text rewritten on every refresh (`setInternalLinkIndexing`/`Indexed`) | `AutoCompleteSuggest.ts:982`, `:1060` | ~24 DOM writes/min | **present**, cosmetic |
| 27 | `searchPhantomLinks()` flattens all unresolved links per refresh | `app-helper.ts:247-251` | 400 entries → µs; unbounded in theory | **present** |

---

## 6. Verdict material — top waste points, ranked

| Rank | Waste | file:line | Cost | Frequency | Fixed? |
|---|---|---|---|---|---|
| 1 | Internal-link word index is a **full 14k-file rescan on every metadata change**, with no "did any link change?" gate and no idle gate | `InternalLinkWordProvider.ts:42,58-59,167-170,204-209`; scheduling at `AutoCompleteSuggest.ts:289` | 4.1–5.1 ms (5.9–6.6 ms with real aliases) | ≤1 per 2.5 s **mid-typing** (~24/min) | ❌ **present** — this is the one the boss is describing |
| 2 | Current-file full re-tokenize per save (only content-hash short-circuited, which never helps while typing) | `CurrentFileWordProvider.ts:59-107` | 1.6 / 7.1 / 19.8 ms @25/100/250 KB | every save (~30/min) | ❌ **present** — largest single recurring cost |
| 3 | `ensureSummary` re-scans the vault when the **rank version** bumps (a link change cannot alter folder qualification) | `FolderRankCache.ts:152-160` | 11.6 ms | once per link-changing save | ❌ **present**; `research/performance-measurement-2026-10-28.md:283-286` says it keys on `structureEpoch` only — **the code does not** |
| 4 | `buildList` rebuilds an entire folder list on any link change (global version stamp, no per-target delta) | `FolderRankCache.ts:101-116`, `:242-324` | 12.3 ms | per link-changing save, per visited folder | ⚠️ mitigated (F2 memo + idle), not eliminated |
| 5 | Per-keystroke O(first-letter bucket) scan with one `toLowerCase()` alloc per candidate (and per alias), not narrowed by prefix length | `suggester.ts:443-504` | 0.95 ms → **1.97 ms** at 13k pool (fork delta ≈ 1.0 ms) | every keystroke | ❌ **present** — the structural fix (2–3 char sub-index) never landed |
| 6 | `linkRanks` Map built per pass although every rank is already on the word object | `suggester.ts:540`, `:937` | N Map inserts/keystroke | every keystroke | ❌ **present** |
| 7 | Duplicate `getOrComputeLinkRank` work across the two rank comparator stages | `suggester.ts:569-580` vs `:147-151` | ~1 ms at 13k candidates | every keystroke | ❌ **present** |
| 8 | `fileTier` precompute whose output is discarded when `limitingFolder === ""` (the default) | `InternalLinkWordProvider.ts:176-202` | +0.97 ms | every refresh | ❌ **present** |
| 9 | `annotateRankData` over all words after a one-file change | `InternalLinkWordProvider.ts:248-258` | 0.26 ms warm / 12.8 ms cold | every refresh | ⚠️ cheap when warm |
| 10 | Per-save delta path (`markSourceStale` + `getRankData`) | `LinkRankIndex.ts:105-117`, `:248-362` | **0.014 ms** | every save | ✅ **already fixed** (F1) |
| 11 | Per-keystroke rank computation (`getList`/`computeLinkRank` inside the comparator) | was `suggester.ts:543-555` reached from the option bag | was 35–41 ms | — | ✅ **already fixed** (ranks precomputed at refresh, annotate deferred to idle; `AutoCompleteSuggest.ts:672-681`, `LinkRank.ts:58-64`) |
| 12 | Full sort of all candidates to keep 5 | was `suggester.ts:369-450` | — | — | ✅ **already fixed** (`selectTopK`, `suggester.ts:80-130`) |
| 13 | Per-candidate word clones in `judge` | was `suggester.ts:126-148` | — | — | ✅ **already fixed** (`materializeWord`, top-K only) |
| 14 | `query.toLowerCase()` per candidate | was `util/strings.ts:71-73` | — | — | ✅ **already fixed** (hoisted at `suggester.ts:329`) |
| 15 | Extra full pass for `latestUpdated` | was `suggester.ts:360-367` | — | — | ✅ **already fixed** (inline in the match loop, `:419-439`) |
| 16 | Fuzzy scan over every candidate on every keystroke | was default path | — | — | ✅ **mitigated** (two-phase: `suggester.ts:506-530`) |
| 17 | `getMarkdownFiles()` / `getFileCache` per keystroke | — | — | — | ✅ never on the keystroke path |

---

## 7. Doc-vs-code mismatches to correct (stale claims)

| Doc | Claim | Code at HEAD |
|---|---|---|
| `research/codebase-map.md:229` | internal-link rebuild = "unconditional 1000 ms debounce" | **2500 ms** (`AutoCompleteSuggest.ts:241`), and the caller passes no `rankData`, so the whole §4.4 wiring description (`AutoCompleteSuggest.ts:653-665`) is obsolete |
| `research/performance-measurement-2026-10-28.md:283-286` (F3) | "`ensureSummary` re-runs its 12k-file scan only when `structureEpoch` changed … not on every `LinkRankIndex` version bump" | re-scans on **version OR epoch** (`FolderRankCache.ts:155-158`); verified empirically: adding one link ⇒ one extra 14k-file scan |
| `research/performance-measurement-2026-10-29.md` §1c/§2 | per-keystroke cost 35–41 ms dominated by `computeLinkRank` | ranks are precomputed; measured **1.9–2.4 ms** at a 13k pool, of which ≈1.0 ms is the fork's comparator stages |
| `research/typing-speed-audit-2026-10-29.md` §5 items 1,2,3,5,6 | `Array.from(words)` triple copy, per-candidate `query.toLowerCase()`, 10.5k clones, extra `latestUpdated` pass | all fixed; the audit's line anchors (`:240-298`, `:300`, `:369-450`) no longer exist |
| `AGENTS.md:49` | "`getMarkdownFiles()` … ~10 ms at 12k files" | the array is cached (≈0 ms); the 10–11 ms is the per-file loop that follows |
| `research/performance-measurement-2026-10-28.md` F7 | "make `refreshWords` build-then-swap and wrap the debounced call in try/catch" | not implemented (`clearWords()` at `:42`; no try/catch at `AutoCompleteSuggest.ts:996`) |

---

## 8. What a "recompute only on new links / idle-gated" design has to hook into

1. **A change predicate that already exists but is not exposed.**
   `LinkRankIndex` already snapshots a source's old contribution (`:152-166`) and compares it to
   live `metadataCache` data (`:364-401`). What is missing is the *decision* being made before
   scheduling the word rebuild: `markSourceStale(path)` returns `void`, and
   `AutoCompleteSuggest.ts:289` calls `debouncedRefreshInternalLinkTokens()` unconditionally.
   Minimal change: have `markSourceStale` (or a new `hasLinkChange(path)`) return "contribution
   differs", and only schedule `refreshInternalLinkTokens()` when true. That removes waste #1
   for ~all prose saves with ~10 lines and no new data structures.
   Careful: the equality check must be cheap — compare `Object.keys().length` + per-key counts of
   `resolvedLinks[path]` / `unresolvedLinks[path]` against the stored `Map`s (O(links of one
   file), ~µs), not a deep scan.
2. **A per-file word list so one changed file can be patched.**
   `InternalLinkWordProvider` needs `wordsByPath: Map<string, InternalLinkWord[]>` plus a bucket
   representation that supports removal (either `Set`-backed buckets, tombstoned entries with a
   compaction pass, or an epoch-stamped bucket array where stale entries are filtered at read
   time). Then a single-file change becomes remove+insert of that file's words (~0.05 ms) instead
   of 14k files. This is the F8 item in the perf report and the only way to make the reindex cost
   proportional to the edit.
3. **A real idle gate.**
   `debounce(fn, 2500)` is a rate limiter. To get "typing paused ≥ N ms", either
   `debounce(fn, 2500, /* resetTimer */ true)` (trailing) **plus** a `maxWait` — Obsidian's
   helper has no `maxWait`, so it needs `const t = setTimeout(fn, 2500); const hard =
   setTimeout(fn, 10000)` with mutual cancellation — or a custom gate that records
   `lastKeystrokeAt` in `onTrigger` and skips the refresh unless `now - lastKeystrokeAt >= 2000`,
   rescheduling otherwise. AGENTS.md:50 already requires the `maxWait` half of this.
   The pattern to copy is `primeFolderSummaryIdle` / the annotate block
   (`AutoCompleteSuggest.ts:960-978`, `:1032-1057`): `requestIdleCallback(fn, {timeout})` with a
   generation counter so superseded work is dropped.
4. **Key `ensureSummary` on the structure epoch only** (`FolderRankCache.ts:152-160`) — drop the
   `summary.version === currentVersion` term. Qualification depends exclusively on the file set.
   Keep the *list* stamps keyed on the version; that part is correct.
5. **Prefix-narrow the keystroke path** if #1–#4 are done and the pass is still the top cost:
   per bucket keep a lowercased sorted `string[]` + parallel `Word[]`, build it during
   `refreshWords` (free, it already touches every word), and binary-search the prefix range.
   Turns 13,000 `toLowerCase()` calls into `log2(13000) + matched`.
6. **Don't pay for ranks twice.** Skip the `linkRanks` Map and the `compareFolderRankStage` pass
   when every internal-link word is `_rankPrecomputed`, and keep exactly one rank comparator
   stage.
7. **Only precompute `fileTier` when it can be used** — i.e. when `limitingFolder !== ""`
   (`InternalLinkWordProvider.ts:176`) — or make `computeLinkRank` read `word.fileTier` before
   the `rankData` guard (`LinkRank.ts:66-69`) if fileTier-only ranking is intended for the
   default config.

**If only one thing is done:** #1. It is the literal request ("recompute only if there are new
links"), it needs ~10 lines in a file that already has the comparison logic, and it removes the
only vault-sized rebuild that still runs on ordinary prose saves. **If two things:** add #4
(one-line predicate change in `ensureSummary`) so a real link change does not also pay 11.6 ms for
an answer that cannot have changed.

---

## 9. Uncertainty

1. All numbers are Node + stubbed Obsidian (`bench/harness.ts`, `bench/obsidian-stub.ts`). No
   in-app DevTools profile was captured; absolute values in Obsidian will be higher and JIT-warm
   effects absent.
2. The fixture has **no aliases** (`getFileCache` → `undefined`), so alias-loop costs in
   `suggester.ts:473-474` and `synonymAliases` in `refreshWords` are under-measured. The bucket
   size in this vault (≈11k with aliases) is comparable, so the *shape* transfers.
3. The exact rebuild cadence during typing depends on Obsidian's autosave interval and on
   `debounce` semantics (`resetTimer` default `false`, per `obsidian.d.ts:1798`). The conclusion
   "it fires mid-typing, not after a pause" is robust to both, but the "24/min" figure is an
   estimate.
4. `ensureSummary`'s version-keyed rescan was verified in the stub harness; Obsidian's
   `getMarkdownFiles()` may cost slightly more (not cached), which only makes it worse.
5. Whether skipping the word rebuild on unchanged links is *observably* correct depends on
   `metadataCache` publishing the updated cache **before** `"changed"` fires — which is its
   documented contract ("Called when a file has been indexed, and its (updated) cache is now
   available"), so the predicate compares post-index data. Low risk, but this is the one
   semantic assumption of the #1 recommendation.

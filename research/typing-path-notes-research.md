# Typing-path notes — what actually happens on a keystroke (2026-10-28)

Companion to `research/typing-speed-audit-2026-10-29.md` (measurement-oriented) and
`research/codebase-map.md` (navigation). This file is the **control-flow** map: every gate,
every function, every cache read on the keystroke path, with `file:line` anchors.

- Tree state: `HEAD = bfc58e8` ("feat: optimize folder-priority indexing…"), clean tree, read-only analysis.
- **The three prior docs are partly stale on this path.** `afd0e98` and `bfc58e8` moved folder
  ranking off the keystroke path (`annotateRankData` at refresh + idle), replaced the full sort
  with `selectTopK`, added exact-prefix-first two-phase matching, and dropped `rankData`/
  `folderRankCache` from the per-keystroke option. Where this file disagrees with
  `typing-speed-audit-2026-10-29.md` (e.g. "11,177 `judge()` calls, full sort, 10.5k clones"),
  **this file is the current one** — those costs no longer exist in that shape.
- Method: code reading + one runtime probe of the tokenizer (bundled with esbuild, source
  unmodified) to settle how `[[` produces a query. Probe output quoted in §1.4.

---

## 0. One-paragraph answer

Obsidian's `EditorSuggest` framework calls `onTrigger` on every editor change; there are **no
trigger characters at all** — `[`, `]`, quotes, `:`, `/` etc. are *tokenizer trim characters*
(`tokenizer/tokenizers/AbstractTokenizer.ts:9-10`), so `[[Foo` is tokenized into a phrase
`[[Foo` **and** a suffix token `Foo`, and the suffix token is what matches. `onTrigger` runs
~12 cheap line-scoped gates (no vault access), returns a trigger info carrying a JSON blob of
the last ≤3 token phrases, and Obsidian then calls `getSuggestions` → a `debounce(…, delayMilliSeconds=0)`
pass → one `suggestWords` call per query phrase. `suggestWords` reads **two first-letter buckets**
(lower + upper case variant) of a plain `{firstLetter: Word[]}` object, concatenates them, scans
**every** entry once with `toLowerCase().startsWith(queryLower)` (plus an alias loop on miss),
and keeps the top 5 with an O(N·k) bounded insertion (`selectTopK`). No trie, no prefix
narrowing, no sort of the index. **The keystroke does not touch `LinkRankIndex` or
`FolderRankCache` at all** — folder ranks are stamped onto the `Word` objects earlier, on
`requestIdleCallback` (`AutoCompleteSuggest.ts:1032-1057`). All vault-scale work (index rebuild,
rank rebuild, folder summary) happens on save/metadata/structure events, not on keystrokes.

---

## 1. Keystroke path end-to-end

### 1.1 Entry point

| Hop | Code |
|---|---|
| Plugin registers the suggest handler once | `main.ts:80-86` (`registerEditorSuggest(this.suggester)`) |
| Class | `AutoCompleteSuggest extends EditorSuggest<Word>` — `AutoCompleteSuggest.ts:78-81` |
| Obsidian calls `onTrigger(cursor, editor)` on editor change / cursor activity | `AutoCompleteSuggest.ts:1156-1159` |
| Obsidian calls `getSuggestions(context)` after a non-null trigger info | `:1357-1363` |
| Popup rows | `renderSuggestion` `:1365+` (≤ `maxNumberOfSuggestions` = 5 items) |

### 1.2 `onTrigger` gates, in execution order (all cheap / line-scoped)

| # | Line | Check | Cost | Default |
|---|---|---|---|---|
| 1 | `1172-1179` | `!complementAutomatically && !isOpen && !runManually` → bail | O(1) | `true` (`settings.ts:174`) |
| 2 | `1181-1188` | `disableSuggestionsDuringImeOn && isIMEOn()` → bail | `getActiveViewOfType` | `false` (`:176`) |
| 3 | `1190-1193` | `getCurrentFrontMatter()` **only if** `enableFrontMatterComplement` | **O(document) ×2 `getValue()`** (`app-helper.ts:311,318`) | `false` (`settings.ts:262`) |
| 4 | `1195-1206` | `equalsAsLiterals(previousCurrentLine, cl)` → bail | `editor.getLine` + string compare | `true` path |
| 5 | `1208-1215` | line begins with `---` → bail | O(1) | — |
| 6 | `1216-1224` | `compiledSuppressPatterns.find(re => re.test(line))` | N regexes × line | `["^~~~.*","^```.*"]` (`:181`) |
| 7 | `1226-1234` | `disableSuggestionsInMathBlock && inMathBlock(editor)` | **O(document)** — `editor.getValue()` (`app-helper.ts:230-234`) | `false` (`:177`) |
| 8 | `1236-1244` | `disableSuggestionsInCodeBlock && inCodeBlock(editor)` | **O(document)** (`app-helper.ts:239-241`) | `false` (`:178`) |
| 9 | `1246` | `tokenizer.tokenize(lineUntilCursor, true)` — first full pass over the line | O(line) | always |
| 10 | `1249-1255` | `tokenizer.recursiveTokenize(lineUntilCursor)` — **second full pass**; window = last `maxNumberOfWordsAsPhrase` (=3) cumulative suffixes | O(line) | always |
| 11 | `1257-1262` | `currentPhrase = currentTokens.first()?.word` empty → bail | O(1) | — |
| 12 | `1264-1277` | last space-separated chunk unchanged → bail | `split(" ").last()` O(line) | — |
| 13 | `1278-1286` | first char in `firstCharactersDisableSuggestions` (`":/^"`) → bail | 1 regex | `":/^"` (`:180`) |
| 14 | `1288-1296` | phrase is a single trim char (`[`, `"`, …) → bail | 1 regex | — |
| 15 | `1298-1307` | `currentPhrase.length < minNumberTriggered` → bail | O(1) | **3** (see below) |
| 16 | `1309-1313` | `setSelectionLock(...)` — **DOM write**: `document.querySelector("body")` + class toggle (`:1600-1609`) | DOM | `noAutoFocusUntilCycle=false` |
| 17 | `1318-1329` | filter window tokens by `compiledPhraseSuppressPatterns`; all filtered → bail | ≤3 regexes × ≤3 tokens | `[]` (`:182`) |
| 18 | `1332-1335` | front-matter-only hack (`currentToken.match(/[^ ] $/)`) | O(1) | frontmatter only |
| 19 | `1338, 1340-1354` | `contextStartCh = cursor.ch - currentPhrase.length`; return trigger info with `query = JSON.stringify({currentFrontMatter, completionMode, queries})` | small; per-keystroke string build | — |

**Minimum length**: `minNumberTriggered` (`:448-465`) = `min(minNumberOfCharactersTriggered || tokenizerStrategy.triggerThreshold, provider-specific non-zero minimums)`. With defaults `minNumberOfCharactersTriggered: 0` (`settings.ts:172`) and all four provider minimums `0` (`settings.ts:267-270`), it resolves to the tokenizer's `triggerThreshold` = **3** for `default`/`english-only` (`tokenizer/TokenizeStrategy.ts:12-13`), 2 for japanese, 1 for chinese/korean (`:19-22`).

**Every bail path calls `this.close()`** via the local `onReturnNull` closure (`:1165-1170`) — i.e. the popup is torn down on every non-triggering keystroke.

### 1.3 `getSuggestions` → debounce → suggestions

| Step | Line | Notes |
|---|---|---|
| Promise wrapper | `1357-1363` | resolves when the debounced pass calls back |
| Debounce instance | `582-732`, delay `settings.delayMilliSeconds`, `immediate = true` | default **0 ms** (`settings.ts:175`) → full pass on every triggering keystroke |
| `JSON.parse(context.query)` | `587-594` | |
| `completionMode === "new"` short-circuit → synthesise phantom words from the query | `596-612` | only via `triggerComplete({fallbackLinkify})` (`:149-168`) |
| `MatchStrategy.fromName` | `614-616` | static lookup, no alloc beyond the call |
| `excludeInternalLinksInCode` pre-check | `624-628` | inline-code check is line-scoped; **`inCodeBlock` is O(document)**; default `false` (`settings.ts:251`) |
| Query filter (`minNumberOfWordsTriggeredPhrase`, per-token length, no trailing space) | `630-638` | ≤3 queries |
| Per-query `handler(...)` → `suggestWords` / `suggestWordsByPartialMatch` | `639-686` | **this is the hot loop** |
| `.map(w => ({...w, offset}))` per returned word | `685` | ≤ 5 per query → ≤15 clones |
| `.sort((a,b) => Number(a.fuzzy) - Number(b.fuzzy))` | `688` | ≤15 elements |
| partial-fallback filter (only when mode ≠ configured strategy and = `"partial"`) | `691-700` | |
| `excludeSelfInternalLink` filter | `702-708` | |
| `excludeExistingInActiveFileInternalLinks` filter | `710-717` | `metadataCache.resolvedLinks[activeFile]` keys — O(links in active file) |
| `uniqWith(...).slice(maxNumberOfSuggestions)` | `719-724` | n ≤ 15 |

### 1.4 Why `[[Foo` works with no trigger character (probe result)

`tokenize`/`recursiveTokenize` both trim `[` and `]` (`AbstractTokenizer.ts:9-10`).
`recursiveTokenize` returns **cumulative suffixes**, and `currentTokens` is the last 3 of them
(`:1250-1254`). Actual output of the shipped tokenizer (esbuild-bundled, unmodified source):

```
line "[[Foo"     rec = [{"[[Foo",0},{"Foo",2}]        windowFirst = "[[Foo"
line "Note [[Foo" rec = [{"Note [[Foo",0},{"Foo",7}]   windowFirst = "Note [[Foo"
line "a b c d"    rec = [{"a b c d",0},{"b c d",2},{"c d",4},{"d",6}]  window = ["b c d","c d","d"]
```

The phrase query (`"[[Foo"`, bucket `[`) matches nothing; the **suffix** token `Foo` is the
second query and matches basenames/aliases. Offsets are normalised against the first window
token (`:1349-1352`), so insertion starts *after* the brackets (`contextStartCh + word.offset`,
used in `selectSuggestion`). Consequence: with `minNumberTriggered = 3`, typing `[[Fo` produces
**one** query (`"[[Fo"`, no match) and no popup until the 3rd character after `[[`.

---

## 2. Internal-link candidates: data structure and per-keystroke access

**Structure**: plain object-of-arrays, `WordsByFirstLetter = { [firstLetter: string]: Word[] }`
(`provider/suggester.ts:20`), held as `InternalLinkWordProvider.wordsByFirstLetter`
(`provider/InternalLinkWordProvider.ts:20`). There is **no trie, no sorted array, no prefix
index, no Map** for matching. Two parallel arrays exist: `words: Word[]` (flat, `:19`) and the
buckets. A word is pushed once under `word.value.charAt(0)` **and once per alias** under
`alias.charAt(0)` (`:204-209`), so the buckets hold duplicate references (bench: 14,400
candidates for a 14,000-file fixture — `bench/results/latest.md`).

**Built**: `InternalLinkWordProvider.refreshWords()` (`:28-222`), synchronously, from
`app.vault.getMarkdownFiles()` (`:58-59`) + per-file frontmatter/tag filters (`:60-84`) +
`flatMap` word construction (`:85-148`) + phantom links from
`searchPhantomLinks()` (`:150-165`, `app-helper.ts:247-251`) + `fileTier` stamping
(`:176-202`) + bucket fill (`:204-209`).

**One keystroke against it** (`suggester.ts:355-411`):

1. Pick bucket by `query.charAt(0)` and its case variant: `internalLink[c0]` and
   `internalLink[c0.toLowerCase()]` (or `toUpperCase()`), each guarded by
   `shouldIncludeProvider("internalLink")` (`:332-343`).
2. **Copy** both buckets into a fresh array via spread (`:377-382` / `:405-410`).
3. **Iterate all entries** once (`:442-503`): `w.value.toLowerCase()`, `startsWith(queryLower)`;
   on a miss, loop `w.aliases` doing `a.toLowerCase().startsWith(queryLower)` (`:470-488`).
4. Only if fewer than `maxNum` exact hits: **second pass** over the remainder with `judgeLite`
   (`:505-529`) — fuzzy `microFuzzy` char scan + alias loop (`:196-256`,
   `util/strings.ts:208-240`).
5. Bounded top-K over the survivors (`selectTopK`, `:80-130`), then clone only the ≤5 winners
   (`materializeWord`, `:162-172`, applied at `:679`).

So: **O(bucket) regardless of how long the prefix is.** `cha`, `char` and `ch` all scan the same
11–13 k entries; only the post-match set shrinks (bench: `ch` matched 13,000 / `char` 4,000, both
scanned pool 13,000).

---

## 3. Scoring / ranking per keystroke

### 3.1 What is fresh each keystroke

| Item | Where | Per keystroke |
|---|---|---|
| Case-folded query | `suggester.ts:328` (`queryLower`), passed into `judgeLite` (`:508-514`) | once per query phrase ✅ (the old per-candidate `query.toLowerCase()` is gone) |
| Per-candidate `value.toLowerCase()` | `:443`, `:197`, `:239` | **once per candidate** — one string alloc per bucket entry |
| Fuzzy score | `microFuzzy` (`util/strings.ts:208-240`) | only in phase 2 (exact matches < 5) |
| `latestUpdated` | `:418-438`, `:491-499`, `:517-525` | one `selectionHistoryStorage.getSelectionHistory()` per matched candidate (`SelectionHistoryStorage.ts:132-134`) |
| `linkRanks` Map | `:539` (and `:933` in partial) | allocated fresh per pass; keyed by `Word` identity (`model/LinkRank.ts:151-165`) |
| Comparator chain | `:603-679` | per comparison, see 3.2 |

### 3.2 Comparator chain (prefix mode, `suggester.ts:603-679`; partial duplicate `:997-1082`)

1. `fuzzy` flag: concrete matches before fuzzy (`:607-609`).
2. Front-matter pin (`:611-614`) — only when a front-matter key is active.
3. `compareLinkTier` (`:555-601`): `fileTier` → higher folder score → lower folder level.
4. Alias pin for same-target pairs when `prioritizeAliases` (`:624-638`; default `true`,
   `settings.ts:242`).
5. Selection history (`:640-651`) → `calcScore` recency buckets, calls `Date.now()`
   (`SelectionHistoryStorage.ts:24-50`).
6. `compareFolderRankStage` (`:132-160`): stored list `rank` (top-1000) — `Number.POSITIVE_INFINITY`
   when absent.
7. Shorter `hit` first (`:666-668`).
8. `WordTypeMeta.priority` — frontMatter 100, internalLink 90, customDictionary 80, currentFile 70,
   currentVault 60 (`model/Word.ts:64-88`). **No user-configurable weights exist**; the only
   numeric knobs are `minFuzzyMatchScore` (`settings.ts:165`) and folder priority.
9. Alias flag last (`:675-677`).

### 3.3 How the folder rank cache is read on this path — **it isn't**

This is the single most important structural change since the earlier audits:

- The per-keystroke option built at `AutoCompleteSuggest.ts:672-681` carries only
  `{ enabled, currentFilePath, limitingFolder }` — **no `rankData`, no `folderRankCache`**
  (comment at `:679`). `afd0e98` removed the two fields that `8a53ba0` used to pass
  (`git show 8a53ba0:src/ui/AutoCompleteSuggest.ts` lines 668-684).
- Therefore in `suggester.ts:532-554` the `cachedList` resolution block is skipped
  (`folderRankCache` and `rankData` are `undefined`), and `computeLinkRank`
  (`model/LinkRank.ts:53-149`) either
  - returns the **pre-stamped** `{fileTier, folderProximity, rank}` when
    `word._rankPrecomputed === true` (`:58-64`), or
  - hits `if (!rankData) return { fileTier: false }` (`:66-69`).
- Pre-stamping happens in `InternalLinkWordProvider.annotateRankData()`
  (`InternalLinkWordProvider.ts:224-259`), called from `refreshInternalLinkTokens`
  (`AutoCompleteSuggest.ts:1032-1057`) inside a `requestIdleCallback(..., {timeout: 4000})`,
  and **only when `folderPriority.enabled && limitingFolder !== ""`** (`:1020-1023`).
- Net effect at shipped defaults (`folderPriority: { enabled: true, limitingFolder: "" }`,
  `settings.ts:283-286`): nothing is ever stamped, every internal-link rank is
  `{fileTier:false}`, and `compareLinkTier` returns 0 for every pair. The comparator still pays
  two `getOrComputeLinkRank` Map round-trips per comparison and grows `linkRanks` to ≈ the
  matched-set size (`:568-582`).
- **Side finding:** `refreshWords` stamps `word.fileTier` on every word from
  `metadataCache.resolvedLinks[activeFilePath]` / `unresolvedLinks` (`InternalLinkWordProvider.ts:176-202`)
  — that work is currently **never read**, because `computeLinkRank` bails on missing `rankData`
  before consulting `word.fileTier` (`model/LinkRank.ts:66-69` vs `:73-76`, `:114-117`). The
  documented "empty limitingFolder ⇒ fileTier-only ordering" (`codebase-map.md` §4.4) is
  consequently dead in the shipped wiring. `AutoCompleteSuggest` wiring is untested
  (`codebase-map.md` §7), so no test catches it.

### 3.4 `selectTopK` cost

`selectTopK` (`suggester.ts:80-130`) keeps a sorted list of ≤ k and compares each incoming item
once against the current worst (`:107-110`), re-scanning only when it displaces an entry
(`:112-126`). Practically O(N + k²) comparisons instead of O(N log N) — for `cha` that is ~13 k
comparisons instead of ~144 k.

---

## 4. Internal-link index lifecycle

### 4.1 First build

**Not** on load, **not** on idle, **not** on first use. `AutoCompleteSuggest.new()`
(`:193-309`) builds providers, `updateSettings`, loads history, registers events — and calls no
`refresh*` provider method. The first build waits for
`app.metadataCache.on("resolved")` (`:293-304`), which then unregisters itself (`:303`). If that
event never fires after plugin load, the internal-link index stays empty until a manual
`reload-internal-link-index` command (`main.ts:213-220`) or an active-leaf change (`:270-280`).
(This is the open question already flagged in `codebase-map.md` §9.)

### 4.2 Refresh triggers (current code)

| Event | Handler | Debounce | Work performed | O() |
|---|---|---|---|---|
| `metadataCache "resolved"` | `:293-304` | none (one-shot, then `offref`) | `linkRankIndex.invalidate()`, `refreshInternalLinkTokens()`, frontmatter, custom dictionaries, **full current-vault read** | O(vault bytes) |
| `metadataCache "changed"` | `:282-290` | **2500 ms** (`debounce(..., 2500)`, `:238-241`) | `linkRankIndex.markSourceStale(f.path)`, frontmatter per-file index, `refreshInternalLinkTokens()` | O(vault) index rebuild |
| `vault "modify"` | `:243-246` | **300 ms** (`:228-236`) | `refreshCurrentFileTokens()` (+ history persist if dirty) | O(active file chars), read + FNV hash + tokenize |
| `vault "rename"` | `:247-253` | 2500 ms | `linkRankIndex.onRename`, `folderRankCache.bumpStructure()`, `primeFolderSummaryIdle()`, reindex | O(vault) |
| `vault "delete"` | `:254-260` | 2500 ms | `linkRankIndex.onDelete`, bump, prime, reindex | O(vault) |
| `vault "create"` (md only) | `:261-269` | 2500 ms | `markSourceStale`, bump, prime, reindex | O(vault) |
| `workspace "active-leaf-change"` | `:270-280` | none | `refreshCurrentFileTokens()` (await), `refreshInternalLinkTokens()`, `updateFrontMatterToken()` | O(vault) per file switch |
| Settings save with `{internalLink:true}` | `main.ts:253-255` → `updateSettings` (`:505-508`) invalidates both rank caches, then full reindex | none | full rebuild + cache invalidation |
| Alias write ("add to aliases") | `ui/popup-commands.ts:131-134` | one-shot `"changed"` listener | reindex |
| Manual commands | `main.ts:213-220`, `:88-103` | none | rebuild |

**There is no `maxWait` anywhere.** Obsidian's `debounce(fn, timeout, resetTimer?)` has no
max-wait parameter, and the code passes only `(fn, delay)`; the only 3-arg call is
`debounce(fn, delayMilliSeconds, true)` for suggestions (`:582-732`). Consequence: under
continuous editing, `"changed"` events arriving faster than 2.5 s apart reset the timer
indefinitely, so the internal-link index can go arbitrarily stale while the user types — the
"hidden cost of debounced reindex under continuous editing" hazard in `AGENTS.md` is a
*starvation* problem here, not a storm problem.

### 4.3 Full rescan or incremental?

`refreshInternalLinkTokens()` → `refreshWords()` is a **full rebuild every time**:
`clearWords()` is the first statement (`InternalLinkWordProvider.ts:42`), then the whole vault is
re-enumerated and re-flattened. There is **no incremental path** for internal links (frontmatter
has one: `updateWordIndex` per file — `AutoCompleteSuggest.ts:285`, `:1124`).

**Clear-before-build window:** `refreshWords` is fully **synchronous** — `clearWords()` (which
resets `words` and `wordsByFirstLetter`, `:261-264`) and the rebuild run inside one call, so no
other JS (including `onTrigger`) can observe the empty index. The `throw` path deliberately
leaves `lastRefresh` untouched (`:217-221`). So no visible empty window, but also no yielding:
the rebuild is one long task (bench: `refresh-internal-links` p50 2.7 ms warm / 3.5 ms cold,
p95 up to 7.9 ms, max 12.5 ms on a 14 k-file fixture — `bench/results/latest.md`).

### 4.4 Rank/index caches (off the keystroke path)

- `LinkRankIndex.getRankData` is called **only** from the idle `annotate` closure
  (`AutoCompleteSuggest.ts:1037-1046`). With `limitingFolder === ""` its `rebuild` is O(1)
  (the vault walk at `LinkRankIndex.ts:183-232` is guarded by `limitingFolder !== ""`), so the
  default config never pays the ~30–40 ms rebuild; a non-empty limiting folder does.
- `FolderRankCache.getList` is called from the same idle closure via `annotateRankData`
  (`InternalLinkWordProvider.ts:239-246`), and from `primeSummary` (`:965`) on idle after
  structure events. `ensureSummary()` is O(vault) (`FolderRankCache.ts:152-194`) and its memo key
  is `(rankIndex.currentVersion, structureEpoch)` (`:155-160`).
- `markSourceStale` only records intent (`LinkRankIndex.ts:105-117`); the actual diff is applied
  lazily in `getRankData` (`:248-362`) and bumps the global version **only when the source's
  link contribution actually changed** (`:349-361`) — so prose typing does not invalidate the
  folder lists.

**Caveat:** "off the keystroke path" ≠ "free". The annotate callback does
`getRankData` + `getList` (cold: ~23–40 ms) + a full `computeLinkRank` loop over all
~14 k words (`InternalLinkWordProvider.ts:248-258`) in **one unchunked idle callback**. It cannot
land inside `onTrigger`, but it can land between keystrokes and blow the frame budget.

---

## 5. Settings that gate the typing path, and the no-op work that still happens

| Setting | Default | Effect on typing path |
|---|---|---|
| `complementAutomatically` | `true` (`settings.ts:174`) | gate #1: when off (and popup closed, no manual run) `onTrigger` returns immediately |
| `disableSuggestionsDuringImeOn` | `false` (`:176`) | gate #2 |
| `enableFrontMatterComplement` | `false` (`:262`) | when on, adds an **O(document)** `getCurrentFrontMatter()` (2× `getValue()`) per keystroke |
| `disableSuggestionsInMathBlock` / `…CodeBlock` | `false` / `false` (`:177-178`) | when on, adds an **O(document)** scan per keystroke |
| `patternsToSuppressTrigger` | `["^~~~.*","^```.*"]` (`:181`) | pre-compiled once per settings change (`:511-522`), N regex tests per keystroke |
| `firstCharactersDisableSuggestions` | `":/^"` (`:180`) | one compiled regex; blocks a phrase starting with those chars |
| `minNumberOfCharactersTriggered` (+ 4 provider minimums) | `0` / all `0` (`:172`, `:267-270`) | resolves to `triggerThreshold` = **3** for the default strategy |
| `minNumberOfWordsTriggeredPhrase` | `1` (`:173`) | how many window tokens become queries |
| `maxNumberOfWordsAsPhrase` | `3` (`:171`) | size of the phrase window; **also the multiplier on per-keystroke work** (one bucket scan per query) |
| `delayMilliSeconds` | `0` (`:175`) | no coalescing: one full pass per keystroke |
| `matchStrategy` | `"prefix"` (`:163`) | `prefix` → 2-bucket scan; `partial` → whole-index flatten |
| `maxNumberOfSuggestions` | `5` (`:170`) | top-K size; negligible effect on cost |
| `fuzzyMatch` / `minFuzzyMatchScore` | `true` / `0.5` (`:164-165`) | enables phase-2 `microFuzzy` |
| `internalLinkMinNumberOfCharactersForTrigger` | `0` (`:270`) | can raise the internal-link-only minimum without raising the global one |
| `enableInternalLinkComplement` | `true` (`:240`) | **index-only** switch: off ⇒ `clearWords()` and no index (`:984-994`); the typing path still runs and just finds an empty bucket |
| `excludeSelfInternalLink`, `excludeExistingInActiveFileInternalLinks` | `false`, `false` | post-filters after suggestions (`:702-717`) |
| `intelligentSuggestionPrioritization.enabled` | **`true`** (`:272-273`) | constructs `SelectionHistoryStorage`, so the per-candidate history lookup + per-comparison `compare` are live |

**No-op work that still happens when the popup never appears:**

- Any bail *after* gate 9/10 pays **two full tokenizer passes over the line** (two O(line)
  scans, each char-by-char with `content[i].match(pattern)` — `DefaultTokenizer.ts:37-69`;
  probe shows `tokenize(raw)` and `recursiveTokenize` both walk the same characters).
- `this.close()` on every bail (`:1165-1170`) — an Obsidian popup teardown per keystroke.
- Bail at gate 15 (`length < 3`) happens after both tokenizations and after the `split(" ").last()`.
- Debug strings are built **eagerly** even when logging is off: `:1193`, `:1247`, `:1255`
  (`JSON.stringify(currentTokens)`), `:1258`, `:1315` (`buildLogMessage(... performance.now()-start)`)
  — `showDebugLog` only *throws them away* (`:1594-1598`); default
  `showLogAboutPerformanceInConsole: false` (`settings.ts:292`).
- `setSelectionLock` (`:1309-1313`) performs `document.querySelector("body")` + classList write
  on **every** keystroke that produces suggestions.
- When the query matches nothing, `suggestWords` still allocated two bucket copies and scanned
  every entry (`suggester.ts:355-503`), and `linkRanks` grew to ~matched size (`:539`).

---

## 6. Bottom line — actual per-keystroke work

Let **B** = size of the internal-link bucket(s) for the query's first character (this vault:
11,177 at `c`; bench fixture: 13,000 at `ch`), **Q** = number of query phrases in the window
(1–3), **k** = `maxNumberOfSuggestions` (5), **V** = vault size (files/links).

### 6.1 Plain keystroke that does **not** trigger (e.g. typing in the middle of a word is fine; this is the punctuation/1–2-char case)

1. `getLine` + string equality on the whole line (gate 4) — O(line), no allocation.
2. Possibly `getCurrentFrontMatter` (O(doc), only if front-matter complement is enabled).
3. `compiledSuppressPatterns.find` — O(#patterns × line).
4. `tokenize(lineUntilCursor, true)` — **O(line)** char scan.
5. `recursiveTokenize(lineUntilCursor)` — **O(line)** char scan (second pass).
6. A few regex/string checks; then `close()`.
7. **Vault-relative complexity: O(line). Zero vault access. Zero index access.**

### 6.2 Keystroke that produces suggestions (prefix mode, defaults)

| Step | Complexity | Allocations |
|---|---|---|
| gates 1-14 + trigger info | O(line) | 2 tokenizer passes, 1 JSON string |
| `debounce` (0 ms) + `JSON.parse` | O(line) | 1 parse |
| per query (×Q, ≤3): bucket read `internalLink[c0]`, `internalLink[c0±case]` | O(B) copy | 2 array copies per query |
| phase-1 match loop over B | **O(B)**, `toLowerCase()` per candidate + alias loop on miss | ~B strings (+ alias strings on miss) |
| phase-2 `judgeLite` over remainder (only if exact < 5) | O(remainder × char scan) | fuzzy score objects |
| `selectTopK` | ~O(B) comparisons, each with 2 `getOrComputeLinkRank` Map ops → **O(matched)** Map entries | 1 Map, ~B entries |
| `materializeWord` ×≤5 | O(1) | ≤5 clones |
| caller: sort ≤15, filters, `uniqWith` | O(Q·k²) | — |
| **Total** | **O(Q · B)**, i.e. **independent of prefix length and of V** | ~2–3 strings per bucket entry |

Measured on the bench fixture (Node, stubbed Obsidian): `suggest-keystroke cha (fp off)` p50
**1.40 ms** / p95 1.52 ms, pool 13,000; `ch (fp on)` p50 2.94 ms; `session-sim 300 keystrokes`
549 ms ⇒ **~1.8 ms per keystroke** including everything (`bench/results/latest.md`, N=7, quick
mode). No in-app profile exists; these are Node-side numbers.

### 6.3 What is *not* on this path (contrary to older notes)

- No `LinkRankIndex.getRankData`, no `FolderRankCache.getList`, no `getMarkdownFiles()`,
  no full sort, no 10 k word clones, no per-candidate `query.toLowerCase()`.
- `getMarkdownFiles()` appears only in `refreshWords` (`InternalLinkWordProvider.ts:59`),
  `CurrentVaultWordProvider`, and `FolderRankCache.ensureSummary` (`:165`).

---

## 7. Risks / defects found while mapping (ranked)

1. **Folder ranking is inert at shipped defaults, and `fileTier` precompute is dead code.**
   Keystroke option passes no `rankData` (`AutoCompleteSuggest.ts:672-681`) ⇒ `computeLinkRank`
   returns `{fileTier:false}` (`model/LinkRank.ts:66-69`); `refreshWords`'s `fileTier` stamping
   (`InternalLinkWordProvider.ts:176-202`) is never consulted. Fix: stamp `fileTier` always (not
   just under `annotateRankData`) and have `computeLinkRank` honour `word.fileTier` before the
   `rankData` bail; add a wiring test.
2. **No `maxWait` on the 2500 ms internal-link debounce** (`:238-241`) ⇒ starvation under
   continuous typing; index can be minutes stale. `AGENTS.md` already requires `maxWait`.
3. **Idle annotate is one unchunked long task** (~23–40 ms cold `getList` + ~14 k
   `computeLinkRank` + `getRankData` rebuild) (`:1032-1057`,
   `InternalLinkWordProvider.ts:248-258`). It can't hit `onTrigger`, but it can drop frames
   between keystrokes. Chunk it, or prewarm on `resolved`/idle before first use.
4. **`Q` multiplies the bucket scan.** The phrase query (`currentTokens.first()`) is almost
   always the whole 3-word window and matches nothing, yet it scans a full bucket
   (`AutoCompleteSuggest.ts:1250-1257` + `suggester.ts:355-411`). Dropping phrase queries whose
   trailing token is the same as another query's would cut work by up to 2/3.
5. **Per-candidate `toLowerCase()`** in both phases (`suggester.ts:443`, `:197`, `:239`) —
   ~B string allocations per keystroke. A lowercased shadow value per `Word` at refresh time
   removes it.
6. **Alias loop runs on every miss** (`:470-488`) with `a.toLowerCase()` per alias — this is the
   default alias mode's cost, not the fuzzy path.
7. **`partial` mode is whole-index**: `flatObjectValues` flattens every bucket on every
   keystroke (`:872-873`, `:885-900`) and `judgeLiteByPartialMatch` runs four matchers per
   candidate (`:710-823`). Order-of-magnitude worse than prefix; the bench does not cover it.
8. **Two tokenizer passes per keystroke** (`:1246`, `:1249`) plus eager debug strings
   (`:1193`,`:1247`,`:1255`,`:1258`,`:1315`) — small but free to fix.
9. **`setSelectionLock` DOM write per keystroke** (`:1309-1313`, `:1600-1609`).
10. **`CurrentFileWordProvider` still reads the whole active file on every save** and then FNV
    hashes it (`:59-61`); the cache only helps when content is byte-identical
    (`:64-75`), which is not the normal save case. Duplicated dead helpers at `:146-192`.

---

## 8. Uncertainty

1. No in-app instrumentation. Millisecond figures are from `bench/results/latest.md`
   (N=7, quick mode, 14 k-file synthetic fixture, Node + stubs), not Obsidian.
2. Bucket sizes for *this* vault (11,177 at `c`) come from the offline model in
   `writing-pattern-data-2026-10-29.json`; the live `data.json` (exclusions, alias mode, ignore
   prefixes) may make the real bucket much smaller.
3. The `[[` explanation in §1.4 is derived from the shipped tokenizer via a runtime probe plus
   the offset arithmetic in `onTrigger`; I did not observe the popup in Obsidian.
4. The `fileTier`/`rankData` defect (§7.1) is read from code; `AutoCompleteSuggest` wiring has no
   test (`codebase-map.md` §7), so nothing contradicts it, but it is unverified at runtime.
5. Whether `metadataCache "resolved"` reliably fires after plugin load (the only automatic first
   build) remains untested — unchanged from `codebase-map.md` §9.

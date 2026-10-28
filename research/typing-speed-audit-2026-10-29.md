# Typing-Speed Audit — `various-complements-with-folder-priority` (2026-10-29)

Companion to `research/writing-pattern-analysis-2026-10-29.md`. That document establishes
*how much* the vault asks of the plugin. This one walks the code and says *where the time
goes*, with `file:line` references against the working tree at time of writing.

**Scope discipline:** no source was modified. Everything below is read-only analysis.
Line numbers are valid for the tree as audited (commit `d2e9d7a` + uncommitted
`src/setting/settings.ts` work). The `bench/` and `shared-core/` directories were being
rewritten by concurrent work while this was written — treat bench references as
"latest observed", and re-run `node bench/run.mjs` before quoting.

---

## 0. The one-paragraph version

With default settings, **every keystroke** (`delayMilliSeconds: 0`) pulls the internal-link
bucket for the query's first letter, runs a matcher over **all** of it, then sorts the
survivors with a 9-branch comparator **to return 5 results**. In this vault that bucket is
**11,177 values at `cha`** and roughly **43,000 short-lived allocations per keystroke**
(cloned word objects + judgement wrappers + lowercased strings + a per-pass rank Map).
There is no prefix narrowing and no top-K selection, so typing more characters does not
reduce the work — only the sort input. Separately, three cache builds
(`LinkRankIndex.rebuild` 30.161 ms, `FolderRankCache.buildList` 27.487 ms,
`FolderRankCache.ensureSummary` 10.921 ms) can each land on the keystroke path after an
invalidation or a vault structure event.

---

## 1. Path map

| Path | Trigger | Entry point | Complexity |
|---|---|---|---|
| **Keystroke** | each edit | `AutoCompleteSuggest.onTrigger` → `getSuggestions` → `debounceGetSuggestions` | **O(first-letter bucket)** + optional O(document) |
| **Save (per-modify)** | `vault.on("modify")`, 300 ms debounce | `refreshCurrentFileTokens` | **O(active file chars)** |
| **Save (metadata)** | `metadataCache.on("changed")`, then 1000 ms debounce | `markSourceStale` → `refreshInternalLinkTokens` | **O(vault)** |
| **Structure event** | create/rename/delete | `bumpStructure` → next `getList` → `ensureSummary` | **O(vault)** on the *next keystroke* |
| **Startup / resolved** | `metadataCache.on("resolved")` | `invalidate()` + all refreshes incl. full vault read | **O(vault bytes)** |
| **Settings change** | `updateSettings` | `linkRankIndex.invalidate()` + `folderRankCache.invalidate()` | **O(vault)** on the next keystroke |

The important structural fact: **the two O(vault) cache rebuilds are invoked from inside
the keystroke handler**, not from an idle callback. `getRankData` and `getList` are called
at `src/ui/AutoCompleteSuggest.ts:675-679` and `src/provider/suggester.ts:321-326` — i.e.
inside `debounceGetSuggestions`.

---

## 2. Keystroke path, in order

### 2.1 `onTrigger` — `src/ui/AutoCompleteSuggest.ts:1092-1291`

Cheap, line-scoped work first:

| Line | Work | Cost |
|---|---|---|
| `1126-1129` | `getCurrentFrontMatter()` — only when `enableFrontMatterComplement` (**default off**, `settings.ts:258`) | O(document) if enabled |
| `1152-1154` | `compiledSuppressPatterns.find(re => re.test(lineUntilCursor))` — patterns are **pre-compiled** on settings change (`:507-519`), so this is N regex tests over one line | O(patterns × line) |
| `1182` | `tokenizer.tokenize(lineUntilCursor, true)` | O(line) |
| `1185` | `tokenizer.recursiveTokenize(lineUntilCursor)` — **second full pass** over the same line | O(line) |
| `1200-1213` | `lineUntilCursor.split(" ").last()` + cheap equality guard | O(line) |
| `1226` | `currentPhrase.match(trimPattern)` | cheap |
| `1234-1243` | `minNumberTriggered` gate — **the cheapest possible mitigation**: raises the minimum prefix length | cheap |
| `1254-1259` | phrase-suppress filter over ≤3 tokens | cheap |
| `1282-1289` | `JSON.stringify` of the query payload | small |

Two full-document scans are reachable from here, both **off by default**:

| Line | Call | What it does |
|---|---|---|
| `1162-1170` | `inMathBlock(editor)` → `app-helper.ts:230-234` | `getContentUntilCursor()` = **`editor.getValue().slice(…)`** then `match(/\$\$\n/g)` over the whole document |
| `1172-1180` | `inCodeBlock(editor)` → `app-helper.ts:239-241` → `util/strings.ts:267-303` | `getValue()` again, then `split("\n")` and a regex per line |

`app-helper.ts:158-160` is the multiplier:

```ts
getContentUntilCursor(editor: Editor): string {
  return editor.getValue().slice(0, this.getCurrentOffset(editor));
}
```

`editor.getValue()` serialises the **entire document** on every call. On a p90 active
chapter (~9,700 words, `writing-pattern-data-2026-10-29.json` →
`chapters.activeInWindow.words.p90`) that is ~55 KB per call; on the observed max
(42,975 words) ~250 KB. `disableSuggestionsInCodeBlock` / `disableSuggestionsInMathBlock`
default to `false` (`settings.ts:173-174`), so **this is not on the default keystroke
path** — but it is a landmine: enabling either setting (a natural thing for a writer who
also keeps code notes) puts two full-document serialisations on every keystroke.

`getCurrentFrontMatter` (`app-helper.ts:298-333`) calls `editor.getValue()` **twice**
(`:311` and `:318`) plus `matchAll` over the whole document. Only with frontmatter
complement enabled.

### 2.2 `debounceGetSuggestions` — `:578-732`

Registered with `debounce(fn, this.settings.delayMilliSeconds, true)`. Default
`delayMilliSeconds: 0` (`settings.ts:171`) → **the full pass runs on every keystroke**.
Raising this value is a one-line, config-level coalescer (see §9, mitigation M1).

| Line | Work | Notes |
|---|---|---|
| `620-624` | `excludeInternalLinkInCode` → `inInlineCode` (line-scoped) **or** `inCodeBlock` (O(document)) | second reachable O(doc) scan; default `false` (`settings.ts:247`) |
| `626-688` | loop over `parsedQuery.queries` (≤ `maxNumberOfWordsAsPhrase` = 3, `settings.ts:167`), calling `matchStrategy.handler(...)` | **the expensive part** — see §2.3 |
| `675-678` | `linkRankIndex.getRankData(activePath, limitingFolder)` **inside the query loop** | memoised via `lastReturned`; cold = 30 ms |
| `685` | `{ ...word, offset: q.offset }` clone per returned result (≤ 5 per query) | cheap |
| `688` | `.sort((a,b) => Number(a.fuzzy) - Number(b.fuzzy))` over ≤15 | cheap |
| `720-724` | `uniqWith(words, suggestionUniqPredicate).slice(0, maxNumberOfSuggestions)` | `uniqWith` is O(n²) (`util/collection-helper.ts:28-32`) but n ≤ 15 |

### 2.3 `suggestWords` — `src/provider/suggester.ts:183-454`

This is the hot loop. Annotated:

```ts
// :240-298 — bucket selection. TWO string concats of whole buckets.
const words = queryStartWithUpper
  ? [ ...(indexedWords.currentFile[c]), ..., ...(indexedWords.internalLink[c]), ... ]
  : [ ...(indexedWords.currentFile[c]), ..., ...(indexedWords.internalLink[c]), ... ];

// :300-302 — the matcher runs over EVERY element of the bucket.
const filteredJudgement = Array.from(words)      // ← third full copy of the bucket
  .map((x) => judge(x, query, queryStartWithUpper, option))
  .filter((x) => x.value !== undefined);
```

Three full copies of the bucket array happen before any filtering (`Array.from(words)`
copies again after the spread). In this vault the `c` bucket is **11,177** entries.

**Cost is decoupled from prefix length.** `filteredJudgement` gets smaller as the query
gets longer, but `.map(judge)` always visits 11,177 candidates. Measured against the vault
data (`candidateSetModel` in the JSON):

| Query | Judged | Matched | Judged ÷ matched |
|---|---:|---:|---:|
| `ch` | 11,177 | 10,721 | 1.04 |
| `cha` | 11,177 | 10,520 | 1.06 |
| `char` | 11,177 | 4,936 | 2.26 |

`judge` itself (`:91-181`):

```ts
const matcher = options?.fuzzy ? lowerFuzzy : wrapFuzzy(lowerStartsWith);  // :112
const matched = matcher(word.value, query);                                 // :114
```

- **`lowerStartsWith(a, b) => a.toLowerCase().startsWith(b.toLowerCase())`**
  (`util/strings.ts:71-73`). `b` is *always the same query string*, yet
  `query.toLowerCase()` is recomputed **once per candidate** — 11,177 redundant
  allocations of the same string per keystroke. The query's lowercased form is never
  hoisted.
- **`fuzzyMatch: true` is the default** (`settings.ts:160`), which selects
  `lowerFuzzy` → `microFuzzy` (`util/strings.ts:86-96`, `:208-240`): another two
  `toLowerCase()` calls plus a **full character scan of the candidate value**. For 11,177
  values averaging ~20 chars that is ~220,000 character comparisons per keystroke, on top
  of everything else. **The bench never measures this path** (§8).
- On a match, `judge` **clones the word**: `{ ...word, hit, fuzzy, query }`
  (`:126-148`). At `cha` that is **10,520 object clones per keystroke**, each copying
  `value / type / createdPath / aliases / description` (+ `aliasMeta`).
- On a *miss*, it falls through to the alias loop (`:151-158`):
  `word.aliases?.map(...).sort(...).find(...)` — **an array allocation plus a sort per
  candidate**. With `suggestInternalLinkWithAlias: false` (default, `settings.ts:237`)
  every internal link carries its aliases as *match forms*, so this path is live.

### 2.4 Comparator — `:369-448` (and the duplicate at `:741-827`)

```ts
const latestUpdated = max(filteredJudgement.map(...), 0);   // :360-367 — full extra pass
const candidate = filteredJudgement
  .sort((a, b) => { ... })                                  // :369
  .map((x) => x.word)
  .slice(0, maxNum);                                        // :449-450 — keep only 5
return uniqWith(candidate, suggestionUniqPredicate);         // :453
```

Sorting 10,520 objects to keep 5. Each comparison runs, in order:

| Comparator stage | Line | Cost |
|---|---|---|
| `fuzzy` flag compare | `374-376` | cheap |
| `compareLinkTier` | `327-358`, `383-386` | **two `getOrComputeLinkRank` calls** → per-word `computeLinkRank` (`model/LinkRank.ts:54-154`) + Map lookup |
| alias pin (`prioritizeAliases`, default **true** `settings.ts:238`) | `391-405` | two `??` chains + string compare |
| selection history | `407-416` | 2 nested property lookups + `calcScore` (`SelectionHistoryStorage.ts:24-50`, includes `Date.now()`) |
| folder-rank stage | `419-427` | **two more `getOrComputeLinkRank` calls** (same Map) |
| length compare | `429-431` | cheap |
| `WordTypeMeta.of` | `432-437` | static dict lookup |
| alias flag | `438-446` | cheap |

Two compounding issues:

1. **`linkRanks` is keyed by `Word` object identity** (`:311`,
   `model/LinkRank.ts:156-169`) — but `judge` just cloned every word. So the Map cannot be
   shared across passes, and it fills with up to ~10.5 k entries **per keystroke**.
   It is allocated fresh at `:311` on every call.
2. **`compareLinkTier` runs even when `limitingFolder === ""`.** The app default is
   `folderPriority: { enabled: true, limitingFolder: "" }` (`settings.ts:279-282`). With
   an empty limiting folder, `FolderRankCache.getList` short-circuits to `undefined`
   (`FolderRankCache.ts:73-76`), but `computeLinkRank` still does the `fileTier` Set lookup
   for every compared word. The bench's `(fp off)` variant disables `folderPriority`
   entirely, and `(fp on)` uses `limitingFolder: "Novel"` — **the app default is a third
   configuration that the bench does not directly model.**

`judgeByPartialMatch` / `suggestWordsByPartialMatch` (`:458-832`) repeat the same shape
but worse: `flatObjectValues(indexedWords.internalLink)` (`:643-644`) flattens **every
bucket**, i.e. the whole 25 k-value index, on every keystroke. Its comparator additionally
calls `lowerStartsWith` twice per comparison (`:790-791`), allocating four strings per
comparison. This mode is an order of magnitude more expensive than exact mode.

---

## 3. Save path

### 3.1 Per-modify — current-file reindex

```
vault.on("modify")                                    AutoCompleteSuggest.ts:242-245
  → debounce(…, 300)                                  :227-235
    → refreshCurrentFileTokens()                      :855-886
      → CurrentFileWordProvider.refreshWords()        :871
```

`CurrentFileWordProvider.refreshWords` (`src/provider/CurrentFileWordProvider.ts:23-83`):

- `:51` `await this.app.vault.cachedRead(file)` — reads the **entire active file**.
- `:52-64` `tokenizer.tokenize(content)` over the whole file, then three filter passes.
- `:65` `uniq(tokens)` — Set over all unique tokens.
- `:77-82` `clearWords()` then re-`pushWord` every word into `wordsByFirstLetter`.

`DefaultTokenizer.__tokenize` (`src/tokenizer/tokenizers/DefaultTokenizer.ts:37-69`) is
**per character**:

```ts
for (let i = 0; i < content.length; i++) {
  if (content[i].match(super.getTrimPattern(target))) { ... }   // :44-45
```

`content[i]` allocates a 1-char string; `.match(re)` allocates a result (or `null`) per
call. For a median active chapter (~27 KB) that is ~27,000 regex invocations; for the
observed max (~250 KB) ~250,000. At 300 ms after each ~2 s autosave, on the largest open
file, this is the most *frequent* large cost in the plugin — and it is **not covered by any
bench scenario** (there is no `refresh-current-file` scenario).

### 3.2 Per-metadata-change — internal-link reindex + frontmatter reflatten

```
metadataCache.on("changed")                           AutoCompleteSuggest.ts:278-286
  ├─ linkRankIndex.markSourceStale(f.path)            → LinkRankIndex.ts:105-115
  ├─ updateFrontMatterTokenIndex(f)                   → FrontMatterWordProvider.ts:87-94
  ├─ if (!isActiveFile(f)) updateFrontMatterToken()   → :1070-1090 → :96-99  ← FULL REFLATTEN
  └─ debounce(…, 1000) → refreshInternalLinkTokens()  → :960-1005
```

- `updateFrontMatterToken()` → `FrontMatterWordProvider.updateWords()` (`:96-99`) calls
  `extractAndUniqWords(Object.values(wordsByCreatedPath).flat())` over **every file's**
  frontmatter words, then `indexingWords` (two `groupBy` passes). O(all frontmatter values)
  — and it happens for *any* non-active-file metadata change. (Only reachable with
  `enableFrontMatterComplement`, default off.)
- `refreshInternalLinkTokens()` → `InternalLinkWordProvider.refreshWords`
  (`src/provider/InternalLinkWordProvider.ts:26-186`): `getMarkdownFiles()` (`:55-56`),
  per-file `getBoolFrontMatter`/`getTagsProperty` (`:68-78` — each a metadataCache lookup),
  a `flatMap` that builds `synonymAliases` arrays per file (`:82-145`), plus
  `searchPhantomLinks()` (`:150`) which flattens **all** unresolved links
  (`app-helper.ts:247-251`), then `pushWord` per value **and per alias** (`:168-173`).
  Bench: `refresh-internal-links warm` p50 **1.962**, p95 **4.247**; cold p50 **2.875**,
  p95 **5.988**, max **12.548** (14,400 candidates).

### 3.3 Structure events

`create` / `rename` / `delete` (`:246-265`) call `folderRankCache.bumpStructure()`
(`FolderRankCache.ts:119-121`), which only increments `structureEpoch`. The cost is paid
**later, on the next keystroke**, inside `getList` → `ensureSummary`:

```ts
for (const file of this.app.vault.getMarkdownFiles()) {        // :161
  const parent = getParentFolder(file.path);
  direct.set(parent, (direct.get(parent) ?? 0) + 1);
  const parts = parent.split("/").filter(Boolean);             // :166
  for (let i = 1; i < parts.length; i++) {
    nonLeaf.add(parts.slice(0, i).join("/"));                  // :168-170  ← O(depth²) strings
  }
}
```

`getMarkdownFiles()` at 14,433 files is ~10 ms on its own; the ancestor-chain rebuild adds
slice/join work per file. Bench: `folderrank structure bump` p50 **10.921**, p95 **11.664**.
So: **create a note, then type → an ~11 ms hitch on the first keystroke.** That is a
dropped frame that the user will attribute to "typing".

---

## 4. Cache layer

### 4.1 `LinkRankIndex` — `src/storage/LinkRankIndex.ts`

| Method | Line | Complexity | Bench |
|---|---|---|---|
| `getRankData` | `47-94` | memoised; cheap on hit | `linkrank warm hit (Novel)` p50 **0.000**, p95 0.001 |
| `rebuild` | `166-244` | **O(all resolved links)** — walks `metadataCache.resolvedLinks` + `unresolvedLinks` and builds 3 nested Maps | `linkrank cold (Novel)` p50 **30.161**, p95 **32.847**, max **43.718** |
| `applyStaleSources` | `246-360` | O(stale sources × their links); bails to `rebuild` above 5,000 targets | `markSourceStale+get` p50 **0.012** |
| `rebuildFilePart` | `454-482` | O(links in active file) | included in warm hit |

The delta-aware invalidation is genuinely good: `markSourceStale` + `getRankData` costs
**0.012 ms** instead of 30 ms, and `contributionsEqual` (`:347-359`) only bumps the version
when the link data actually changed. **Prose typing does not pay the 30 ms.**
The 30 ms lands on: `invalidate()` from `metadataCache.on("resolved")`
(`AutoCompleteSuggest.ts:289-300`) and from `updateSettings` (`:503`). Both are followed by
a user keystroke that eats it.

### 4.2 `FolderRankCache` — `src/storage/FolderRankCache.ts`

Constants (`:27-31`): `MIN_FILES_PER_FOLDER 20`, `MAX_FILES_PER_FOLDER 2000`,
`MAX_CACHED_LISTS 512`, `MAX_LIST_SIZE 500`, `TOP_K 1000`.

| Method | Line | Complexity | Bench |
|---|---|---|---|
| `getList` hit | `101-113` | Map get + recency move | `folderrank warm hit` p50 **0.001** |
| `getList` → `buildList` | `192-236` | **O(distinct targets)** + sort | `folderrank cold first folder` p50 **27.487**, p95 **36.457**, max **59.653** |
| `ensureSummary` | `148-190` | **O(vault)** — `getMarkdownFiles()` + ancestor chains | `folderrank structure bump` p50 **10.921** |

Two mitigations are already in place and should be preserved: `getList` is called **once
per pass** and stored on the option as `cachedList` (`suggester.ts:321-326`, consumed at
`model/LinkRank.ts:77-83`, `:126-132`), and `buildList` memoises folder-level distance
(`:254`, `levelByFolder`). Without those, `computeLinkRank` would call `getList` once per
*word*.

One residual hazard: `ensureSummary`'s memo key is `(rankIndex.currentVersion,
structureEpoch)` (`:151-156`). `bumpStructure` is also called from `updateSettings`
(`AutoCompleteSuggest.ts:505`), so **opening the settings tab and toggling anything makes
the next keystroke pay the 11 ms summary rebuild** as well as the 30 ms rank rebuild.

### 4.3 `CurrentVaultWordProvider` — the startup avalanche

`src/provider/CurrentVaultWordProvider.ts:50-79`:

```ts
for (const path of markdownFilePaths) {
  const stat = await this.app.vault.adapter.stat(path);          // :51
  const content = await this.app.vault.adapter.read(path);        // :56
  const tokens = this.tokenizer.tokenize(content) ...             // :58
```

**Sequential `await` per file** over every markdown file in the vault, reading full text,
tokenising each. For this vault that is 14,433 files / ~190 MB. My offline scan of the
same corpus with **concurrency 12** took 2.8–3.2 s; sequential awaits are strictly slower.
Default `enableCurrentVaultComplement: false` (`settings.ts:217`), so this is opt-in — but
it is on the `resolved` handler (`AutoCompleteSuggest.ts:297`), i.e. **every startup** for
anyone who enables it, and it competes with the editor for the main thread between awaits.

---

## 5. O(vault) vs O(candidates)

Not everything here is a problem. Being explicit about which is which:

| Work | Complexity | When | Verdict |
|---|---|---|---|
| `suggestWords` judge pass | **O(first-letter bucket)** | every keystroke | ❌ should be O(matched) |
| `suggestWords` sort | O(matched log matched) | every keystroke | ❌ should be O(matched) with top-K |
| `judge` allocations | O(bucket) objects | every keystroke | ❌ should be O(matched) |
| `suggestWordsByPartialMatch` | **O(entire index)** | every keystroke in partial mode | ❌ needs a different index |
| `onTrigger` tokenize ×2 | O(line) | every keystroke | ✅ fine |
| `inCodeBlock` / `inMathBlock` / `getCurrentFrontMatter` | **O(document)** | per keystroke *if enabled* | ⚠️ off by default, on = bad |
| `refreshCurrentFileTokens` | **O(active file chars)** | ~every 2 s per save | ❌ most frequent large cost |
| `refreshInternalLinkTokens` | **O(vault)** | ~every save, 1 s debounce | ⚠️ ~2–6 ms, tolerable but avoidable |
| `LinkRankIndex.rebuild` | **O(all links)** | on `resolved` / settings change | ⚠️ 30 ms, should be prewarmed |
| `FolderRankCache.ensureSummary` | **O(vault)** | next keystroke after structure event | ❌ 11 ms on the keystroke path |
| `LinkRankIndex.markSourceStale` | O(links of one file) | every save | ✅ 0.012 ms, well designed |
| `getMarkdownFiles()` | **O(vault)** ~10 ms | inside `ensureSummary` | ⚠️ memoised, but keyed on a coarse epoch |
| `searchPhantomLinks` | **O(all unresolved links)** | every internal-link refresh | ⚠️ grows with vault |

**Duplicate work / redundant clones found:**

1. `Array.from(words)` at `suggester.ts:300` copies a bucket that was just built by spread
   concatenation (`:240-298`) — three array copies before any filtering.
2. `query.toLowerCase()` recomputed per candidate inside `lowerStartsWith` (`strings.ts:72`)
   — ~11,177 redundant allocations per keystroke.
3. `judge` clones every *matched* word (`suggester.ts:126-148`) when only the final ≤5 are
   ever used for display/insertion. 10,520 clones at `cha`.
4. `linkRanks` Map (`:311`) keyed by cloned `Word` identity → cannot be reused across
   passes, and is rebuilt every keystroke.
5. `latestUpdated` (`:360-367`) does a full extra pass over `filteredJudgement`, calling
   `getSelectionHistory` twice per item in the comparator anyway.
6. `onTrigger` tokenizes the same line twice (`:1182`, `:1185`).
7. `refreshCurrentFileTokens` clears and rebuilds the entire current-file index on every
   save (`CurrentFileWordProvider.ts:30`, `:77-82`) instead of patching the changed lines.
8. `suggestWordsByPartialMatch` re-flattens `Object.values(...)` of every bucket on every
   keystroke (`:643-671`).

---

## 6. Alias fan-out, concretely

- `suggestInternalLinkWithAlias: false` (default) → one `Word` per note; aliases live in
  `word.aliases` (`InternalLinkWordProvider.ts:127-140`). Bucket = **11,177** values.
- `suggestInternalLinkWithAlias: true` → aliases become **separate candidates**
  (`:85-98`), each with its own `aliasMeta.origin`. Bucket grows to ~**22 k** and each
  suggestion clones independently. The popup then shows both `Char - Daemon Targaryen` and
  `Daemon` for the same target.
- `suggestAliasesOnly: true` (`:99-101`) suppresses the basename row — for this vault that
  is a *sensible* config (aliases are what the writer types), and it removes ~4,892
  `Char - …` basename candidates. But `internalLinkIgnoreTriggerPrefixes` (`:102-104`,
  `:119-121`) does the opposite filtering at the basename level.
- Vault data: 11,640 alias entries, 11,379 distinct, median 1/aliased file, p90 2, max 25.
  Aliases add only ~549 values to the `c` bucket. **Alias fan-out is not the cause of the
  bucket size; basename volume is.**

---

## 7. `internalLinkIgnoreTriggerPrefixes` (new work — described, not edited)

Present in the tree:

| Where | What |
|---|---|
| `src/setting/settings.ts:103` | type |
| `src/setting/settings.ts:240` | default `""` |
| `src/setting/settings.ts:1441-1443` | settings UI (comma-separated) |
| `src/ui/AutoCompleteSuggest.ts:989-996` | parsed → trimmed, lowercased, deduped → passed as `ignorePrefixes` |
| `src/provider/InternalLinkWordProvider.ts:41-52` | compiled to `^prefix[\s\-–—_·:]+`, **once per refresh** |
| `src/provider/InternalLinkWordProvider.ts:102, :119` | applied to **basenames only** |

Behaviour, precisely as coded:

- The check is `isIgnoredBasename(x.basename)` — applied to the **note basename**, never to
  aliases, never to phantom links, never per-suggestion, never in the comparator. That
  placement is correct: it is a refresh-time filter, so it costs O(files × prefixes) once
  per refresh and **zero** on the keystroke path.
- With `wordAsInternalLinkAlias: false` (the default), an ignored basename returns `[]`
  (`:119-121`) — **the note produces no candidate at all**, not "no basename candidate".
- With `wordAsInternalLinkAlias: true`, an ignored basename returns only its alias rows
  (`:102-104`).

Effect on this vault if configured as `char,chapter,world`: the `c` bucket drops from
**11,177** to roughly **700** values (11,177 − 4,936 `char…` − 5,514 `chapter…`, with
overlap between them resolved). Phantom links and alias rows survive. The bench does not
have a scenario for this; the equivalent would be `suggest-keystroke cha` re-run with a
filtered provider.

**Caveat that decides whether it is usable:** with the default alias mode, `Char - …` notes
stop being suggestible **entirely**, including via their aliases. Since 95.9 % of this
vault's wiki links carry display aliases, the alias-only path is what the writer actually
needs — so the honest configuration experiment is `suggestInternalLinkWithAlias: true` +
ignore prefixes, and then judge whether the alias-only list is pleasant. Do not assume it
is a free win.

---

## 8. What the bench does not cover

| Gap | Why it matters |
|---|---|
| **`fuzzyMatch: true`** (app default) | `bench/scenarios/suggest-keystroke.ts` calls `suggestWords` with `option = {}` or `{folderPriority}` only — no `fuzzy`. The default path is `microFuzzy` over every candidate, unmeasured. |
| **The app's actual default folderPriority** (`enabled: true, limitingFolder: ""`) | Bench models `fp off` (no option) and `fp on` (`limitingFolder: "Novel"` + cache). The default is a third case: `compareLinkTier` runs, `getList` misses. |
| **Per-save current-file reindex** | No `refresh-current-file` scenario exists, yet this fires ~every 2 s. |
| **Keystroke + save interaction** | `session-sim 300 keystrokes` p50 **399.290 ms** / p95 **457.141 ms** is the only combined number; it does not include a real autosave cadence. |
| **Real Obsidian rendering / other plugins** | Bench is Node + stubs. `typewriter-mode` and `sticky-headings-no-flicker` share the frame but are absent. |
| **In-app latency, at all** | No instrumentation exists. Every number is Node-side. |

Bench values above are from `bench/results/latest.md` (N = 21) as read on 2026-10-28; that
directory was subsequently regenerated by concurrent work. Re-run before external use.

---

## 9. Ranked fixes by impact / effort

Impact is judged against **this vault** (11,177-value `c` bucket, ~every-2 s autosave on
4,000–9,700-word chapters). Effort is engineering effort in this repo.

| # | Fix | Impact | Effort | Bench scenario to watch |
|---|---|---|---|---|
| **F1** | **Top-K selection instead of full sort** — replace `.sort().slice(0, maxNum)` (`suggester.ts:369-450`) with a bounded selection (keep `maxNum` via repeated max, or a partial quicksort). Removes ~144 k comparator calls at `cha`. | **High** | **Low** | `suggest-keystroke cha (fp off)` 2.550 → ? |
| **F2** | **Two-phase matching** — run the cheap concrete `startsWith` pass first; only invoke the fuzzy/alias machinery if fewer than `maxNum` concrete matches. Turns the default config from "scan 11,177 values char-by-char" into "prefix test". | **High** | Medium | needs a new `suggest-keystroke cha (fuzzy on)` scenario |
| **F3** | **Stop cloning non-surviving words in `judge`** — return `{word, matchedKind}` and clone only the final ≤5. Removes ~10.5 k object clones/keystroke (`:126-148`). | **Medium-High** | **Low** | `suggest-keystroke cha (fp off)`, and `session-sim 300 keystrokes` for GC pressure |
| **F4** | **Hoist the lowercased query** — compute `queryLower` once per pass; pass it into the matcher instead of `lowerStartsWith(value, query)` calling `query.toLowerCase()` per candidate (`strings.ts:71-73`, `suggester.ts:112-114`). | **Medium** | **Very low** | `suggest-keystroke cha (fp off)` |
| **F5** | **Prewarm cold rank caches off the keystroke path** — build `LinkRankIndex` global + the active folder's `FolderRankCache` list during `requestIdleCallback` / right after `resolved`, instead of lazily on the first keystroke. Kills the 30 ms + 27 ms stall. | **High** (worst single stall) | **Low-Medium** | `linkrank cold (Novel)` 30.161, `folderrank cold first folder` 27.487 |
| **F6** | **Move `ensureSummary` off the keystroke path** — compute the folder summary on the structure event (or idle), not on first `getList`. Also make the memo key not depend on a setting-change bump. Kills the 11 ms hitch after note create. | **Medium-High** | **Low** | `folderrank structure bump` 10.921 |
| **F7** | **Sub-bucket / sorted-array index for internal links** — index by 2–3 char prefix (or keep a sorted `value` array per first letter and binary-search the prefix range). Turns 11,177 judge calls into ~50 at `cha`. The real structural fix. | **Very high** | **High** | `suggest-keystroke cha (fp off)` + `refresh-internal-links cold` (must not regress) |
| **F8** | **Incremental current-file reindex** — tokenise only changed lines (or skip if the editor text hash is unchanged), instead of `clearWords()` + full re-`pushWord` on every save (`CurrentFileWordProvider.ts:30`, `:77-82`). | **High** (most frequent cost) | Medium-High | new `refresh-current-file` scenario |
| **F9** | **Char-code tokeniser** — replace `content[i].match(re)` with a `Set`/charCode lookup in `DefaultTokenizer.__tokenize:44-45`. 2–4× less alloc per char; helps F8 and every indexing path. | **Medium** | **Low-Medium** | new tokeniser micro-bench |
| **F10** | **Avoid `getValue()` for code/math detection** — use the CM6 syntax tree / `visibleRanges` instead of `app-helper.ts:158-160`. Removes two O(document) scans when `disableSuggestionsIn*` is on. | Medium (only if enabled) | Medium | `onTrigger` profile |
| **F11** | **Keyed dedupe instead of `uniqWith`** — `collection-helper.ts:28-32` is O(n²). Trivial here (n ≤ 15) but worth cleaning before anyone widens the input. | Low | **Very low** | `suggest-keystroke *` |
| **F12** | **Reuse the rank Map across passes** — key `linkRanks` by `createdPath`/`word.value` instead of `Word` identity, so it survives the clone and the query loop. | Low-Medium | Low-Medium | `suggest-keystroke cha (fp on)` 5.406 |

**Config-only mitigations** (no code, test first — they may be sufficient):

| # | Setting | Effect | Trade-off |
|---|---|---|---|
| **M1** | `delayMilliSeconds` > 0 (e.g. 40–80) | Coalesces fast typing into one pass per pause. Directly multiplies keystroke cost by the coalescing factor. | Slightly laggier popup. UX cap ~70 ms max; ~200 ms would maximize computational benefit. |
| **M2** | `minNumberOfCharactersTriggered` = 3–4 | Suppresses the popup for 1–2 char prefixes (`AutoCompleteSuggest.ts:1234-1243`) — and `c` with 0–2 chars is the worst case. | No suggestions until 3–4 chars. |
| **M3** | `maxNumberOfSuggestions` = 3 | Shrinks only the sort output. **Diagnostic value:** big improvement ⇒ sort (F1) dominates; no change ⇒ judge (F2/F4/F7) dominates. | Fewer options. |
| **M4** | `internalLinkIgnoreTriggerPrefixes` = `char,chapter,world` | Removes ~10,450 of 11,177 `c`-bucket values at refresh time, zero keystroke cost. | With default alias mode, those notes become unsuggestable (§7). Pair with `suggestInternalLinkWithAlias: true` and evaluate UX. |
| **M5** | `fuzzyMatch` = false | Skips `microFuzzy` entirely — the default's biggest unmeasured cost. | Stricter matching; typos stop matching. |
| **M6** | `folderPriority.enabled` = false | Skips `compareLinkTier` + the per-pass `linkRanks` Map. | Loses folder-proximity ordering. |

**Recommended order for a first PR:** F4 → F3 → F1 (all low effort, all measurable on
`suggest-keystroke cha`), then F5 → F6 (largest single stalls, low effort), then F2, then
F8/F7 as the structural work. F7 and F8 need a new bench scenario before/after or the
change is unfalsifiable.

---

## 10. Uncertainty

1. **No in-app measurement.** All milliseconds come from the Node bench harness with
   stubbed Obsidian APIs. No DevTools profile was captured. Nothing here proves the user's
   perceived lag is this plugin rather than `typewriter-mode`, `sticky-headings-no-flicker`,
   or CM6 rendering of a 9,700-word chapter.
2. **The bucket size (11,177) is an offline model**, not the plugin's live index. Real
   index size depends on `excludeInternalLinkPathPrefixPatterns`, glob excludes, tag/
   frontmatter excludes, `suggestInternalLinkWithAlias`, and the brand-new ignore prefixes.
   If the user already excludes folders, the real bucket is smaller. **[?]** — read the
   live `data.json` to close this.
3. **The bench's `suggest-keystroke` numbers exclude the default fuzzy path.** The
   magnitude of F2 is a reasoned estimate, not a measurement.
4. **Allocation counts (~43 k/keystroke) are derived by counting code sites**, not by a
   heap profile. Treat as an order-of-magnitude claim about GC pressure, not a measurement.
5. **Line numbers drift.** Several files are being edited concurrently
   (`src/setting/settings.ts` is modified in the working tree; `bench/` and `shared-core/`
   are new). Re-grep before acting on a specific line.
6. **`refreshCurrentFileTokens` cost is inferred** from `content.length` × per-char regex
   invocations. No scenario measures it. The estimate (single-digit ms for a median
   chapter, tens of ms for the largest) is plausible but unverified.
7. **Behavioural claims about `internalLinkIgnoreTriggerPrefixes`** are read from the code
   path, not observed in Obsidian. Specifically the "note becomes entirely unsuggestable"
   outcome when `suggestInternalLinkWithAlias` is false follows from
   `InternalLinkWordProvider.ts:119-121` returning `[]`; verify by testing (M4).

# Codebase Map — various-complements-with-folder-priority

Pointer system for jumping to the right file fast. Every entry = path + role + key exports + relationships, with `file:line` anchors on the hot spots.

**Plugin id / version**: `various-complements-with-folder-priority`, 11.4.1, minAppVersion 1.11.4 (`manifest.json`).
**Base**: upstream `tadashi-aikawa/obsidian-various-complements-plugin` @ 11.4.1 (`27e711a chore: bump version to 11.4.1 (upstream sync)`).
**Tests**: Jest (`jest.config.js`, `esbuild-jest`), colocated `*.test.ts`. `pnpm test` / `pnpm typecheck` (`tsgo -noEmit`).

> [!warning] Repo state at time of writing — read this first
> Baseline refactor committed at `f6f86ae` (tree was clean). This map, `README_FOR_AGENT.md`, and `research/performance-anti-patterns-analysis.md` were refreshed on 2026-10-27.
> **Post-2026-10-27 edits shift line anchors — re-grep before trusting numbers.**
> `src/storage/LinkFrequencyStorage.ts` is deleted; the shipped design is `LinkRank` + `LinkRankIndex`. Anything referencing `LinkFrequencyStorage` in docs is stale unless kept as an explicit historical marker.

> [!warning] Stale source — `research/performance-anti-patterns-analysis.md`
> Written pre-fork-integration. Several anchors are now wrong or resolved: it flags the `modify` handler as undebounced (now debounced, `AutoCompleteSuggest.ts`), and previously cited `src/storage/LinkFrequencyStorage.ts:69-94` (deleted). Its structural claims (unbounded `wordsByFirstLetter`, `selectionHistoryStorage` growth, `suggester` intermediate arrays) still hold. `README_FOR_AGENT.md` now describes the current `LinkRank` + `LinkRankIndex` design.

---

## 1. Inventory of `src/`

### 1.1 Plugin entry

| File | Lines | Role / key exports |
|---|---|---|
| `src/main.ts` | 251 | `export default class VariousComponents extends Plugin`. `onload()` `:26`, `onunload()` `:21` → `suggester.unregister()`. Creates `AppHelper` (`:27`), loads settings (`:176-183`, deep-merge over `DEFAULT_SETTINGS`), setting tab (`:30-31`), status bar (`:54-65`), **debounced history persist at 5000 ms** (`:67-78`), builds `AutoCompleteSuggest.new(...)` and `registerEditorSuggest` (`:80-86`), registers commands (`:88-173`). `saveSettings(needUpdateTokens)` `:185-215` is the single fan-out point from any settings change into `suggester.updateSettings()` + selective provider refreshes. |
| `src/app-helper.ts` | 407 | `export class AppHelper` — the only place raw Obsidian metadata APIs are touched. `getAliases()` `:65-71`, `getFrontMatter()` `:73-97`, `getTagsProperty()` `:99-108`, `getBoolFrontMatter()` `:110-114`, `getActiveFile()` `:125`, `optimizeMarkdownLinkText()` `:170-214`, `linkText2Path()` `:216-228`, `inCodeBlock()` `:239-241`, `inInlineCode()` `:243-245`, `searchPhantomLinks()` `:247-251`, `getResolvedLinks()` `:253-259`, `getUnresolvedLinks()` `:261-265`, `getCurrentFrontMatter()` `:298-333`, `useWikiLinks` / `newLinkFormat` `:398-406`. |

### 1.2 Suggestion providers (one class per word source)

`IndexedWords` (`AutoCompleteSuggest.ts:57-63`) is the join point: `{currentFile, currentVault, customDictionary, internalLink, frontMatter}` where the first four are `WordsByFirstLetter = {[firstLetter: string]: Word[]}` (`suggester.ts:19`) and `frontMatter` is `{[key]: WordsByFirstLetter}`.

| File | Provider for | Key methods / anchors |
|---|---|---|
| `src/provider/InternalLinkWordProvider.ts` | **internal links `[[...]]` — this is the fork's target provider** | `refreshWords(option)` `:18-135`, `clearWords()` `:137-140`, `wordCount` `:142-144`. Detail in §3. |
| `src/provider/CurrentFileWordProvider.ts` | words in the active file | `refreshWords()` `:23-83` (`vault.cachedRead` `:51`, full re-tokenize each call), `clearWords()` `:85-88`, `setSettings(tokenizer)` `:94-96`. |
| `src/provider/CurrentVaultWordProvider.ts` | words from all vault files | `refreshWords()` `:26-88`; enumerates `vault.getMarkdownFiles()` `:36-44`, `MAX_FILE_SIZE = 1MB` skip `:10` + `:51-55`, sequential `adapter.read` per file `:56`. `setSettings(tokenizer, include, exclude, excludeGlobs, onlyUnderCurrentDir)` `:99-111`. |
| `src/provider/CustomDictionaryWordProvider.ts` | user dictionaries (URL/local) | `refreshCustomWords()` `:174-195`, `addWordWithDictionary()` `:196`, `clearWords()` `:240`, `editablePaths` `:140`, `wordByValue` (unbounded) `:126`-ish. |
| `src/provider/FrontMatterWordProvider.ts` | front-matter values per key | `refreshWords()` `:71-85`, `updateWordIndex(file)` `:87-94` (incremental, per file), `updateWords()` `:96-99`, `wordsByCreatedPath` `:62`, `wordsByFirstLetterByKey` `:64`. |
| `src/provider/MatchStrategy.ts` | prefix vs partial dispatch | `MatchStrategy.PREFIX → suggestWords` `:34`, `PARTIAL → suggestWordsByPartialMatch` `:35-38`, `fromName()` `:47-54`. Handler option bag carries `folderPriority?: FolderPriorityOption` `:26`. |
| `src/provider/SpecificMatchStrategy.ts` | front-matter-only strategy | `INHERIT` (never-used handler) `:28-31`, `PREFIX` `:32`, `PARTIAL` `:33-36`. |

### 1.3 Suggestion engine (ranking)

| File | Role |
|---|---|
| `src/provider/suggester.ts` (803) | `WordsByFirstLetter` `:19`; `suggestionUniqPredicate()` `:29-47` (same value + same group + same `createdPath` for resolved internal links = duplicate); `pushWord()` `:49-60`; `judge()` `:63-153` (match + alias fallback); `suggestWords()` `:155-439` (prefix/first-letter); `judgeByPartialMatch()` `:443-512`; `suggestWordsByPartialMatch()` `:514-802`. Both suggest functions contain **duplicated** `compareLinkTier` closures (`:312-343` and `:669-700`) and duplicated comparator chains (`:354-433`, `:711-797`). |
| `src/model/Word.ts` (106) | Discriminated union `Word` `:48-53`; `InternalLinkWord` `:35-42` (`phantom?`, `aliasMeta?: {origin}`); `DefaultWord` `:8-20` (`value`, `type`, `createdPath`, `aliases`, plus post-judge `hit/fuzzy/query/offset/valueForHistory`); `WordTypeMeta` `:55-106` with `INTERNAL_LINK` priority **90** `:64-68` (frontMatter 100, customDictionary 80, currentFile 70, currentVault 60). |

### 1.4 Word / link rank caching (fork-added)

| File | Role |
|---|---|
| `src/model/FolderProximity.ts` (125) | Pure math. `FolderProximityScore` `:8-15`, `calculateFolderProximity()` `:25-59`, `calculateFolderLevel()` `:71-106` (private), `getParentFolder()` `:108-112`, `normalizeFolderPath()` `:114-116`, `isWithinFolder()` `:118-125`. |
| `src/model/LinkRank.ts` (84) | `LinkRankData` `:5-11`, `LinkRank` `:13-16`, `FolderPriorityOption` `:18-23`, `resolveTarget()` `:25-27`, `computeLinkRank()` `:29-69`, `getOrComputeLinkRank()` `:71-84`. |
| `src/storage/LinkRankIndex.ts` (102) | `class LinkRankIndex` `:4`; single-slot memo `cached` `:5`, `buildCalls` `:6`; `getRankData(currentFilePath, limitingFolder)` `:10-75`; `invalidate()` `:77-79`; private path helpers `:81-101`. |
| `src/storage/SelectionHistoryStorage.ts` (187) | Independent of folder priority. `SelectionHistoryTree` `:10-16`, `calcScore()` recency buckets `:24-50`, `purge()` `:77-130`, `getSelectionHistory()` `:132-134`, `increment()` `:136-167`, `compare()` `:169-178`, `shouldPersist`/`syncPersistVersion` `:180-186`. |

### 1.5 Settings

| File | Role |
|---|---|
| `src/setting/settings.ts` (1962) | `interface Settings` `:18-150`; internal-link block `:98-116`; provider trigger block `:123-127`; `folderPriority: {enabled, limitingFolder}` **`:139-143`**; `DEFAULT_SETTINGS` `:152-281` (internal-link defaults `:232-249`, folder-priority defaults **`:270-274`** = `{enabled:false, limitingFolder:""}`). `class VariousComplementsSettingTab` `:283`; `display()` `:292`; `addInternalLinkComplementSettings()` **`:1350-1701`** (folder-priority UI **`:1656-1701`**); `addFrontMatterComplementSettings()` `:1703`; `addIntelligentSuggestionPrioritizationSettings()` `:1762`. |
| `src/setting/settings-helper.ts` (21) | `namespace TextComponentEvent.onChange(component, handler)` — binds `change` (not `input`) events. |
| `src/setting/regex-validation.ts` + `.test.ts` | Validates user regexes before persisting. |
| `src/composables/settings/useFilterSetting.ts` (91) | `useFilterSetting(group)` → `{addFilterableSetting, refresh}` — the `visible:` filtering used by every settings section. |

### 1.6 UI / editor insertion

| File | Role |
|---|---|
| `src/ui/AutoCompleteSuggest.ts` (1521) | **The core.** `class AutoCompleteSuggest extends EditorSuggest<Word>` `:77`; `IndexedWords` `:57-63`; `static new()` `:189-293`; `updateSettings()` `:488-722`; `onTrigger()` `:1066-1265`; `getSuggestions()` `:1267-1273`; `renderSuggestion()` `:1275-1326`; `constructInternalLinkText()` `:1328-1410`; `selectSuggestion()` `:1412-1502`; refresh methods `:838-1064`; `predictableComplete()` `:295-363`. |
| `src/ui/popup-commands.ts` (289) | Hotkey actions invoked from `registerHotkeys()`. `select()` `:68`, `selectWithCustomAlias()` `:91` / `selectWithCustomAliasImpl()` `:29-66`, `selectWithCustomAliasAndAddToAliases()` `:99-138` (writes frontmatter aliases, then one-shot `metadataCache "changed"` → `refreshInternalLinkTokens()` `:131-134`), `selectWithQueryAlias()` `:140-166`, `insertAsText()` `:168`, `selectNext/Previous()` `:200-222`, `open()` `:224`, `completion()` `:245`. |
| `src/ui/editor-insertion.ts` (37) | **Fork-added.** `COMPLETION_USER_EVENT = "input.complete"` `:7`; `undoIsolationAnnotation()` `:10-12`; `insertWithIsolatedUndoStep(editor, text, from, to?, origin?)` **`:21-37`** — `editor.replaceRange(..., origin)` then an empty `cm.dispatch` with `isolateHistory.of("full")`. Used by `AutoCompleteSuggest.selectSuggestion()` `:1465`, `predictableComplete()` `:312,354`, `popup-commands.ts` `:187,279`. Background: `research/codemirror6-undo-history-grouping-obsidian.md`. |
| `src/ui/ProviderStatusBar.ts` (137) | `class ProviderStatusBar`; per-provider `setXIndexing/Indexed/Disabled` (internal link: `:92`, `:108`, `:124`). |
| `src/ui/CustomDictionaryWordAddModal.ts` (49) | Modal for "Add to custom dictionary". |
| `src/ui/component/InputDialog.ts` (69) | `class InputDialog extends Modal` — used for "type custom alias". |
| `src/ui/component/CustomDictionaryWordAdd.svelte` | Svelte form for the add-word modal. |
| `src/ui/component/ObsidianButton.svelte`, `ObsidianIconButton.svelte` | Small Obsidian-styled button wrappers (used by Svelte components). |

### 1.7 Tokenizer

| File | Role |
|---|---|
| `src/tokenizer/tokenizer.ts` (55) | `interface Tokenizer` `:18-23`; `createTokenizer(strategy, app, settings)` `:25-55` (Chinese requires `cedict_ts.u8`). |
| `src/tokenizer/TokenizeStrategy.ts` (40) | `DEFAULT(3,5)`, `ENGLISH_ONLY(3,5)`, `JAPANESE(2,2)`, `ARABIC(3,3)`, `CHINESE(1,2)`, `KOREAN(1,2)`; `triggerThreshold` / `indexingThreshold` `:12-22`. |
| `src/tokenizer/tokenizers/AbstractTokenizer.ts` (45) | **Trigger-char definition lives here**: `INPUT_TRIM_CHAR_PATTERN` **`:9`** and `INDEXING_TRIM_CHAR_PATTERN` `:10` — both include `[` and `]` (also `/ : ? ! = ( ) < > " ' , \| ; * ~ \``). `getTrimPattern(target)` `:25-34`. |
| `.../DefaultTokenizer.ts` (70) | `tokenize()` `:7-15`, `recursiveTokenize()` `:17-34`, char-scanner `__tokenize()` `:37-69`. |
| `.../EnglishOnlyTokenizer.ts` / `JapaneseTokenizer.ts` / `KoreanTokenizer.ts` / `ArabicTokenizer.ts` / `ChineseTokenizer.ts` | Strategy-specific segmentation (Chinese uses `src/external/chinese-tokenizer.d.ts` + segmenter). |
| `src/external/tiny-segmenter.ts` (1507) | Vendored Japanese segmenter. |

### 1.8 Util / misc

| File | Role |
|---|---|
| `src/util/strings.ts` (314) | `synonymAliases(name, {emoji, accentsDiacritics})` `:46-62`, `lowerStartsWith` `:71`, `lowerIncludes` `:63`, `wrapFuzzy` `:75-80`, `lowerFuzzy` `:86`, `lowerFuzzyStarsWith` `:90`, `capitalizeFirstLetter` `:98`, `applyQueryFirstLetterCase` `:102`, `startsSmallLetterOnlyFirst` `:157`, `isInternalLink(text)` `:161-163` (`/^\[\[.+]]$/`), `isEOTinCodeBlock` `:267`, `isInsideInlineCode` `:311`, `excludeEmoji`, `findCommonPrefix` `:188-201`, `microFuzzy` `:208`. |
| `src/util/glob.ts` (17) | `isMatchedGlobPatterns(path, patterns)` — used by internal-link and vault exclusions. |
| `src/util/path.ts` (20) | `basename`, `extname`, `dirname`, `isURL`, `DEFAULT_HISTORIES_PATH` `:19-20` (= `.obsidian/plugins/various-complements-with-folder-priority/histories.json`). |
| `src/util/collection-helper.ts` (90) | `groupBy`, `uniq`, `uniqBy`, `uniqWith` `:28`, `hasSameElement` `:34`, `setEquals` `:68`, `max` `:87`. |
| `src/util/diacritics-map.ts` (279) | Accent → base-letter table. |
| `src/option/ColumnDelimiter.ts` (24) | `class ColumnDelimiter` (`Tab` / `Comma`). |
| `src/option/DescriptionOnSuggestion.ts` (35) | `class DescriptionOnSuggestion` — `toDisplay(word)`, drives the second line in `renderSuggestion`. |
| `src/keys.ts` (73) | `MOD`/`ALT`, `Hotkey` type, `hotkey2String` / `string2Hotkey` / `equalsAsHotkey`. |
| `src/types.ts` (7) | `PartialRequired<T,K>`, `isPresent`. |
| `src/errors.ts` (5) | `class ExhaustiveError`. |

---

## 2. Data flow: keystroke → suggestion

Registered once at `src/main.ts:86` (`registerEditorSuggest`), so Obsidian's `EditorSuggest` framework owns the trigger loop.

| # | Hop | Concrete code |
|---|---|---|
| 0 | Obsidian calls `onTrigger(cursor, editor)` | `src/ui/AutoCompleteSuggest.ts:1066` |
| 1 | **Gates** (line-level, *not* `[[`-specific): auto-complete disabled `:1082-1089`; IME `:1091-1098`; unchanged line `:1105-1116`; line starts with `---` `:1118-1125`; `patternsToSuppressTrigger` (pre-compiled) `:1126-1134`; math block `:1136-1144` / code block `:1146-1154`; current phrase shorter than `minNumberTriggered` `:1208-1217`; first char in `firstCharactersDisableSuggestions` `:1188-1196`; whitespace-suffix unchanged `:1174-1187`. | — |
| 2 | **Trigger chars**: there is **no explicit `[[` detector**. `[` and `]` are trim characters (`src/tokenizer/tokenizers/AbstractTokenizer.ts:9`), so `[[Foo` tokenizes into `[[Foo` **and** `Foo`. Tokenization: `tokenize(lineUntilCursor, true)` `:1156`, `recursiveTokenize()` `:1159`, phrase window capped by `maxNumberOfWordsAsPhrase` `:1160-1164`, phrase = first token `:1167`. | `AbstractTokenizer.ts:9`, `DefaultTokenizer.ts:17-34` |
| 3 | **Query payload**: returns `EditorSuggestTriggerInfo` with `query = JSON.stringify({currentFrontMatter, completionMode, queries: [{word, offset}]})`; offsets normalized against the first token so insertion can start *after* the brackets. `contextStartCh` set at `:1248`. | `:1250-1264` |
| 4 | **Debounce**: `getSuggestions()` wraps `debounceGetSuggestions` in a Promise. The debouncer is (re)built inside `updateSettings()`, delay = `settings.delayMilliSeconds`, `immediate = true`. | `:1267-1273`, `:563-564`, `:713-714` |
| 5 | **Mode short-circuits**: `completionMode === "new"` → synthesize phantom `internalLink` words from the typed query (`createNewLinkSuggestions`) `:577-593`. Partial-fallback (`completionMode !== matchStrategy.name && === "partial"`) filters to internal links only, else phantom `:674-683`. | — |
| 6 | **Strategy dispatch**: per query token, `MatchStrategy.handler` (or `frontMatterComplementStrategy.handler`) → `suggestWords` (prefix) / `suggestWordsByPartialMatch` (partial). | `:620-630`, `provider/MatchStrategy.ts:34-38` |
| 7 | **Candidate collection** (before matching): `this.indexedWords` merges all providers' `wordsByFirstLetter`. Prefix mode indexes by first letter **and** case-variant of `query[0]`. Partial mode flattens every bucket. | `:478-486`; `suggester.ts:210-268` / `:559-587` |
| 8 | **Match**: `judge()` — `matcher = fuzzy ? lowerFuzzy : wrapFuzzy(lowerStartsWith)`; tries `value` first, then each `alias` (alias hit ⇒ `alias: true`, `word.hit = <alias text>`). Partial mode adds startsWith → includes passes for both value and aliases. `excludeInternalLink` / `providerMinChars` gate providers at collection. | `suggester.ts:63-153`, `:376-512`, `:187-198` |
| 9 | **Ranking** (comparator, in order): ① fuzzy-vs-concrete ② front-matter pin ③ **`compareLinkTier` (fork hook)** ④ selection-history recency ⑤ shorter value first ⑥ `WordTypeMeta.priority` ⑦ non-alias before alias. | `suggester.ts:354-433` (prefix), `:711-797` (partial); tier at `:330-339` / `:693-696` |
| 10 | **Cap + dedupe**: `.slice(0, maxNum)` then `uniqWith(candidate, suggestionUniqPredicate)` — note dedupe runs **after** slicing, so the result can be shorter than `maxNumberOfSuggestions`. | `suggester.ts:434-438`, `:798-802` |
| 11 | **Post-filters in caller**: `excludeSelfInternalLink` `:685-691`; `excludeExistingInActiveFileInternalLinks` (uses `metadataCache.resolvedLinks[activeFile]`) `:693-700`; final `uniqWith` + slice `:702-707`. | — |
| 12 | **Render**: `renderSuggestion()` builds `div`s; alias rows get `various-complements__suggestion-item__content__alias`; phantom rows get `__phantom`. | `:1275-1326` |
| 13 | **Insert**: `selectSuggestion()` → `constructInternalLinkText()` → `insertWithIsolatedUndoStep()` → `selectionHistoryStorage.increment()`. | `:1412-1502`, `:1328-1410`, `ui/editor-insertion.ts:21-37`, `:1494` |

**Alternate entry points that bypass `EditorSuggest`:**
- `triggerComplete({fallbackLinkify})` `:149-168` — calls Obsidian's private `trigger`; flips `completionMode` to `partial`/`new` (this is how "fallback linkify" wraps an arbitrary word in `[[...]]`).
- `predictableComplete()` `:295-363` + `collectPredictableCandidates()` `:365-405` — cycles through words visible around the cursor; inserts directly, no suggest popup.

---

## 3. The internal-link provider in detail

File: **`src/provider/InternalLinkWordProvider.ts`** (145 lines). Constructed at `AutoCompleteSuggest.ts:209-212`, fed at `:959-971`, cleared at `:949`.

**Obsidian APIs it uses** (all via `AppHelper`, `src/app-helper.ts`):
- Enumeration: `app.vault.getMarkdownFiles()` `:30-31` — no `getLinkpathDest`, **no `metadataCache.getCache()` call here**; per-file cache is read indirectly through `getAliases` → `metadataCache.getFileCache(file)?.frontmatter` (`app-helper.ts:65-71`).
- Front-matter exclusion bool: `getBoolFrontMatter` → `getFileCache(...).frontmatter[key]` (`app-helper.ts:110-114`) `:43-46`.
- Tag exclusion: `getTagsProperty` → `parseFrontMatterTags` (`app-helper.ts:99-108`) `:48-53`.
- Unresolved links: `appHelper.searchPhantomLinks()` → `Object.entries(metadataCache.unresolvedLinks)` (`app-helper.ts:247-251`) `:114`.
- Link-target resolution for *ranking* is **not** done here — it happens in `LinkRankIndex` from `metadataCache.resolvedLinks` / `unresolvedLinks` (§4).

**Per-file work** `:57-109`:
1. `aliases = appHelper.getAliases(x)` (frontmatter `aliases`/`alias`, parsed by Obsidian).
2. Filter chain first `:32-56`: path prefix excludes → glob excludes → `frontMatterKeyForExclusionInternalLink` truthy → `tagsForExclusionInternalLink` intersection.
3. **Two mutually exclusive alias modes**:
   - `wordAsInternalLinkAlias = true` (`suggestInternalLinkWithAlias`) `:60-85`: emits **one word per basename** (no `aliasMeta`) **plus one word per alias** with `aliasMeta: {origin: x.path}`. Aliases are individually searchable and render as `[[path|alias]]`.
   - `wordAsInternalLinkAlias = false` (default) `:86-108`: emits **a single word** whose `value` is `x.basename`; `aliases` = `synonymAliases(basename)` ++ frontmatter aliases ++ `synonymAliases(each alias)`. Typing an alias still matches (via `judge()`'s alias pass) but yields `alias: true` and the *alias text* as `hit`, with insertion built from `createdPath`.
4. `description: x.path` on every word (drives the second suggestion line via `DescriptionOnSuggestion`).

**Phantom (unresolved) words** `:111-126`: skipped entirely when `excludeUnresolvedLinks`; otherwise one word per `(path, link)` pair, `phantom: true`, `createdPath` = **source file path** (not a target!), `description: "Appeared in -> <path>"`. This `createdPath`-is-a-source detail is the reason `computeLinkRank` has a separate phantom branch (§4).

**Indexing** `:128-134`: `this.words = [...resolved, ...phantom]`, then `pushWord(wordsByFirstLetter, word.value[0], word)` and the same for each alias — so one word may appear in several buckets. `refreshWords` always starts with `clearWords()` `:28` (full rebuild, no incremental path).

**Cost per refresh**: O(markdown files × aliases) + O(unresolved links). No folder/backlink work, no vault reads (metadata cache only) — cheap relative to `CurrentVaultWordProvider`.

---

## 4. The fork's folder-prioritization logic

### 4.1 Files and functions

| File | Function | What it does |
|---|---|---|
| `src/model/FolderProximity.ts` | `calculateFolderProximity(linkSourceFolders: Map<folder,count>, currentFilePath, limitingFolder)` `:25-59` | Returns the **best** (highest-score) proximity across all source folders. Early-out `{level:999, frequency:0, score:0}` if the current file is outside `limitingFolder` `:34-36`; skips source folders outside it `:42-44`. |
| | `calculateFolderLevel(current, target, limiting)` `:71-106` | Level from common-prefix length: same folder ⇒ 0 `:76`; target is an ancestor ⇒ `currentDepth - common` `:96-101`; otherwise **siblings/cousins ⇒ sum of both depths from the common ancestor** `:103-105` (so siblings land at 2, not 1). |
| | `isWithinFolder` `:118-125`, `normalizeFolderPath` `:114-116`, `getParentFolder` `:108-112` | Path helpers (`/`-separated, leading/trailing slashes stripped). |
| `src/model/LinkRank.ts` | `computeLinkRank(word, option)` `:29-69` | Produces `{fileTier, folderProximity}` for one word. |
| | `resolveTarget(word)` `:25-27` | `word.createdPath ?? word.aliasMeta?.origin`. |
| | `getOrComputeLinkRank(word, option, cache)` `:71-84` | Memoizes per suggestion pass in a `Map<Word, LinkRank>`; returns `undefined` for non-internal-link words. |
| `src/storage/LinkRankIndex.ts` | `getRankData(currentFilePath, limitingFolder)` `:10-75` | Builds / returns `LinkRankData` (§4.3). |
| `src/storage/FolderRankCache.ts` | `getList(...)` (lazy build) | Per-leaf-folder precomputed rank lists; qualified by file count and leaf-ness, LRU 512. *(updated 2026-10-27)* |
| `src/provider/suggester.ts` | `compareLinkTier()` `:312-343` (prefix) and `:669-700` (partial) | The comparator stage that applies the rank. |

### 4.2 Scoring rule (exact)

```
score = frequency / (level + 1)        // FolderProximity.ts:51
level = 0 same folder | depthDiff if ancestor | sum(depths) if sibling/cousin
```

`frequency` = number of link occurrences from files in that source folder, aggregated by `LinkRankIndex` `:38-41`.

**Rank order applied to a pair of internal-link words** (`compareLinkTier`):
1. `fileTier` mismatch → the word whose target is already linked from the current file wins (`suggester.ts:326-327` / `:683-684`).
2. Higher `folderProximity.score` wins (`:330-333` / `:687-690`); missing proximity is treated as `-1`.
3. Lower `folderProximity.level` wins as tiebreak (`:336-339` / `:693-696`).
4. Otherwise `0` → falls through to selection history, length, word-type priority, alias flag.

`fileTier` semantics (`LinkRank.ts:38-54`): non-phantom → `currentFileTargets.has(target)`; phantom → `currentFileUnresolvedNames.has(word.value.toLowerCase())`.

### 4.3 Data structures (where folder data lives)

```ts
// src/model/LinkRank.ts:5-11
type LinkRankData = {
  builtForFilePath: string | null;          // cache validity key
  builtForLimitingFolder: string;           // cache validity key
  currentFileTargets: Map<string, number>;  // targetPath -> count, from resolvedLinks[currentFile]
  currentFileUnresolvedNames: Map<string, number>; // lowercasedName -> count, from unresolvedLinks[currentFile]
  targetToSourceFolders: Map<string, Map<string, number>>; // targetPath -> (sourceFolder -> occurrences)
};
```

`targetToSourceFolders` is the **inverted index**: built by walking `metadataCache.resolvedLinks` (`LinkRankIndex.ts:22-44`), skipping source folders outside `limitingFolder`, summing counts per `(target, sourceFolder)`.

Caches (there are **three** logical caches, all in memory, all non-persistent):
- `LinkRankIndex` — **two-part cache**: a global vault inversion keyed on `limitingFolder` (`:4-14`) plus a per-current-file `fileTier` part keyed on `currentFilePath` (`:15-20`). Stale sources are applied differentially at `getRankData` time (`:40-42`, `:202-293`) with a 5000-target fallback to full rebuild (`:212-216`); `invalidate()` only clears the cache on `"resolved"` and settings updates. `buildCalls` counter `:29`/`:196` exists for tests.
- `linkRanks: Map<Word, LinkRank>` — per suggestion pass, discarded each call `suggester.ts:311`, `:668`.
- `FolderRankCache` — per-leaf-folder precomputed rank lists (LRU 512; MAX_LIST_SIZE 500, TOP_K 1000 ranks), built lazily by `getList()` from `LinkRankData` and the vault summary. No persistence. `LinkRankIndex` version bumps only when link data changes (delta-aware); folder qualification rescans only when its `structureEpoch` changes (create/rename/delete) or first run.

There is **no per-folder persistent cache, no plugin data file** for folder scores. `Word` no longer carries folder data (the old `folderPriority`-era `folderFrequency?: Map<string,number>` was removed from `src/model/Word.ts`; see `git diff HEAD -- src/model/Word.ts`).

### 4.4 Where it is wired in

- Option built per suggestion call: `AutoCompleteSuggest.ts:653-665` — only when `settings.folderPriority?.enabled`; `currentFilePath` = `appHelper.getActiveFile()?.path`, `limitingFolder` = `settings.folderPriority.limitingFolder`, `rankData` = `linkRankIndex.getRankData(...)`.
- Threaded through `MatchStrategy` / `SpecificMatchStrategy` handler option bags → `suggestWords` / `suggestWordsByPartialMatch` → `compareLinkTier`.
- Fully inert when `enabled = false` (`compareLinkTier` returns 0 immediately, `suggester.ts:313-314`) or when `limitingFolder === ""` (no `folderProximity`, only `fileTier` still applies — `LinkRank.ts:52-66`).

---

## 5. All caching / refresh points

| Cache / index | Built at | Refreshed / invalidated by | Anchor |
|---|---|---|---|
| **Internal-link word index** | `refreshInternalLinkTokens()` `:943-979` (rebuild-all) | Unconditional 1000 ms debounce on `metadataCache "changed"` (`:272-279`); also `vault "rename"` / `"delete"` / `"create"` (`:243-258`), `workspace "active-leaf-change"` (`:260-269`), `metadataCache "resolved"` one-shot (`:283-294`), settings save with `{internalLink:true}` (`main.ts:252`), and `popup-commands.ts:131-134` after writing an alias. `updateInternalLinksOnSave` is deprecated and no longer gates refreshes. | `AutoCompleteSuggest.ts:234-294`, `943` |
| **Current-file word index** | `refreshCurrentFileTokens()` `:838-869` (`vault.cachedRead` + full re-tokenize) | **300 ms debounce** on `vault "modify"`: `debouncedRefreshCurrentFileTokens` `:223-231` → `modify` handler `:233-236`; plus `active-leaf-change` `:251`, settings `main.ts:197-199`. Debounce also drives history persistence `:227-230`. | `:223-236` |
| **Current-vault word index** | `refreshCurrentVaultTokens()` `:871-901` → `CurrentVaultWordProvider.refreshWords()` (reads every md file, 1 MB skip) | `metadataCache "resolved"` `:285`; manual command `main.ts:97-103`; settings `main.ts:200-202`. **No per-file incremental update, no modify handler.** | `:871` |
| **Custom-dictionary index** | `refreshCustomDictionaryTokens()` `:903-941` | `"resolved"` `:283`; command `main.ts:88-95`; settings `main.ts:203-205`. | `:903` |
| **Front-matter index** | `refreshFrontMatterTokens()` `:981-1005`; incremental `updateFrontMatterTokenIndex(file)` `:1022-1042` + `updateFrontMatterToken()` `:1044-1064` | `"changed"` → per-file index, then global re-flatten when the changed file is not the active one `:258-264`; `"resolved"` `:281`; `active-leaf-change` `:254`; settings `main.ts:209-211`. | `:258-264` |
| **`LinkRankIndex` (folder/link rank)** | lazy `getRankData()` on first suggestion after a miss `LinkRankIndex.ts:34-81` | Differential apply of `onRename` / `onDelete` / `markSourceStale` at lookup time (`LinkRankIndex.ts:102-121`, `:202-293`), with `MAX_DIFF_TARGETS = 5000` fallback to full rebuild (`:212-216`). `invalidate()` is only called on `metadataCache "resolved"` (`AutoCompleteSuggest.ts:285`) and `updateSettings` (`:497`). `active-leaf-change` no longer invalidates the rank cache. | `LinkRankIndex.ts:34-81` |
| **`FolderRankCache` (per-folder rank lists)** | lazy `getList()` on first visit to a qualified leaf folder `FolderRankCache.ts` | Built from `app.vault.getMarkdownFiles()` leaf qualification (≥20, ≤2000 files), 512-list LRU, top-1000 ranks of top-2000 entries. Invalidated by limiting-folder switch, `LinkRankIndex` version bump, and `updateSettings`. *(updated 2026-10-27)* | `FolderRankCache.ts` |
| **Selection history** | `refreshIntelligentSuggestionPrioritization()` `:1007-1020` (loads `histories.json`, `purge()`) | In-memory `increment()` per selection `:1494`; persisted by `main.ts:67-78` (5000 ms debounce, `shouldPersist` gate); rebuilt on settings save `main.ts:212-214`. | `:1007`, `main.ts:67-78` |
| **Compiled regexes** | `updateSettings()` `:492-529` (`patternsToSuppressTrigger`, `firstCharactersDisableSuggestions`, `phrasePatternsToSuppressTrigger` + `^...$`) | Every `updateSettings` (i.e. every settings save) and `Main`-level `saveSettings`. | `:490-529` |
| **Tokenizer instance** | `createTokenizer()` in `updateSettings()` `:537-544` | Same. Also pushed into providers at `:545-561`. | `:537-561` |
| **Hotkey handlers** | `registerHotkeys()` `:752-836` (clears `keymapEventHandler` first `:754-755`) | Every `updateSettings` `:721`. | `:752` |

**Startup nuance worth knowing**: `AutoCompleteSuggest.new()` (`:189-293`) calls `updateSettings` + `refreshIntelligentSuggestionPrioritization` but **does not** call any provider `refresh*` method. All indexes stay empty until Obsidian emits `metadataCache "resolved"` (`:277-288`). If that event never fires (e.g. plugin loaded into an already-resolved workspace, or the event name/order changed), internal-link suggestions stay empty until a manual reload command or a file switch.

**Event wiring is registered directly on `app.vault` / `app.workspace` / `app.metadataCache`** (`:233-288`) and torn down manually in `unregister()` `:407-414` (called from `main.ts:23`), guarded by the `unloaded` flag `:128`.

---

## 6. Settings that affect internal-link suggestions

All keys live in `src/setting/settings.ts`; consumption points are in `src/ui/AutoCompleteSuggest.ts` unless noted.

| Setting key | Default | Consumed at | Effect on suggestions |
|---|---|---|---|
| `enableInternalLinkComplement` | `true` | `:947-957` | Hard off-switch: clears the provider's words. |
| `suggestInternalLinkWithAlias` | `false` | `:960` → provider `:60-108` | Switches alias mode: aliases become standalone words with `aliasMeta` (vs merged into `aliases[]`). |
| `prioritizeAliases` | `true` | `suggester.ts` | When both a filename and an alias match, rank the alias suggestion first. |
| `suggestAliasesOnly` | `false` | `InternalLinkWordProvider.ts` | Suppresses bare-filename suggestions for aliased notes; requires `suggestInternalLinkWithAlias`. |
| `preserveFirstLetterCaseOnInternalLink` | `false` | `:1429-1431` → `:1339-1342` | Applies the typed case to the displayed alias text. |
| `excludeInternalLinkPathPrefixPatterns` | `""` (newline-separated) | `:470-474`, `:961` → provider `:33-37` | Drops target files by path prefix. |
| `excludeInternalLinkPathGlobPatterns` | `[]` | `:962-963` → provider `:39-41` (`util/glob.ts`) | Drops target files by glob. |
| `excludeSelfInternalLink` | `false` | `:685-691` | Post-filter: removes links whose `createdPath` is the active file. |
| `excludeExistingInActiveFileInternalLinks` | `false` | `:693-700` | Post-filter via `metadataCache.resolvedLinks[activeFile]`. |
| `excludeUnresolvedInternalLinks` | `false` | `:970` → provider `:111-113` | Drops all phantom words. |
| `excludeInternalLinksInCode` | `false` | `:605-609` → `excludeInternalLink` option → `suggester.ts:190, 549` | Suppresses internal links (only) when the cursor is in inline code or a code block; skipped during explicit linkify/partial fallback. |
| `updateInternalLinksOnSave` | `true` | `AutoCompleteSuggest.ts` | Deprecated — the internal link index now auto-refreshes about 1 second after any note change. Kept for compatibility. |
| `insertAliasTransformedFromDisplayedInternalLink.{enabled,beforeRegExp,after}` | `false` | `:1365-1380` | Post-processing of the inserted link text. |
| `frontMatterKeyForExclusionInternalLink` | `""` | `:967-968` → provider `:43-46` | Excludes target files with a truthy frontmatter flag. |
| `tagsForExclusionInternalLink` | `[]` | `:969` → provider `:48-53` | Excludes target files carrying any of these tags. |
| `internalLinkMinNumberOfCharactersForTrigger` | `0` | `:647-648` (per-provider gate), `:440` (min trigger) | Per-provider minimum query length. |
| **`folderPriority.enabled`** | `true` | `AutoCompleteSuggest.ts` | Turns §4 ranking on/off. |
| **`folderPriority.limitingFolder`** | `""` | `AutoCompleteSuggest.ts` | Root folder bounding the proximity calculation; empty ⇒ only `fileTier` applies. |
| `matchStrategy` | `"prefix"` | `:421-423`, `:156` | Chooses `suggestWords` vs `suggestWordsByPartialMatch` (both implement §4). |
| `maxNumberOfSuggestions` | `5` | `:435`, `:799` | Slice size (applied before dedupe). |
| `delayMilliSeconds` | `0` | `:713-714`, `:717-719` | Debounce for `getSuggestions` and close. |
| `fuzzyMatch` / `minFuzzyMatchScore` | `true` / `0.5` | `:634-638` | Fuzzy matcher + threshold in `judge()`. |
| `minNumberOfWordsTriggeredPhrase` | `1` | `:615` | How many phrase tokens must clear the minimum length. |
| `enableFrontMatterComplement`, `frontMatterComplementMatchStrategy` | `false`, `"inherit"` | `:622-626`, `:1100` | Decides whether the front-matter path (which pins one type) intercepts. |

Settings UI for all internal-link + folder-priority keys: `src/setting/settings.ts:1350-1701` (folder priority subheader at `:1656`, toggle `:1668-1683`, limiting-folder text `:1685-1700`). Every change calls `plugin.saveSettings({internalLink: true})` → `main.ts:206-208` → full internal-link rebuild + `linkRankIndex.invalidate()`.

---

## 7. Tests

Runner: `pnpm test` → `jest --coverage` (`package.json`), transform `esbuild-jest` (`jest.config.js`). Obsidian is mocked per-test via `as unknown as App` casts.

| Test file | Covers | Anchors |
|---|---|---|
| `src/provider/suggester.test.ts` (2530) | `pushWord` `:16`; `judge` table tests `:57`, `:102`; `suggestWords` `:150-1229`; `suggestWordsByPartialMatch` `:1230-2264`; **`describe("folder priority ranking")` `:2265-2530`** — 8 cases: file-tier beats shorter non-tier (prefix `:2314`, partial `:2331`), same-folder beats out-of-limit source `:2348`, resolved beats phantom `:2368`, history decides on tier tie `:2409`, non-internal pairs unaffected `:2436`, basename+alias share tier `:2465`, `enabled=false` ≡ no option `:2511`. | `suggester.test.ts:2265` |
| `src/model/FolderProximity.test.ts` (223) | `calculateFolderProximity` only: same folder `:5`, parent `:26`, sibling `:64`, outside limiting folder `:108`, multiple folders `:144`, edge cases `:191`. | `:4` |
| `src/model/LinkRank.test.ts` (196) | `computeLinkRank` (`:33`): `fileTier` from `createdPath` `:42`-ish, `aliasMeta.origin` fallback `:65`, phantom mismatch `:83`, phantom lowercase hit `:101`, `limitingFolder:""` ⇒ no proximity `:119`, missing inverted entry `:138`, out-of-limit folders filtered `:153`, disabled ⇒ no proximity `:179`. | `:37` |
| `src/storage/LinkRankIndex.test.ts` (~447 lines / 16 tests) | Inversion + count aggregation, two-part memoization (`buildCalls === 1` when only the current file changes), `invalidate()`, out-of-limit-folder filtering, empty-`limitingFolder` file-tier maps, differential `markSourceStale`/`onRename`/`onDelete`, 5000-target fallback, and a 30-step randomized differential-vs-full parity test. | `:113` |
| `src/ui/editor-insertion.test.ts` (153) | Undo isolation: completion gets its own undo step, next keystroke doesn't merge; control case showing plain insert merges; annotation equality. | `:82-153` |
| Others (unchanged upstream) | `src/util/strings.test.ts` (544, incl. `isInternalLink` `:231-237`), `collection-helper.test.ts`, `glob.test.ts`, `path.test.ts`, tokenizer tests (`DefaultTokenizer`, `EnglishOnly`, `Japanese`, `Korean`), `src/setting/regex-validation.test.ts`. | — |

**Coverage gaps that matter for this fork**
- **`InternalLinkWordProvider.test.ts`** now covers alias mode, phantom links, and exclusion filters; `AutoCompleteSuggest` wiring itself remains untested.
- **No test of `AutoCompleteSuggest` wiring**: the `folderPriority` option construction (`:653-665`), the `enabled` gate, the refresh triggers (`:233-294`), and differential `LinkRankIndex` invalidation calls are all untested (the class is hard to instantiate — `EditorSuggest` + private ctor `:143`).
- **No test of the `"changed"` → `refreshInternalLinkTokens` gating** logic (`:265-273`), including the `previousLinksCacheInActiveFile` comparison `:269-272`.
- `suggester.test.ts` never exercises `folderPriority` together with `frontMatter` pinning, nor the `compareLinkTier` path in `suggestWords` for alias-mode words created by the provider.

---

## 8. Known hot spots

### Top 5 — open these first

| # | File | Why it's first |
|---|---|---|
| 1 | **`src/provider/InternalLinkWordProvider.ts`** | Everything about *what* an internal-link suggestion is. Alias word construction `:60-108` (two mutually exclusive modes), phantom words `:111-126` (note `createdPath` = source file), first-letter + alias indexing `:129-134`, exclusion filters `:32-56`. A missing alias almost always starts (and often ends) here. |
| 2 | **`src/provider/suggester.ts`** | Matching and ordering. Alias matching in `judge()` `:123-147`; the tier comparator `compareLinkTier` `:312-343` / `:669-700`; full comparator chain `:354-433` / `:711-797`; dedupe-after-slice `:434-438`. |
| 3 | **`src/model/LinkRank.ts`** | Per-word rank semantics: `resolveTarget()` `:25-27` (`createdPath ?? aliasMeta?.origin` — the alias-origin fallback), phantom tier `:38-43`, proximity gating on `enabled`/`limitingFolder`/`currentFilePath` `:52-66`. |
| 4 | **`src/ui/AutoCompleteSuggest.ts`** | Wiring: `folderPriority` built at `:653-665`, `refreshInternalLinkTokens()` `:943-979`, event/refresh graph `:233-288`, post-filters `:685-700`. |
| 5 | **`src/setting/settings.ts`** | The switches themselves: keys `:98-116`, defaults `:232-249`, folder-priority defaults `:270-274`, UI `:1350-1701`. |

### Runners-up

- `src/model/FolderProximity.ts` — level math (`calculateFolderLevel` `:71-106`), score formula `:51`, out-of-limit early-outs `:34-36` / `:42-44`.
- `src/storage/LinkRankIndex.ts` — inversion of `metadataCache.resolvedLinks` `:123-200`; two-part cache (`global` + `filePart`) `:4-20`; differential stale-source apply `:202-293`; `invalidate()` `:83-89`.
- `src/app-helper.ts` — `getAliases` `:65-71` (frontmatter aliases), `searchPhantomLinks` `:247-251`, `getResolvedLinks` `:253-259`.

### Symptom → where to look

| Symptom | First files (in order) |
|---|---|
| "Alias-typed internal link does not appear" | `InternalLinkWordProvider.ts:60-108` (is `suggestInternalLinkWithAlias` on? are aliases merged or separate words?) → `suggester.ts:123-147` (does the alias pass run? `minMatchScore`?) → `app-helper.ts:65-71` (is `parseFrontMatterAliases` returning anything? cache stale?) → `AutoCompleteSuggest.ts:234-294` (did a debounced internal-link rebuild actually fire?) |
| "Alias link appears but ranks wrong / folder priority ignored" | `AutoCompleteSuggest.ts:653-665` (enabled? `limitingFolder` set? active file path resolved?) → `LinkRank.ts:25-27` (`aliasMeta.origin` present for alias words?) → `LinkRankIndex.ts:15-20` (stale two-part cache?) → `FolderProximity.ts:34-44` (current file outside limiting folder ⇒ everything is 999) |
| "Per-folder caching / stale folder scores" | `LinkRankIndex.ts:4-20` + `:83-89` (two-part cache + explicit invalidate) → `AutoCompleteSuggest.ts:243,248,256,274,285,497` (differential stale sources + explicit invalidate sites) → `LinkRank.ts:71-84` (per-pass `Map<Word,LinkRank>`, thrown away each call) |
| "Suggestions empty after plugin load" | `AutoCompleteSuggest.ts:189-293` (no eager refresh) → `:277-288` (`"resolved"` one-shot, self-offref) → `:943-957` (`enableInternalLinkComplement`) |
| "Typing `[[` shows nothing / inserts in wrong place" | `AbstractTokenizer.ts:9` (trim chars) → `AutoCompleteSuggest.ts:1156-1165` (multi-token query) → `:1250-1264` (offsets) → `:1465-1473` (`contextStartCh + word.offset`) |
| "Rapid typing / auto-save causes lag" | `AutoCompleteSuggest.ts:223-236` (300 ms debounce, current-file only) → `:258-274` (metadata-change rebuild) → `CurrentVaultWordProvider.ts:36-79` (if vault complement enabled) |

---

## 9. Open questions / things this map does not settle

- Whether the `"resolved"` event is reliably emitted for plugin load in Obsidian ≥ 1.11.4 — the code assumes a single emission and then unregisters (`AutoCompleteSuggest.ts:287`). Untested.
- The old `sleep(50)` wait before internal-link refreshes was removed; refreshes are now driven by a 1000 ms debounce on `metadataCache "changed"`.
- `previousLinksCacheInActiveFile` (`:112`) is actually populated from the **changed** file's unresolved links (`:268`), not the active file — name vs. behaviour mismatch, relevant when debugging missed internal-link refreshes.
- `LinkRankIndex.getRankData` keeps a separate global vault inversion and per-current-file `fileTier` cache. Switching the current file only rebuilds the small `fileTier` part; the global inversion is updated differentially for stale sources and only rebuilt when the `limitingFolder` changes, `invalidate()` is called, or a diff exceeds `MAX_DIFF_TARGETS`.
- Folder priority only affects ordering **within** internal-link pairs (`suggester.ts:316-317` returns 0 if either word is not `internalLink`), so it can never lift a link above a `currentFile`/`customDictionary` word of the same match quality except through the `fileTier` stage, which is also internal-link-only.

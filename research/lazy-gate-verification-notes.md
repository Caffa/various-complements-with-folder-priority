# Lazy-gate verification notes — code-level answers to 8 questions (2026-10-28)

Read-only verification against working tree at HEAD `bfc58e8`. Companion to
`research/typing-and-lazy-index-analysis-2026-10-28.md` (design doc) and
`research/overwork-audit-notes-research.md` (measurements). This file does **not** repeat their
content; it checks their load-bearing assumptions against the code and flags the ones that are
wrong.

Short version: **the word index does not consume `resolvedLinks` for the files it indexes.** Only
the *active* file's `resolvedLinks` is read, and only to stamp `fileTier`. So "one file gained one
resolved link ⇒ internal-link words changed" is false, and a rank-index-style
"contribution changed" predicate is a different question than "did this file's words change".

---

## Q1. `FolderRankCache.ensureSummary` (`src/storage/FolderRankCache.ts:152-194`)

### What it computes

Two vault-wide aggregates, then a per-folder qualification flag:

1. `direct: Map<folderPath, count>` — number of markdown files whose **parent folder** is that path
   (`:166-167`).
2. `nonLeaf: Set<folderPath>` — every strict ancestor of every file's parent, i.e. "this folder has
   subfolders that contain markdown" (`:169-174`).
3. For each folder in `direct`: `qualified = !nonLeaf.has(folder) && count >= 20 && count <= 2000`,
   written into `this.qualifications` (`:184-193`). Constants at `:27-28`.

### Inputs, exhaustively

| Input | Where |
|---|---|
| `app.vault.getMarkdownFiles()` — **only `file.path` is read** | `:165-166` |
| `MIN_FILES_PER_FOLDER` / `MAX_FILES_PER_FOLDER` constants | `:27-28`, `:187-188` |
| `this.rankIndex.currentVersion` — **memo key only** | `:153`, `:156`, `:178`, `:192` |
| `this.structureEpoch` — memo key only | `:154`, `:157` |

### Does the answer depend on link data?

**No.** The loop body never touches `metadataCache`, `resolvedLinks`, `unresolvedLinks`, or
`rankData`; the only per-file read is `file.path`:

```ts
165:    for (const file of this.app.vault.getMarkdownFiles()) {
166:      const parent = getParentFolder(file.path);
167:      direct.set(parent, (direct.get(parent) ?? 0) + 1);
```

The memo key, however, does include the rank version:

```ts
153:    const currentVersion = this.rankIndex.currentVersion;
156:      this.summary?.version === currentVersion &&
157:      this.summary?.structureEpoch === structureEpoch
```

**So: if one file gains one link, the computed answer cannot change — only the memo version
does**, which forces a redundant full rescan (`:165`) on the next `ensureSummary` call.

Two extra facts:

- The `version` field written into each `FolderQualification` (`:192`) is **dead** — the only read
  of `qualifications` is `this.qualifications.get(folder)?.qualified` (`:90-91`). Nothing reads
  `.version`. Dropping the version term from the summary key therefore has no other consequence.
- The existing test only covers the *no-bump* case
  (`src/storage/FolderRankCache.test.ts:617-636`, "does not rescan ensureSummary when links are
  unchanged"), which is exactly why the leak survived: no test exercises "real link change ⇒
  version bump ⇒ rescan".

---

## Q2. `FolderRankCache.getList` / list rebuild (`:68-117`, `:196-240`)

### Dependencies

| Dependency | Line |
|---|---|
| `limitingFolder === ""` ⇒ bail (`undefined`) | `:73-76` |
| `lastLimitingFolder` change ⇒ `this.lists.clear()` (all lists dropped) | `:78-81` |
| current file's parent folder must be inside `limitingFolder` | `:83-87` |
| folder qualification (from `ensureSummary`, which is called first) | `:89-94` |
| cache entry key = `folder` + `builtForLimitingFolder` + `rankIndex.currentVersion` | `:101-113` |
| list *contents* = caller-supplied `rankData` (`targetToSourceFolders`, `unresolvedNameToSourceFolders`) | `:196-212`, `:219-227` |
| eviction at `MAX_CACHED_LISTS = 512` | `:233-237` |

### What changes when one file's links change

- **If the contribution really changed**, `applyStaleSources` bumps the *global* version
  (`LinkRankIndex.ts:362-364`), so `cached.globalVersion !== currentGlobalVersion` for **every**
  cached folder list (`:104-107`): the visited folder's list is rebuilt via `buildList` (`:116`),
  and `ensureSummary` (`:89` → `:155-160`) rescans the vault first. No per-folder delta exists —
  the version is global, so one changed source invalidates all 512 potential lists.
- **If the contribution did not change** (prose save), no version bump, so the list is a hit
  (`:108-112`) and `ensureSummary` returns early — **zero** vault-sized work.

Confirmation that this path is *not* on the keystroke path: the keystroke option bag built at
`src/ui/AutoCompleteSuggest.ts:672-681` carries `{enabled, currentFilePath, limitingFolder}` only —
no `folderRankCache`, no `rankData` — so the `getList` call sites at `src/provider/suggester.ts:545`
and `:976` and `src/model/LinkRank.ts:92,135` are all inert per keystroke
(guards: `suggester.ts:538-544`). The only live caller is `InternalLinkWordProvider.annotateRankData`
(`:239-246`), which runs inside `requestIdleCallback` (`AutoCompleteSuggest.ts:1031-1057`).

---

## Q3. `LinkRankIndex` — what `markSourceStale` snapshots (`:105-120`, `:155-169`)

### Per-source state captured

```ts
24:  private staleSourceSnapshots = new Map<
25:    string,
26:    | { resolved: ReadonlyMap<string, number>;
27:        unresolved: ReadonlyMap<string, number>; }
28:    | undefined
29:  >();
```

- `snapshotSourceContributions(path)` stores the **old** contribution object by **reference** (no
  copy) — `{resolved: Map<targetPath, count>, unresolved: Map<lowercasedName, count>}`, or
  `undefined` if the source had no contribution (`:155-169`). Reference-sharing is safe because
  `removeSourceContributions` only deletes keys from the *aggregate* maps and the
  `sourceContributions` entry (`:406-457`) — it never mutates the stored per-source Maps.
- `staleSources: Set<path>` — intent queue (`:23`, `:116`).
- `filePartDirty` when the stale source is the current file (`:117-119`).
- **First-save-wins inside a window**: `if (… || this.staleSourceSnapshots.has(path)) return;`
  (`:156-158`) — repeated saves before the next `getRankData` keep the *original* snapshot, which
  is what makes the diff compare against last-indexed state rather than last-save state.
- The snapshot's data comes from the index's own `sourceContributions`, built in `rebuild()`
  (`:186-234`) / `applyStaleSources()` (`:302-338`) out of `metadataCache.resolvedLinks` and
  `metadataCache.unresolvedLinks`.

### Eager or lazy diff?

**Lazy.** `markSourceStale` itself is O(1) — one map lookup + one map set. The equality check runs
in `applyStaleSources` (`:352-364`) using `contributionsEqual` (`:367-404`: size compare, then
per-key count compare). The boolean literally exists there (`:355-356`), but only after
`getRankData(...)` is called (`:53-54`), and only when `limitingFolder !== ""`.

### Is it a sufficient single oracle for BOTH indexes? **No — four independent reasons.**

1. **Inert at shipped defaults.** `markSourceStale` returns before snapshotting when
   `builtForLimitingFolder === ""` (`:109-111`); `rebuild("")` leaves `sourceContributions` empty
   (`:186` guard); `getRankData` with `""` just clears the queue (`:55-58`). Default
   `limitingFolder` is `""`. So at defaults there is **no snapshot and no diff at all**.
2. **Scoped to the limiting folder.** Sources outside it are skipped when the contribution maps are
   built (`:189-191`, `:213-215`), so their snapshot is `undefined` ⇒ the predicate answers
   "changed" for every save of an out-of-folder note.
3. **Lossy for unresolved names.** Contributions store `name.toLowerCase()` (`:222-223`, `:325-326`)
   while phantom *words* use the raw link text (`InternalLinkWordProvider.ts:153-164`) ⇒ a
   case-only change of an unresolved link compares equal but changes a suggestion value.
4. **Answers the wrong question for the word index.** The word index consumes `resolvedLinks` only
   for the **active** file (`InternalLinkWordProvider.ts:176-189`, `fileTier`), and it *does*
   consume aliases / exclusion frontmatter / tags (`:71-81`, `:86`) which the snapshot does not
   contain.

### Could `markSourceStale` return a boolean with no new bookkeeping?

**Yes for the rank index's own question, no for the word index's.** The two Maps it already stores
are enough to decide "this source's edge set (resolved + unresolved) differs from what the index
holds" — implementable by comparing `resolvedLinks[path]` / `unresolvedLinks[path]` against the
snapshot (O(links of one file), µs; note the lowercasing asymmetry in reason 3, and the
`global === undefined` early return at `:106-108` needs a "assume changed" fallback). It would have
to be computed **eagerly** in `markSourceStale` (or at debounce-fire time) because the scheduling
decision happens before `getRankData`. What it must *not* be used for is gating the word index
alone — see Q4/Q5.

---

## Q4. `InternalLinkWordProvider.refreshWords` — every per-file input (`:28-222`)

### Per-file inputs (the `.flatMap` body, `:85-148`)

| # | Input | Source line |
|---|---|---|
| 1 | `x.path` → `createdPath` / `description` | `:92`, `:97`, `:112`, `:117`, `:129`, `:144` |
| 2 | `x.basename` (value, `:110`; `:127`) — derived from `x.path` | `:105`, `:110`, `:122`, `:127` |
| 3 | **frontmatter aliases** via `appHelper.getAliases(x)` | `:86` → `app-helper.ts:65-71` → `metadataCache.getFileCache(file)?.frontmatter` |
| 4 | frontmatter exclusion flag `getBoolFrontMatter(f, key)` | `:71-74` → `app-helper.ts:110-114` |
| 5 | frontmatter tags `getTagsProperty(f)` vs `tagsForExclusion` | `:76-81` → `app-helper.ts:99-108` |
| 6 | path-prefix / path-glob exclusion (path only) | `:62`, `:67` |

Derived from **settings**, not per file, but they change the words a file produces:
`wordAsInternalLinkAlias` (`:88-120` vs `:121-147`), `suppressBasenameWhenAliases` (`:102`),
`ignorePrefixes` → `isIgnoredBasename` (`:44-55`, applied `:105`, `:122`), `makeSynonymAboutEmoji`,
`makeSynonymAboutAccentsDiacritics` (`:93-96`, `:113-116`, `:131-142`).

**Crucially, what is NOT an input:** `metadataCache.resolvedLinks[x.path]`. The only `resolvedLinks`
read in the whole function is the **active** file's, for `fileTier` stamping:

```ts
179:        const resolvedLinkMap =
180:          this.app.metadataCache.resolvedLinks?.[option.currentFilePath] ?? {};
```

Phantom words come from `unresolvedLinks` through `appHelper.searchPhantomLinks()` (`:150-165`),
gated by `excludeUnresolvedLinks` (`:151-152`).

### Minimal per-file signature for "did this file's words change?"

```
sig(file) = path | basename | aliases[] | exclBool(frontMatterKeyForExclusion)
          | tags[]   | unresolvedNames[]   // raw case, for phantom words
```

plus two global terms that are not per-file:

- **file set** (create/delete/rename) → `structureEpoch`-style bump already exists.
- **settings signature** = the 6 settings above + `excludePathPrefixPatterns`,
  `excludePathGlobPatterns`, `frontMatterKeyForExclusion`, `tagsForExclusion`,
  `excludeUnresolvedLinks`. If this changes, a signature diff is insufficient — the per-file words
  change *without* any file changing, so settings edits must force a full rebuild. (Today they do:
  `main.ts:253-255` refreshes unconditionally.)
- **`fileTier`** depends on `activeFilePath` + its `resolvedLinks`/`unresolvedLinks`, i.e. global
  state relative to the file; it is re-stamped on every refresh (`:176-202`) and overwritten by
  `annotateRankData` (`:248-258`) when folder priority is on. A per-file word patch must therefore
  re-stamp `fileTier` for patched words, not treat it as part of the signature.

---

## Q5. `searchPhantomLinks` and the blast radius of one file's change (`src/app-helper.ts:247-251`)

```ts
247:  searchPhantomLinks(): { path: string; link: string }[] {
248:    return Object.entries(this.unsafeApp.metadataCache.unresolvedLinks).flatMap(
249:      ([path, obj]) => Object.keys(obj).map((link) => ({ path, link })),
250:    );
251:  }
```

- Reads the **entire** `metadataCache.unresolvedLinks` map (all sources), one pass, no filtering.
- The produced words **are per-source-file**: one `InternalLinkWord` per (source path, link name)
  with `createdPath = path` (`InternalLinkWordProvider.ts:153-164`) and
  `description: "Appeared in -> ${path}"`. Two notes linking the same unresolved name produce two
  distinct words, not one shared one. (No dedup at build time; dedup only at output via
  `suggestionUniqPredicate`, `suggester.ts:48-66`.)
- **Consequence: one file's change alters only that file's phantom words**, so phantoms are
  patchable per file (`wordsByPath` keyed by `createdPath`). The only global coupling is that the
  whole map is re-read each refresh, plus: creating the missing note makes the phantom disappear
  for every source that referenced it — but that arrives as a `create` event, which already
  forces a full refresh (`AutoCompleteSuggest.ts:261-268`).

---

## Q6. Per-file patching precedent — the frontmatter provider (`FrontMatterWordProvider.ts`)

### What actually exists

```ts
62:  private wordsByCreatedPath: { [path: string]: FrontMatterWord[] } = {};
...
87:  updateWordIndex(file: TFile): void {
88:    const fm = this.appHelper.getFrontMatter(file);
89:    if (!fm) { return; }
93:    this.wordsByCreatedPath[file.path] = pickWords(file, fm);
94:  }
96:  updateWords(): void {
97:    this.words = extractAndUniqWords(this.wordsByCreatedPath);
98:    this.wordsByFirstLetterByKey = indexingWords(this.words);
99:  }
```

- **The path→words map exists** (`:62`, `:93`) and is updated per file.
- **But there is no bucket removal.** `updateWords()` re-flattens *all* files
  (`extractAndUniqWords`, `:38-45`: `Object.values(...).flat()` + `uniqBy` on `key+value`) and
  re-indexes *all* buckets (`indexingWords`, `:47-59`: two `groupBy` passes). So the "per-file"
  part is only the source-of-truth map; the buckets are rebuilt wholesale.
- Call order confirms it: `changed` → `updateFrontMatterTokenIndex(f)` (`AutoCompleteSuggest.ts:285`
  → `:1112-1132` → `updateWordIndex`) then `updateFrontMatterToken()` (`:286-288` → `:1134-1154` →
  `updateWords`).
- Repo-wide, **no provider ever removes a single word from a bucket**: every bucket write is a
  wholesale assignment (`CurrentFileWordProvider.ts:103-110`, `:121-124`;
  `InternalLinkWordProvider.ts:204-209`, `:261-264`; `CustomDictionaryWordProvider.ts:243`).
- Likely why: `uniqBy(key + value)` (`:41-44`) means one bucket entry can be *shared* by several
  paths, so per-path removal is ambiguous for frontmatter.

### Would the same pattern work for internal-link words, incl. alias entries?

Yes — and it is *better* defined than for frontmatter, because an internal-link word's identity
includes its source: `Word.createdPath` (`model/Word.ts:14`), and `suggestionUniqPredicate` treats
different `createdPath` as different words (`suggester.ts:57-63`). Mechanics:

```ts
// add (today)
204:      for (const word of this.words) {
205:        pushWord(this.wordsByFirstLetter, word.value.charAt(0), word);
206:        word.aliases?.forEach((a) =>
207:          pushWord(this.wordsByFirstLetter, a.charAt(0), word),
208:        );
209:      }
```

- Buckets are `{ [firstLetter: string]: Word[] }` (`suggester.ts:17`) and `pushWord` appends with
  **no dedupe** (`:68-79`). Alias entries are the **same object** in a different bucket, so one
  word can occupy `1 + aliases.length` buckets, and an alias whose first char equals the value's
  first char yields two entries in the same bucket.
- Removal therefore must be by **object identity** (or `createdPath` + value/alias), in each of
  `value.charAt(0)` and every `alias.charAt(0)` bucket — not "remove all entries with this value".
- Cost of removal from an array bucket is O(bucket) (`filter`/`indexOf+splice`); worst-case bucket
  ≈13k and a file touches `1 + aliases` buckets ⇒ tens of µs, vs 4–5 ms for the full rebuild.
- `this.words` (`InternalLinkWordProvider.ts:19`) must be patched too — it feeds
  `annotateRankData` (`:248-258`) and `wordCount` (`:266-268`) — which argues for
  `wordsByPath: Map<path, InternalLinkWord[]>` as the single source of truth, with `words` derived
  from it (i.e. exactly the frontmatter shape, minus the uniq problem).
- Phantom words fit the same map (`createdPath` = the source note, `:157`), so a per-file patch
  handles "this note's `[[Foo]]` became `[[Bar]]`" too.

---

## Q7. `metadataCache "changed"` handler — what is actually available (`AutoCompleteSuggest.ts:282-290`)

Typed signature in the vendored typings:

```
node_modules/obsidian/obsidian.d.ts:4099:
on(name: 'changed', callback: (file: TFile, data: string, cache: CachedMetadata) => any, ctx?: any): EventRef;
```
Doc comment (`:4093-4098`): "Called when a file has been indexed, and its (updated) cache is now
available. **Note: This is not called when a file is renamed** for performance reasons."

Today's handler declares only the first parameter:

```ts
282:    ins.metadataCacheChangeRef = app.metadataCache.on("changed", async (f) => {
284:      ins.linkRankIndex.markSourceStale(f.path);
285:      ins.updateFrontMatterTokenIndex(f);
286:      if (!ins.appHelper.isActiveFile(f)) {
287:        ins.updateFrontMatterToken();
288:      }
289:      ins.debouncedRefreshInternalLinkTokens();
```

- **Yes, the `TFile` object is already there** — no re-read is needed for the path (it already uses
  `f.path`). `data` (full file text) and `cache` (`CachedMetadata`) are available and **currently
  ignored**.
- From `cache` alone you can diff: `cache.frontmatter` (⇒ aliases, the exclusion boolean, tags),
  `cache.links` (`LinkCache[]`: `link`, `original`, `position`), `cache.embeds`, `cache.tags`
  (`obsidian.d.ts:1118-1160`).
- From `cache` alone you **cannot** diff resolution: `resolvedLinks`/`unresolvedLinks` are
  metadataCache-level maps, not part of `CachedMetadata`, and resolution can lag indexing —
  `on(name: 'resolve', callback: file => …)` is documented as "Called when a file has been resolved
  for `resolvedLinks` and `unresolvedLinks`. **This happens sometimes after a file has been
  indexed.**" (`obsidian.d.ts:4108-4112`). The plugin **does not** listen to `resolve` (grep: no
  `on("resolve")` anywhere in `src/`).
- ⇒ A "did this file's links change?" diff computed *inside* the `changed` callback can read
  pre-resolution data and return a **false negative**. Compute it when the debounced refresh
  actually fires (2500 ms later, `:238-241`), or also hook `metadataCache "resolve"`.

---

## Q8. Save semantics, and what `refreshCurrentFileTokens` is for

### When does `vault "modify"` fire?

- API: "Called when a file is modified." (`obsidian.d.ts:6491-6495`) — no timing guarantee; timing
  is Obsidian's save behaviour, not the plugin's.
- Evidence *for* ~2 s in the repo/toolchain: `TextFileView.requestSave` is documented in the
  vendored typings as "**Debounced save in 2 seconds from now**" (`obsidian.d.ts:5956-5960`); the
  repo's own research asserts it twice — `research/performance-measurement-2026-10-28.md:49`
  (quoting "Obsidian saves every ~2 seconds while you type" / "about two seconds after the start of
  user input… then every two seconds until no more changes"; citing the Autosave Control plugin
  docs + forum) and `research/writing-pattern-analysis-2026-10-29.md:325`.
- **No comment or code in `src/` encodes that assumption.** The only save-path timing constants are
  the plugin's own debouncers: 300 ms for current-file (`AutoCompleteSuggest.ts:228-236`) and
  2500 ms for internal links (`:238-241`), both `resetTimer = false` ⇒ **rate limiters, not idle
  gates** (unchanged from the audit).
- Note the handler ignores the event's file argument:
  `app.vault.on("modify", (_) => ins.debouncedRefreshCurrentFileTokens())` (`:243-246`) — so a save
  of a **non-active** file schedules a re-tokenize of the **active** file
  (`CurrentFileWordProvider.ts:38-48` resolves the active editor/file itself). Normally a hash
  no-op (`:65-75`), but it is an unnecessary 300 ms-debounced task per background save.

### What `refreshCurrentFileTokens` does (`AutoCompleteSuggest.ts:855-886` → `CurrentFileWordProvider.refreshWords`, `:31-119`)

1. Status bar `Indexing` (`:857`); bail + clear if `enableCurrentFileComplement` is off (`:859-869`).
2. Tokenizes the **current line up to the cursor** to get the in-progress token (`:50-54`) — used
   only to *exclude* that token from suggestions (`:92`).
3. `await app.vault.cachedRead(activeFile)` (`:59`) — the **last saved bytes**, not the editor
   buffer. Then FNV-1a hash + `optionKey` and an early return if both match the cache (`:61-75`).
4. Otherwise: tokenize the **whole document**, filter (min chars, `shouldIgnoreOnCurrent`,
   `onlyEnglish`), lowercase leading-small-letter tokens, apply exclude regexes, `uniq`, drop the
   in-progress token (`:77-101`).
5. Build `words` and `wordsByFirstLetter` from scratch and swap them in (`:103-110`), store the
   cache (`:111-118`), then set the status bar (`:880-882`).

### Is that work needed before the next keystroke?

No. `getSuggestions` reads whatever buckets exist, so nothing on the keystroke path *waits* on it;
the async `refreshWords` only changes which words are available to *subsequent* keystrokes. Because
(3) reads the last saved content, the current-file index **inherently lags the buffer by up to one
save interval** — deferring the rebuild (idle, or after a pause) does not widen that gap beyond
what it already is; the only cost is that words typed since the last save stay unsuggestable for a
little longer. The one place it *is* on a latency-critical path is
`active-leaf-change` → `await ins.refreshCurrentFileTokens()` (`:270-280`), where the await blocks
the note-switch handler.

---

## Design assumptions in `typing-and-lazy-index-analysis-2026-10-28.md` that this changes

1. **"A new `[[link]]` ⇒ the word index must be rebuilt" is wrong** (§2 cascade `:100-103` and
   §4 Idea A `:160-167`). `resolvedLinks` of the edited file is **not** a word-index input (Q4);
   only `unresolvedLinks` (phantoms), aliases, basename, and exclusion metadata are. Adding a
   *resolved* link changes **zero** internal-link words — the target note's basename word already
   existed. The doc's gate therefore over-triggers on resolved-link churn and under-triggers on
   alias/frontmatter-tag edits (which are exactly what changes words).
2. **"The predicate already exists half-built; ~10–15 lines"** (§4 Idea A `:157-164`, §5 item 1) is
   true only for the rank index and **only when `limitingFolder !== ""`** — at the shipped default
   `""` there is no snapshot and no diff at all (Q3, `LinkRankIndex.ts:109-111`, `:186`). Gating the
   word index properly needs either a second, word-shaped signature (Q4) or a per-file
   `unresolvedNames` snapshot; that is a ~40–60 line change plus a settings-signature escape hatch,
   not 10–15 lines. Recommendation 1 in §5 should be resized and split:
   1a) gate on *unresolved* links + alias/basename/exclusion-metadata diffs (word index);
   1b) keep the rank-index contribution gate for the rank index only.
3. **Do not compute that diff in the `changed` handler** (Q7): `changed` can precede
   `resolvedLinks`/`unresolvedLinks` resolution, and the plugin doesn't listen to
   `metadataCache "resolve"`. Compute at debounce-fire time instead.
4. **Recommendation 3 (drop the version term from `ensureSummary`'s key) is confirmed safe** (Q1):
   links are not an input, and `qualifications[].version` is already dead code (`:192`, read only at
   `:90-91`).
5. **Recommendation 6 (per-file incremental index) is more attractive than stated** (Q5/Q6): phantom
   words are already per-source-file, internal-link word identity already includes `createdPath`
   (`suggester.ts:57-63`), and the only real mechanic to invent is identity-based bucket removal in
   `1 + aliases` buckets — no dedup problem of the kind that forces the frontmatter provider to
   re-flatten everything (`FrontMatterWordProvider.ts:41-44`).

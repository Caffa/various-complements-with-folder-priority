# Various Complements w/ Folder Priority Plugin - Agent Documentation

## Project Overview

This is a fork of [obsidian-various-complements-plugin](https://github.com/tadashi-aikawa/obsidian-various-complements-plugin) by tadashi-aikawa. The fork adds **folder-based prioritization** for internal link suggestions.

## Original Plugin Purpose

The plugin provides IDE-like auto-completion for Obsidian with multiple word sources (providers):
- **Current file** - words from the active file
- **Current vault** - words from all files in the vault
- **Custom dictionary** - user-defined word lists
- **Internal links** - links to other notes in the vault
- **Front matter** - YAML front matter keys

## Key Modification: Folder Priority for Internal Links

### Problem
When writing a story in `Novel/Ancient China/As Huanxin/AC Vs Twins/`, character links from other stories (e.g., from `Novel/Ancient China/Born Royal/`) appear with equal priority as characters in the current story, making it harder to find relevant characters quickly.

### Solution
Implement folder-based prioritization that ranks internal link suggestions based on folder proximity to the current file, using a configurable "limiting folder" to define the scope.

### Priority Hierarchy Example

**Limiting folder**: `Novel`

**Current file**: `/Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter - T1.md`

**Priority order** (highest to lowest):
1. **Level 0 - Current file**: Links appearing in `Chapter - T1.md` itself
2. **Level 1 - Story folder**: Links appearing in `AC Vs Twins/*.md` files
3. **Level 2 - Genre/subgenre folder**: Links appearing in `As Huanxin/*.md` and its subfolders
4. **Level 3 - World folder**: Links appearing in `Ancient China/*.md` and its subfolders
5. **Level 4 - Other vault links**: Links appearing outside the limiting folder scope

### Algorithm

```
For each internal link suggestion:
1. Get current file path
2. Find common ancestor with limiting folder
3. Calculate "folder distance" from current file to each link's source files
4. Links appearing in:
   - Same file: distance 0 (highest priority)
   - Same story folder: distance 1
   - Same parent folder: distance 2, etc.
5. Score = frequency_in_folder_hierarchy * (1 / (distance + 1))
6. Higher score = higher in suggestion list
```

---

## Codebase Architecture

### Entry Point
- `src/main.ts` - Obsidian plugin entry, initializes providers and settings

### Core Components

```
src/
├── main.ts                    # Plugin entry point
├── app-helper.ts              # Obsidian API wrapper
├── ui/
│   └── AutoCompleteSuggest.ts # Main autocomplete logic
├── provider/
│   ├── suggester.ts           # Suggestion ranking algorithm
│   ├── InternalLinkWordProvider.ts  # Internal link source
│   ├── CurrentFileWordProvider.ts    # Current file words
│   ├── CurrentVaultWordProvider.ts   # Vault-wide words
│   ├── CustomDictionaryWordProvider.ts
│   └── FrontMatterWordProvider.ts
├── model/
│   ├── Word.ts                # Word types and priorities
│   ├── FolderProximity.ts     # Folder-distance math
│   └── LinkRank.ts            # Per-suggestion rank computation
├── storage/
│   ├── SelectionHistoryStorage.ts  # User selection history
│   └── LinkRankIndex.ts            # Inverted link index + memo
├── setting/
│   └── settings.ts            # Plugin settings
└── tokenizer/
    └── tokenizers/            # Text tokenization
```

### Key Files for Modification

#### 1. `src/model/Word.ts`
Defines word types and their static priorities:
```typescript
export class WordTypeMeta {
  static readonly INTERNAL_LINK = new WordTypeMeta("internalLink", 90, "internalLink");
  // priority: 0-100, higher = more important
}
```

**Current state**: `Word` no longer carries folder frequency data. Ranking data is computed per suggestion pass from `LinkRankIndex`.

#### 2. `src/provider/InternalLinkWordProvider.ts`
Collects internal links from vault:
```typescript
export class InternalLinkWordProvider {
  words: Word[] = [];
  wordsByFirstLetter: WordsByFirstLetter = {};
  
  refreshWords(option: {...}): void {
    // Gets all markdown files, filters exclusions, creates Word objects
    // Each Word has: value, type, createdPath, aliases, description, phantom?, aliasMeta?
  }
}
```

**Current state**: The provider builds words but does not attach folder scores. Alias handling is split between merged `aliases` (default) and standalone alias words with `aliasMeta` (when `suggestInternalLinkWithAlias` is true).

#### 3. `src/provider/suggester.ts`
Core suggestion ranking logic:
```typescript
export function suggestWords(indexedWords, query, maxNum, option): Word[] {
  // 1. Collect candidate words from providers
  // 2. Filter by query match
  // 3. Sort by priority:
  //    - Fuzzy match score
  //    - Front-matter pin
  //    - Folder/link tier (fork)
  //    - Selection history
  //    - Word length
  //    - Word type priority
  //    - Alias status
  // 4. Return top N
}
```

**Current state**: `compareLinkTier` applies `fileTier` + `folderProximity.score` when `folderPriority.enabled` and a `limitingFolder` is set; with an empty `limitingFolder` only `fileTier` applies.

#### 4. `src/storage/SelectionHistoryStorage.ts`
Tracks user selections for intelligent prioritization:
```typescript
export class SelectionHistoryStorage {
  data: SelectionHistoryTree;  // {hit: {value: {type: {count, lastUpdated}}}}

  compare(w1, w2, latestUpdated): -1 | 0 | 1 {
    // Higher recent selections = higher priority
  }
}
```

**Current state**: Independent of folder priority; consumed after the link tier comparator.

#### 5. `src/model/FolderProximity.ts`
Pure math for folder distance:
```typescript
export function calculateFolderProximity(
  linkSourceFolders: Map<folder, count>,
  currentFilePath: string,
  limitingFolder: string
): FolderProximityScore;
```

#### 6. `src/model/LinkRank.ts`
Per-word rank computation using data from `LinkRankIndex`.

#### 7. `src/storage/LinkRankIndex.ts`
Inverted index built from `metadataCache.resolvedLinks` / `unresolvedLinks`:
```typescript
export class LinkRankIndex {
  getRankData(currentFilePath: string, limitingFolder: string): LinkRankData;
  invalidate(): void;
}
```

#### 8. `src/ui/AutoCompleteSuggest.ts`
Main suggestion UI controller:
```typescript
export class AutoCompleteSuggest extends EditorSuggest<Word> {
  // Providers
  internalLinkWordProvider: InternalLinkWordProvider;
  
  // Indexes words by first letter for fast lookup
  get indexedWords(): IndexedWords { ... }
  
  // Gets suggestions for current context
  getSuggestions(context): Word[] | Promise<Word[]> { ... }
}
```

**Current state**: Builds the `folderPriority` option per suggestion call and wires refresh events. `LinkRankIndex` now uses a two-part cache (global vault inversion + per-current-file file tier) and applies renames/deletes/`metadataCache "changed"` differentially via `onRename` / `onDelete` / `markSourceStale` at `getRankData` time; `active-leaf-change` no longer invalidates it. The internal-link word index auto-refreshes about 1 second after any note change (`metadataCache "changed"`, rename, delete, create) and still refreshes on `active-leaf-change` and settings changes.

### Data Flow

```
1. Plugin loads
   ├── Providers initialized
   └── Settings loaded

2. User opens file
   ├── onTrigger() called on cursor movement
   ├── Tokenizes current line
   └── Returns trigger info if should show suggestions

3. getSuggestions() called
   ├── Debounced lookup
   ├── Query each provider's wordsByFirstLetter
   ├── Apply match strategy (prefix/partial)
   ├── Build per-pass LinkRank memo from LinkRankIndex
   ├── Sort by: fuzzy match → frontMatter pin → link tier → history → length → type → alias
   └── Return top N suggestions

4. User selects suggestion
   ├── Insert text at cursor
   └── Increment selection history

5. File / vault changed
   ├── `LinkRankIndex` applies renames/deletes/`metadataCache "changed"` differentially (`onRename` / `onDelete` / `markSourceStale`) at the next `getRankData` call, with a 5000-target fallback to full rebuild
   └── Internal-link words rebuilt on `metadataCache "changed"` (unconditional 1000 ms debounce), rename, delete, create, `active-leaf-change`, "resolved", settings change, or manual reload command
```

---

## Current State

The folder-priority implementation has been refactored from the original `LinkFrequencyStorage` + `Word.folderProximity` design to a lighter, per-suggestion rank pass backed by `LinkRankIndex`.

| Stage | Status | What changed |
|-------|--------|--------------|
| **Baseline** | committed `f6f86ae` | `LinkRank.ts`, `FolderProximity.ts`, `LinkRankIndex.ts` replace `LinkFrequencyStorage.ts`; `suggester.ts` uses `compareLinkTier`. |
| **D** | landing now (parallel builder) | Internal-link index auto-refreshes about 1 second after `metadataCache "changed"`, plus on vault `create`/`rename`/`delete`. New commands: **Internal link index status** and **Reload internal link index**. |
| **E** | this pass | Settings `prioritizeAliases` (default `true`) and `suggestAliasesOnly` (default `false`, requires `suggestInternalLinkWithAlias`) added to `src/setting/settings.ts`. |
| **F stage 1** | landing now (parallel builder) | `LinkRankIndex` incremental updates, including unresolved (phantom) links; differential `markSourceStale` / `onRename` / `onDelete` with a 5000-target full-rebuild fallback. |
| **C** | this pass | `folderPriority.enabled` default flipped to `true`. Existing vaults need a `data.json` patch; the deploy patch for the **Novel-Writing** vault sets `enabled: true` and `limitingFolder: "Novel"`. |

### Per-folder precompute (stage 2) — NOT implemented

| Dimension | Estimate |
|-----------|----------|
| **What** | Precomputed ranked lists per *bottom-level* folder: leaf folders only, ≥20 files, ≤2000 files, ≤512 lists LRU, top-1000 entries each. |
| **Estimated build cost** | Lazy: ~0.3–1 ms per folder on first visit. Eager all: ~50–300 ms one-time for a 12k-note vault. |
| **Estimated runtime gain** | Sub-microsecond per candidate — the live pairwise scoring is already µs-cheap. |
| **Memory** | ~20–30 MB worst case. |
| **Recommendation** | Deferred. Stage-1 incremental updates already remove the O(E)-per-change rebuild cost, so the live path is fast enough. Awaiting explicit user greenlight before adding the extra memory/complexity. |

---

## Performance Considerations

### Challenge
Scanning all files to count link frequencies is expensive for large vaults.

### Current Strategy
- **Inverted index from metadata cache**: `LinkRankIndex` reads `metadataCache.resolvedLinks` / `unresolvedLinks` instead of parsing files.
- **Lazy + memoized**: `getRankData(currentFilePath, limitingFolder)` keeps a two-part cache — a global vault inversion keyed on `limitingFolder` plus a per-current-file `fileTier` part. Stale sources are applied differentially at lookup time; only `limitingFolder` changes, `invalidate()`, or large diffs trigger a full global rebuild. `active-leaf-change` no longer invalidates the cache.
- **Incremental updates**: `markSourceStale` / differential rebuild on rename/delete; 5000-target fallback to full rebuild.
- **Limit scope**: only source folders inside `limitingFolder` are counted; an empty `limitingFolder` falls back to `fileTier`-only ranking.

### Benchmark Targets
- Initial rank data build: < 100ms for 10k files
- Per-change incremental update: < 10ms
- Suggestion latency: < 100ms (existing)

---

## Testing Strategy

### Unit Tests
1. `FolderProximity.calculateFolderProximity()` - various path scenarios
2. `LinkRankIndex` - incremental updates and invalidation
3. Suggestion sorting with folder proximity

### Integration Tests
1. Open file in story folder → verify link priorities
2. Modify file → verify cache updates
3. Large vault → verify performance

### Manual Testing
1. Set limiting folder to "Novel"
2. Open `Novel/Ancient China/As Huanxin/AC Vs Twins/chapter.md`
3. Type `[[@` to trigger internal link suggestions
4. Verify characters from current story appear first
5. Verify characters from other stories appear lower

---

## Existing Prioritization System

The plugin already has intelligent prioritization via `SelectionHistoryStorage`:

```typescript
// Selection history scores based on recency
const SEC = 1000, MIN = SEC * 60, HOUR = MIN * 60, DAY = HOUR * 24, WEEK = DAY * 7;

function calcScore(history, latestUpdated) {
  if (!history) return 0;
  if (history.lastUpdated === latestUpdated) return Number.MAX_SAFE_INTEGER;
  
  const behind = Date.now() - history.lastUpdated;
  if (behind < MIN) return 8 * history.count;
  else if (behind < HOUR) return 4 * history.count;
  else if (behind < DAY) return 2 * history.count;
  else if (behind < WEEK) return 0.5 * history.count;
  else return 0.25 * history.count;
}
```

**Folder priority integrates with this**, not replaces it. The final ordering is produced by a chain of comparators; link tier (file tier + folder proximity) runs before selection history.

---

## Related Files to Study

1. **`src/provider/CurrentVaultWordProvider.ts`** - Similar indexing pattern
2. **`src/app-helper.ts`** - Obsidian API helpers (getResolvedLinks, etc.)
3. **`src/util/glob.ts`** - Glob pattern matching (for exclusion patterns)

---

## Development Commands

```bash
pnpm dev        # Start dev build with watch
pnpm build      # Production build
pnpm test       # Run Jest tests
pnpm test:watch # Run tests in watch mode
pnpm typecheck  # TypeScript check
pnpm verify     # Full CI check
```

---

## Notes

- The plugin uses `EditorSuggest<Word>` from Obsidian API
- Words are indexed by first letter for fast lookup (`WordsByFirstLetter`)
- Match strategies: `prefix` (default), `partial` (fallback linkify)
- Settings are persisted via `Plugin.loadData/saveData`
- The plugin handles IME input, math blocks, code blocks specially

---

## Questions to Resolve During Implementation

1. **What if limiting folder is not set?** → Fall back to current behavior (no folder priority)

2. **What if file is outside limiting folder?** → Use standard priority (same as "other vault links")

3. **How to handle renamed/moved files?** → Listen to `vault.on('rename')` and update cache

4. **Should frequency count aliases?** → Yes, if link appears with alias, count the resolved link

5. **How to handle unresolved (phantom) links?** → Track where they appear, include in scoring
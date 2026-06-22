# Various Complements Plugin - Agent Documentation

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
│   └── Word.ts                # Word types and priorities
├── storage/
│   └── SelectionHistoryStorage.ts  # User selection history
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

**Modification needed**: Add folder distance score to Word interface.

#### 2. `src/provider/InternalLinkWordProvider.ts`
Collects internal links from vault:
```typescript
export class InternalLinkWordProvider {
  words: Word[] = [];
  wordsByFirstLetter: WordsByFirstLetter = {};
  
  refreshWords(option: {...}): void {
    // Gets all markdown files, filters exclusions, creates Word objects
    // Each Word has: value, type, createdPath, aliases, description
  }
}
```

**Modification needed**: 
- Track which files contain each link (frequency per folder)
- Calculate folder proximity scores

#### 3. `src/provider/suggester.ts`
Core suggestion ranking logic:
```typescript
export function suggestWords(indexedWords, query, maxNum, option): Word[] {
  // 1. Collect candidate words from providers
  // 2. Filter by query match
  // 3. Sort by priority:
  //    - Fuzzy match score
  //    - Word type priority (frontMatter > internalLink > ...)
  //    - Selection history
  //    - Word length
  //    - Alias status
  // 4. Return top N
}
```

**Modification needed**: Add folder proximity to sorting criteria.

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

**Can be used as reference** for implementing folder link frequency storage.

#### 5. `src/ui/AutoCompleteSuggest.ts`
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
   ├── Sort by: fuzzy match → type → history → length
   └── Return top N suggestions

4. User selects suggestion
   ├── Insert text at cursor
   └── Increment selection history

5. File saved / vault changed
   ├── refreshInternalLinkTokens()
   └── Re-index all providers
```

---

## Implementation Plan

### Phase 1: Data Structure for Folder Proximity

**File**: `src/model/FolderProximity.ts` (new)

```typescript
export interface FolderProximityScore {
  level: number;           // 0 = same file, 1 = story folder, etc.
  frequency: number;        // How many times link appears at this level
  score: number;           // Combined score
}

export function calculateFolderProximity(
  linkPath: string,
  currentFilePath: string,
  limitingFolder: string
): FolderProximityScore;
```

### Phase 2: Link Frequency Tracker

**File**: `src/storage/LinkFrequencyStorage.ts` (new)

```typescript
export class LinkFrequencyStorage {
  // Map: linkPath -> { folderPath -> count }
  private linkFolderFrequency: Map<string, Map<string, number>>;
  
  // Build index incrementally
  async buildIndex(vault: Vault, limitingFolder: string): Promise<void>;
  
  // Update when file modified
  updateFromFile(file: TFile, links: string[]): void;
  
  // Get frequency for link in folder hierarchy
  getFrequencyInFolder(linkPath: string, folderPath: string): number;
  
  // Get all folders where link appears
  getFoldersForLink(linkPath: string): string[];
}
```

### Phase 3: Modify InternalLinkWordProvider

**File**: `src/provider/InternalLinkWordProvider.ts`

Add to refresh:
```typescript
// Calculate folder proximity for each link
for (const word of this.words) {
  const proximity = calculateFolderProximity(
    word.createdPath,
    currentFilePath,  // Need to pass this
    settings.limitingFolder
  );
  word.folderProximity = proximity;
}
```

### Phase 4: Modify Suggestion Ranking

**File**: `src/provider/suggester.ts`

Update sort logic:
```typescript
candidate.sort((a, b) => {
  // 1. Fuzzy match
  if (a.fuzzy !== b.fuzzy) return a.fuzzy ? 1 : -1;
  
  // 2. Folder proximity (NEW)
  if (a.folderProximity && b.folderProximity) {
    const proximityDiff = b.folderProximity.score - a.folderProximity.score;
    if (proximityDiff !== 0) return proximityDiff;
  }
  
  // 3. Word type priority
  // 4. Selection history
  // 5. Word length
  // ...
});
```

### Phase 5: Settings

**File**: `src/setting/settings.ts`

Add:
```typescript
interface Settings {
  // ... existing settings
  folderPriority: {
    enabled: boolean;
    limitingFolder: string;  // e.g., "Novel"
    maxLevels: number;       // How many folder levels to consider
  };
}
```

---

## Performance Considerations

### Challenge
Scanning all files to count link frequencies is expensive for large vaults.

### Strategy 1: Lazy Indexing
- Don't index everything on startup
- Index current folder hierarchy on-demand when file opens
- Cache results per folder

### Strategy 2: Incremental Updates
- Listen to `vault.on('modify')` events
- Only re-index modified file
- Update link frequencies for that file's links only

### Strategy 3: Background Indexing
- Use `requestIdleCallback` or debounced background task
- Index folders progressively while user is idle
- Store index in plugin data folder

### Strategy 4: Smart Caching
```typescript
interface FolderLinkCache {
  lastIndexed: number;
  folderPath: string;
  links: Map<string, number>;  // linkPath -> count
  files: Set<string>;           // files in this folder
}
```

### Strategy 5: Limit Scope
- Only index files under limiting folder
- Skip folders matching exclusion patterns
- Use Obsidian's metadata cache for link extraction (fast)

### Benchmark Targets
- Initial index: < 500ms for 1000 files
- Per-file update: < 50ms
- Suggestion latency: < 100ms (existing)

---

## Testing Strategy

### Unit Tests
1. `FolderProximity.calculateFolderProximity()` - various path scenarios
2. `LinkFrequencyStorage` - incremental updates
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

**Folder priority should integrate with this**, not replace it. The combined score could be:
```
final_score = folder_proximity_score * 10 + selection_history_score
```

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
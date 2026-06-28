# Performance Anti-Patterns Analysis - Various Complements Obsidian Plugin

## Executive Summary

This analysis identifies **7 categories** of performance anti-patterns across **12 source files**. While the codebase generally follows good practices (uses debouncing, has cleanup methods), there are several areas that could cause performance degradation in large vaults or during heavy usage.

---

## 1. Unbounded Caches/Indexes (HIGH PRIORITY)

### Issue: SelectionHistoryStorage.data grows indefinitely
**File:** `src/storage/SelectionHistoryStorage.ts`
- **Line 53:** `data: SelectionHistoryTree` - Nested object structure with no size limits
- **Line 77-130:** `purge()` method exists but is only called manually in `refreshIntelligentSuggestionPrioritization()`
- **Line 136-167:** `increment()` adds new entries without checking memory limits first
- **Risk:** In vaults with heavy usage, this can accumulate thousands of entries consuming significant memory

```typescript
// Line 53 - unbounded storage
export class SelectionHistoryStorage {
  data: SelectionHistoryTree; // No automatic cleanup
  // ...
}
```

### Issue: Word indexes grow with vault size
**Files:** Multiple provider files
- `src/provider/CurrentFileWordProvider.ts:14` - `wordsByFirstLetter: WordsByFirstLetter = {}`
- `src/provider/CurrentVaultWordProvider.ts:11` - `wordsByFirstLetter: WordsByFirstLetter = {}`
- `src/provider/InternalLinkWordProvider.ts:12` - `wordsByFirstLetter: WordsByFirstLetter = {}`
- `src/provider/CustomDictionaryWordProvider.ts:127` - `wordsByFirstLetter: WordsByFirstLetter = {}`
- `src/provider/FrontMatterWordProvider.ts:64` - `wordsByFirstLetterByKey: { [key: string]: WordsByFirstLetter }`

**Risk:** Each of these indexes scales linearly with vault content. A vault with 10,000+ files could create substantial memory pressure.

### Issue: CustomDictionaryWordProvider.wordByValue unbounded
**File:** `src/provider/CustomDictionaryWordProvider.ts:126`
- `wordByValue: { [value: string]: CustomDictionaryWord } = {}`
- **Risk:** Dictionary files can contain thousands of entries with no size constraints

---

## 2. Expensive Operations on Every Keystroke (HIGH PRIORITY)

### Issue: onTrigger performs heavy processing synchronously
**File:** `src/ui/AutoCompleteSuggest.ts:985-1186`

**Critical lines:**
- **1075:** `const tokens = this.tokenizer.tokenize(currentLineUntilCursor, true);`
- **1078:** `const tokenized = this.tokenizer.recursiveTokenize(currentLineUntilCursor);`
- **1045-1053:** Regex pattern matching against suppression patterns
- **1026-1034:** String comparison with previous line
- **1045-1053:** Multiple regex tests against `patternsToSuppressTrigger`

```typescript
// Lines 1045-1053 - regex matching on every keystroke
const suppressedPattern = this.settings.patternsToSuppressTrigger.find(
  (p) => new RegExp(p).test(currentLineUntilCursor),
);
```

**Risk:** Tokenization and regex matching on every keystroke can cause input lag, especially with large `maxNumberOfWordsAsPhrase` settings.

### Issue: File content reading in CurrentFileWordProvider.refreshWords
**File:** `src/provider/CurrentFileWordProvider.ts:51`
- **Line 51:** `const content = await this.app.vault.cachedRead(file);`
- **Lines 52-64:** Full tokenization of entire file content on every refresh

**Risk:** Reading and tokenizing entire file content on every modification event.

---

## 3. File Watching Without Debouncing (MEDIUM-HIGH PRIORITY)

### Issue: refreshCurrentFileTokens called on every vault modify event
**File:** `src/ui/AutoCompleteSuggest.ts:212-218`

```typescript
// Lines 212-218 - No debouncing on file modify
ins.modifyEventRef = app.vault.on("modify", async (_) => {
  await ins.refreshCurrentFileTokens(); // Re-indexes entire file content
  if (ins.selectionHistoryStorage?.shouldPersist) {
    ins.selectionHistoryStorage.syncPersistVersion();
    onPersistSelectionHistory();
  }
});
```

**Risk:** Rapid file modifications (e.g., typing, auto-save) trigger multiple expensive re-indexing operations. With auto-save enabled, this could fire multiple times per second.

### Issue: refreshInternalLinkTokens on metadata cache changes
**File:** `src/ui/AutoCompleteSuggest.ts:229-242`

```typescript
// Lines 229-242 - Called on every metadata cache change
ins.metadataCacheChangeRef = app.metadataCache.on("changed", async (f) => {
  ins.updateFrontMatterTokenIndex(f);
  if (!ins.appHelper.isActiveFile(f)) {
    ins.updateFrontMatterToken();
  }
  if (settings.updateInternalLinksOnSave) {
    // ... triggers refreshInternalLinkTokens()
  }
});
```

**Risk:** Metadata cache changes fire frequently during Obsidian's background processing.

---

## 4. Synchronous Blocking Operations (MEDIUM PRIORITY)

### Issue: Large-scale array operations in suggestWords
**File:** `src/provider/suggester.ts:154-363`

**Critical sections:**
- **Lines 208-266:** Multiple array spreads creating temporary arrays
- **Lines 268-270:** Mapping and filtering all candidate words synchronously
- **Lines 281-357:** Complex sorting with multiple comparison operations

```typescript
// Lines 208-266 - Creates many intermediate arrays
const words = queryStartWithUpper
  ? frontMatter
    ? flattenFrontMatterWords()
    : [
        ...(shouldIncludeProvider("currentFile")
          ? (indexedWords.currentFile[query.charAt(0)] ?? [])
          : []),
        // ... more spreads
      ]
```

**Risk:** With large vaults, suggestion generation can block the main thread for 50-200ms.

### Issue: Vault-wide file iteration in CurrentVaultWordProvider
**File:** `src/provider/CurrentVaultWordProvider.ts:34-81`

```typescript
// Lines 34-42 - Iterates all markdown files
const markdownFilePaths = this.app.vault
  .getMarkdownFiles()
  .map((x) => x.path)
  .filter((p) => this.includePrefixPatterns.every((x) => p.startsWith(x)))
  // ...

// Lines 48-72 - Reads and tokenizes each file
for (const path of markdownFilePaths) {
  const content = await this.app.vault.adapter.read(path);
  const tokens = this.tokenizer
    .tokenize(content)
    // ...
}
```

**Risk:** O(n) operation over all files with full content reading. In vaults with 1000+ files, this could take seconds.

---

## 5. Memory Leak Risks (LOW-MEDIUM PRIORITY)

### Issue: Event listeners in popup-commands.ts may not always cleanup
**File:** `src/ui/popup-commands.ts:117-120`

```typescript
// Lines 117-120 - Cleanup happens in callback, but if callback never fires...
const refreshedRef = popup.app.metadataCache.on("changed", (f) => {
  popup.refreshInternalLinkTokens();
  popup.app.metadataCache.offref(refreshedRef);
});
```

**Risk:** If the "changed" event never fires (rare edge case), the listener remains registered.

### Issue: keymapEventHandler array grows without bound
**File:** `src/ui/AutoCompleteSuggest.ts:115, 629-740`
- **Line 115:** `keymapEventHandler: KeymapEventHandler[] = []`
- **Line 659-660:** Cleared on each `registerHotkeys()` call, but if called frequently without proper cleanup, could leak

**Assessment:** LOW RISK - properly cleared in registerHotkeys, but worth monitoring.

---

## 6. UI Rendering (LOW PRIORITY)

### Issue: renderSuggestion creates DOM elements on every suggestion display
**File:** `src/ui/AutoCompleteSuggest.ts:1196-1247`

```typescript
// Lines 1197-1224 - Creates new DOM elements for each suggestion
renderSuggestion(word: Word, el: HTMLElement): void {
  const base = createDiv(); // Creates new div
  // ...
  base.createDiv({ text, cls: ... }); // Creates child divs
  // ...
  el.appendChild(base); // Appends to suggestion element
}
```

**Risk:** Creates DOM elements for every suggestion. With `maxNumberOfSuggestions` set to high values (e.g., 50+), this could impact rendering performance.

---

## 7. Lack of RequestIdleCallback (LOW PRIORITY)

### Issue: Heavy indexing operations don't use requestIdleCallback
**Files:** 
- `src/ui/AutoCompleteSuggest.ts` - Multiple refresh methods
- `src/provider/CurrentVaultWordProvider.ts:24-81`
- `src/storage/LinkFrequencyStorage.ts:69-94`

**Recommendation:** Background indexing operations like `indexFolder` and `refreshCurrentVaultTokens` should use `requestIdleCallback` when available to avoid blocking user interactions.

---

## Summary Table

| Anti-Pattern | Severity | Files Affected | Lines |
|-------------|----------|----------------|-------|
| Unbounded caches | HIGH | 5 files | 14+ lines |
| Expensive keystroke ops | HIGH | 3 files | 20+ lines |
| File watching w/o debounce | MEDIUM-HIGH | 1 file | 3 sections |
| Synchronous blocking | MEDIUM | 3 files | 30+ lines |
| Memory leak risks | LOW-MEDIUM | 2 files | 5 lines |
| UI rendering | LOW | 1 file | 50 lines |
| No requestIdleCallback | LOW | 4 files | N/A |

---

## Recommendations

### Immediate (High Impact, Low Effort)

1. **Add debouncing to file modify handlers:**
   ```typescript
   // In AutoCompleteSuggest.ts
   const debouncedRefreshCurrentFile = debounce(
     () => this.refreshCurrentFileTokens(),
     500
   );
   ```

2. **Cache compiled regex patterns:**
   ```typescript
   // Pre-compile patterns in settings update
   private compiledSuppressionPatterns: RegExp[] = [];
   ```

### Short-term (Medium Effort)

3. **Add memory limits to SelectionHistoryStorage:**
   - Implement automatic purge when size exceeds threshold
   - Consider LRU cache for history entries

4. **Implement incremental indexing:**
   - Track file modification times
   - Only re-index changed portions of files

### Long-term (High Effort)

5. **Use Web Workers for tokenization:**
   - Move heavy tokenization off main thread

6. **Implement virtual scrolling for suggestions:**
   - Only render visible suggestions in the DOM

7. **Add requestIdleCallback for background operations:**
   ```typescript
   const scheduleIndexing = (callback: () => void) => {
     if (typeof requestIdleCallback !== 'undefined') {
       requestIdleCallback(callback, { timeout: 2000 });
     } else {
       setTimeout(callback, 100);
     }
   };
   ```

---

## Performance Monitoring Points

Add performance markers at these critical sections:

1. **Line 989 in AutoCompleteSuggest.ts** - `onTrigger` start
2. **Line 486 in AutoCompleteSuggest.ts** - `getSuggestions` start
3. **Line 742 in AutoCompleteSuggest.ts** - `refreshCurrentFileTokens` start
4. **Line 775 in AutoCompleteSuggest.ts** - `refreshCurrentVaultTokens` start

Current performance logging exists but could be enhanced with:
- Warning thresholds (e.g., log if operation takes >100ms)
- Aggregated metrics over time
- Memory usage tracking

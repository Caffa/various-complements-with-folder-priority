# How typing works — and where the plugin computes more than it needs to (2026-10-28)

Synthesized write-up based on two read-only research passes at HEAD `bfc58e8`:

- `research/typing-path-notes-research.md` — keystroke control-flow map, file:line-anchored
- `research/overwork-audit-notes-research.md` — over-computation audit + measurements

Every claim is anchored to those two files; ms numbers come from `bench/results/latest.md`
(Node-side, N=7 quick mode, 14k-file synthetic fixture — **not** in-app profiles).

---

## 0. TL;DR

- **Typing itself is already lean.** Per keystroke the plugin runs ~19 line-scoped gates and two
  tokenizer passes over the current line, then scans one first-letter bucket (≈13k entries worst
  case). **≈1.4–2.9 ms per keystroke**, and **zero vault access** on this path. Folder ranking was
  already moved off the keystroke path.
- **The waste is on the save/metadata event path, not on keystrokes.** Every
  `metadataCache "changed"` event triggers a **full reindex of all ≈14k link words (≈4–7 ms)**
  even when the file's links did not change at all — a prose save costs the same as a
  link-adding save. This is exactly the gap suspected; the change-detection predicate to gate it
  **already exists half-built** inside `LinkRankIndex`.
- **The 2500 ms debounce is a rate limiter, not an idle gate.** Obsidian's `debounce(fn, delay)`
  without `resetTimer` fires on schedule regardless of typing. So full rebuilds land **mid-typing**
  about once per 2.5 s during continuous editing. "Only compute after a ≥2000 ms pause" needs a
  different scheduler shape (see §4B).
- **Bonus defect:** folder-priority ranking is **inert at shipped defaults**: `limitingFolder`
  defaults to `""`, so the `fileTier` precompute that runs on every refresh is dead work, and
  `computeLinkRank` bails before reading it. Nothing catches this because the wiring is untested.

**Verdict on "stupid logic": yes, in three places** — ungated full rebuilds, mid-typing
scheduling, and a handful of dead/constant-factor sins. None are large in absolute ms at 14k
files (a few ms per event), but they all grow linearly with vault size and all land on the main
UI thread.

---

## 1. What happens when you type

```
keystroke
  │
  ▼  per keystroke — no vault access, O(line)
onTrigger (AutoCompleteSuggest.ts:1156-1355)
  │  19 gates: settings gates, IME, suppress patterns, math/code block,
  │  2× tokenizer passes over the line, min-length ≥3 chars, trigger info
  │  every bail → this.close() (popup torn down)
  ▼
getSuggestions (AutoCompleteSuggest.ts:582-732)
  │  debounce(delayMilliSeconds = 0 default) → JSON.parse of query blob
  ▼
suggestWords per phrase query (1–3 queries from last-3-token window)
  (suggester.ts:355-529)
  │  pick bucket by query's first letter (+ case variant) → COPY both arrays
  │  scan EVERY entry: toLowerCase().startsWith(queryLower) (+ alias loop on miss)
  │  phase 2 (only if exact hits < 5): judgeLite fuzzy char-scan over the rest
  │  selectTopK keeps ≤ 5 (O(N + k²), not a full sort)
  ▼
popup rows (≤5), each ≤15-word sort/filter/uniq in the caller
```

Key facts:

- **There are no trigger characters.** `[`, `]`, `"` etc. are *trim characters* in the tokenizer
  (`AbstractTokenizer.ts:9-10`); `[[Foo` tokenizes into phrase `"[[Foo"` + suffix token `"Foo"`,
  and the suffix is what matches (probe-verified, typing-notes §1.4). With the default 3-char
  threshold, nothing appears until the 3rd character after `[[`.
- **Matching is O(bucket), not O(prefix).** `cha`, `char`, `ch` all scan the same ≈13k-entry pool;
  only the matched set shrinks. No trie, no prefix index — a flat
  `{firstLetter: Word[]}` object.
- **Ranking is NOT on the keystroke path.** The per-keystroke option carries no `rankData`/cache
  (`AutoCompleteSuggest.ts:672-681`); ranks are pre-stamped on `Word`s during idle annotate
  (`requestIdleCallback`, `AutoCompleteSuggest.ts:1032-1057`) — though at defaults that stamping
  never happens (§3.5 below).
- Measured: `suggest-keystroke` p50 **1.40 ms** (folder priority off) / 2.94 ms (on), pool 13,000;
  full 300-keystroke session sim ≈ **1.8 ms/keystroke** (`bench/results/latest.md`). The earlier
  docs' "35–41 ms per keystroke" costs no longer exist at HEAD.

---

## 2. Index lifecycle — what happens around saving

| Event | Debounce | Work | Cost |
|---|---|---|---|
| `metadataCache "resolved"` | none (one-shot at startup, then off) | full rebuild of all providers + vault read | O(vault bytes) |
| `metadataCache "changed"` | **2500 ms** | `markSourceStale` (0.014 ms) + **FULL internal-link word reindex, unconditional** | ≈4.1–5.1 ms (5.9–6.6 with aliases) + idle annotate |
| `vault "modify"` | 300 ms | cachedRead + FNV hash + **full re-tokenize of active file** | 1.6 / 7.1 / 19.8 ms @ 25/100/250 KB |
| `vault create/delete/rename` | 2500 ms | rank-index delta + structure bump + full reindex | O(vault) — *justified*: structure really changed |
| `active-leaf-change` | **none** | refresh current-file tokens + **full internal-link reindex** | O(vault) **per note switch** |
| settings save / manual command | none | full rebuild + cache invalidation | O(vault) |

### The cascade for one new `[[link]]`

```
type chars      → onTrigger + bucket scans                     (no reindex)
complete it     → selectSuggestion + history increment          (no reindex)
~2 s (Obsidian save) → vault "modify" → 300 ms → full re-tokenize of active file
                → metadataCache "changed" → markSourceStale (0.014 ms, delta-aware)
                → 2500 ms → refreshInternalLinkTokens: clearWords() + FULL 14k-file rebuild
                → requestIdleCallback(timeout 4 s) → getRankData + getList
                   + per-word computeLinkRank ×14k + ensureSummary (11.6 ms)  ← recomputes
                     an unchanged answer
```

Two caches with two different gate qualities:

- **`LinkRankIndex` — gate is correct.** `markSourceStale(path)` snapshots the file's old link
  contribution; `getRankData` diffs it lazily and bumps the version **only when the contribution
  actually changed** (`LinkRankIndex.ts:152-166, 349-361, 364-401`). Prose saves ⇒ 0/20 version
  bumps. O(1) per save. This is the delta-aware machinery from AGENTS.md, working as designed.
- **`FolderRankCache` — gate leaks.** The summary memo key is `(rankIndex.currentVersion,
  structureEpoch)` (`FolderRankCache.ts:152-160`). A real link change bumps the version ⇒ one more
  full 14k-file scan (measured 11.6 ms) recomputing an answer that doesn't depend on links. The
  perf doc's claim that F3 fixed this is wrong.
- **The word index has no gate at all.** `refreshInternalLinkTokens` → `refreshWords()` starts with
  `clearWords()` and rescans every file (synchronous, no empty window — but also no
  "did anything change?" predicate).

### Scheduler shape (the subtle part)

There is **no `maxWait` anywhere**. Obsidian's `debounce(fn, delay, resetTimer?)`:
with `resetTimer=false` (used for the 2500 ms reindex) it's a **rate limiter** — fires every 2.5 s
even mid-typing; with `resetTimer=true` it would reschedule forever and can **starve** under
continuous typing. Neither is "run after 2 s of silence". The idle pattern that does exist in
this codebase is `requestIdleCallback(…, {timeout: 4000})` around the annotate block
(`AutoCompleteSuggest.ts:1032-1057`).

---

## 3. Stupid-logic audit — waste inventory (ranked)

| # | Waste | Site | Cost / trigger | Status |
|---|---|---|---|---|
| 1 | **Full word-index rescan on every metadata change — no "did the links change?" gate** | `InternalLinkWordProvider.refreshWords` (`:42,58-59,167-170,204-209`), scheduled at `AutoCompleteSuggest.ts:289` | 4.1–5.1 ms (5.9–6.6 w/ aliases), up to once per 2.5 s **mid-typing** | ❌ the gap you suspected |
| 2 | **Rate limiter instead of idle gate; no maxWait anywhere** | `AutoCompleteSuggest.ts:238-241` | rebuilds land mid-typing during continuous editing | ❌ |
| 3 | **`ensureSummary` rescans 14k files when the rank version bumps** | `FolderRankCache.ts:152-160,165` | 11.6 ms per real link change, for an unchanged answer | ❌ (perf doc says fixed; it isn't) |
| 4 | **Idle annotate is one unchunked long task** (getRankData + cold getList 23–40 ms + 14k-word rank loop in one idle callback) | `AutoCompleteSuggest.ts:1032-1057` | frame drops between keystrokes | ❌ |
| 5 | **Dead precompute at defaults:** `refreshWords` stamps `fileTier` on every word (`:176-202`) but `computeLinkRank` bails before reading it when `limitingFolder === ""` (`LinkRank.ts:66-69`). Also means **folder ordering is silently inert** at defaults | `InternalLinkWordProvider.ts:176-202`, `model/LinkRank.ts:58-69` | ≈1 ms/refresh wasted + defect | ❌ no test covers the wiring |
| 6 | `active-leaf-change` does a full O(vault) reindex on **every note switch**, ungated | `AutoCompleteSuggest.ts:270-280` | 4–7 ms per file switch | ❌ |
| 7 | Keystroke-path constant factors: per-candidate `toLowerCase()` allocs (~B strings/keystroke), `linkRanks` Map rebuilt per pass, two rank stages both calling `getOrComputeLinkRank`, phrase queries that can never match still scan a whole bucket (Q multiplier — up to ⅔ of work discarded) | `suggester.ts:443,539,569-580,147-151`; `AutoCompleteSuggest.ts:1250-1257` | ~1–2 ms/keystroke | ❌ |
| 8 | Full re-tokenize of active file per save even when only a few chars changed (hash only helps byte-identical) | `CurrentFileWordProvider.ts:59-107` | 1.6–19.8 ms per save | ❌ |
| 9 | Small stuff: eager debug strings built & discarded per keystroke; `setSelectionLock` DOM write (`querySelector("body")`) per keystroke; `partial` match mode (non-default) flattens the whole index per keystroke | `AutoCompleteSuggest.ts:1193-1315,1600-1609`; `suggester.ts:872-900` | minor | ❌ |

Already correct (leave alone): keystroke path is vault-free; `LinkRankIndex` delta application
(0.014 ms/save); `selectTopK` instead of full sort; two-phase exact-prefix matching; synchronous
rebuild causes no visible empty window.

---

## 4. The two lazy ideas, evaluated

### Idea A — "only recompute the index if there are new links"

> **Correction (2026-10-28, later code verification):** this section's predicate is wrong for
> the *word index*. The word index does not read the file's own `resolvedLinks` at all — a new
> `[[link]]` between existing notes changes zero words. The real gate is a per-file **word
> signature** (basename, aliases, unresolved names, exclusions, settings). See
> `research/lazy-gate-design-2026-10-28.md`.

**Right instinct, and cheap: the predicate already exists half-built.**

- `LinkRankIndex.markSourceStale(path)` already snapshots the file's old contribution
  (`:152-166`) and `getRankData` diffs it against live metadata (`:364-401`), bumping the version
  only when the contribution changed (`:349-361`).
- Change: make `markSourceStale` **return boolean** "contribution changed", and in the
  `metadataCache "changed"` handler schedule `refreshInternalLinkTokens()` **only when it returns
  true** — or when the file's **basenames/aliases changed** (the word index contains basenames and
  aliases, not just links), or on structure events (create/delete/rename, which have their own
  handlers). ≈10–15 lines.
- Correctness details: link **removal** also counts (the diff is equality, not "added"); a rename
  changes words without changing links; aliases live in frontmatter metadata, so include them in
  the diff or alias suggestions go stale.
- With this gate, prose typing/edits stop paying the 4–6 ms full rebuild + the 11.6 ms
  `ensureSummary` scan entirely; only real link edits pay.

### Idea B — "compute the index only while idle (pause ≥ 2000 ms)"

**Also right, but the current debounce can't express it.**

- Today's `debounce(fn, 2500)` (no `resetTimer`) fires **mid-typing** on schedule. Converting to
  `resetTimer=true` alone would starve the index during continuous typing (no maxWait exists).
- Two workable shapes:
  1. `resetTimer=true` + hand-rolled `maxWait` (record first-dirty timestamp; force the rebuild
     after e.g. 10 s of continuous typing). Obsidian's debounce has no maxWait param — hand-roll.
  2. Keep the rate limiter but guard the rebuild itself:
     `if (performance.now() - lastKeystrokeAt < 2000) { setTimeout(recheck, 2000); return; }`.
     In-repo precedent: `primeFolderSummaryIdle` / the `requestIdleCallback(timeout: 4000)`
     annotate block.
- Interplay with idea A: once rebuilds only happen on *real link changes* (which mostly happen
  exactly when you type a new `[[link`), the idle gate slightly delays visibility of that new
  link in future suggestions. Acceptable — today it's not immediate either — but keep `maxWait`
  so it can't be starved forever.
- Honest framing: after idea A, the remaining event-path work is small and rare, so idea B
  becomes mostly about *where* the ensure-summary/annotate work lands (frame budget), not about
  avoiding waste.

### The better lazy lever — per-file incremental rebuild

Both ideas gate the *trigger*; the rebuild itself is still a synchronous full O(vault) rescan
(`clearWords()` → loop all files). Cost proportional to the edit needs `wordsByPath` (per-file
word lists, removable from buckets) so a link change patches one file's words. Frontmatter
already does exactly this (`updateWordIndex`, `AutoCompleteSuggest.ts:285,1124`); internal links
don't. This is the design that makes "recompute when links change" nearly free even at much
larger vault sizes — bigger refactor, do it after the cheap gates if index cost ever matters.

---

## 5. What I'd change, ranked

| # | Change | Removes | Effort |
|---|---|---|---|
| 1 | Gate `refreshInternalLinkTokens` on "contribution changed" (make `markSourceStale` return it; cover basename/alias changes; on `active-leaf-change` only when dirty) | 4–7 ms × ~24/min mid-typing | ≈15 lines |
| 2 | Replace the 2500 ms rate limiter with a true idle gate (`resetTimer` + hand-rolled maxWait, or `lastKeystrokeAt` guard) | mid-typing bursts | small |
| 3 | Drop the version term from `ensureSummary`'s memo key (structureEpoch only) | 11.6 ms per real link change | 1 line |
| 4 | Make the `fileTier` precompute real (honour `word.fileTier` before the `rankData` bail) or skip stamping when `limitingFolder === ""` — decide which ordering you actually want at defaults | ~1 ms/refresh + fixes inert folder-priority defect | small, needs a product decision + wiring test |
| 5 | Keystroke-path cleanups: lowercase shadow values at refresh, drop unmatchable phrase queries, reuse the `linkRanks` map | ~1–2 ms/keystroke | small |
| 6 | Per-file incremental internal-link index (`wordsByPath`) | makes rebuild O(edited file) | larger |
| 7 | Chunk the idle annotate long task | frame drops between keystrokes | small |

Items 1–3 are exactly the lazy logic asked about. 5–7 are worthwhile only if vault size keeps
growing or profiling shows the remaining costs.

---

## 6. Provenance & caveats

- Evidence: `research/typing-path-notes-research.md` (425 lines), `research/overwork-audit-notes-research.md` (386 lines), both with file:line anchors at HEAD `bfc58e8`.
- ms figures: `bench/results/latest.md`, Node-side with stubbed Obsidian, N=7 quick mode, 14k-file
  fixture. No in-app profiling yet. This vault's real bucket size may be smaller than the
  13k-pool bench (exclusions/alias config differ).
- Stale prior docs flagged by the audit: `codebase-map.md` (1000→2500 ms, old wiring),
  `performance-measurement-2026-10-28.md` (F3/F7), `performance-measurement-2026-10-29.md`
  §1c/§2, `typing-speed-audit-2026-10-29.md` §5 (several items already fixed at HEAD).
- Per AGENTS.md: any cache/gate change here must stay delta-aware and honest — a coarse version
  bump is what caused the 2026-10-28 stall regression; don't reintroduce one.
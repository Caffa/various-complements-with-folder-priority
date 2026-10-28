# Lazy-index implementation plan — Waves A/B/C of lazy-gate design §8 (2026-10-28)

Design basis (read in full, do not re-derive):
- `research/lazy-gate-design-2026-10-28.md` (§ numbering below refers to this)
- `research/lazy-gate-verification-notes.md`
- `research/overwork-audit-notes-research.md`, `research/typing-path-notes-research.md`
- `bench/results/latest.md` (baseline)

Working-tree state: HEAD `bfc58e8` **plus uncommitted edits** (verified via `git status`/`git diff`)
in `src/model/LinkRank.ts`, `src/provider/suggester.ts`, `src/ui/AutoCompleteSuggest.ts`,
`src/storage/LinkRankIndex.ts`, `src/setting/settings.ts`, plus new tests in
`src/model/LinkRank.test.ts`, `src/provider/suggester.test.ts`,
`src/composables/settings/useFilterSetting.ts`. The plan builds **on top of the working tree**,
never reverts it.

⚠️ **One premise of the instructions no longer holds** — see Decision D-4 (G4) before building Wave A.

---

## 0. Context Read (file:line anchors verified against working tree, 2026-10-28)

| Location | What it showed |
|---|---|
| `src/ui/AutoCompleteSuggest.ts:95` | `folderAnnotationGeneration = 0` (uncommitted; guards idle annotate) |
| `:104` | `debouncedRefreshInternalLinkTokens: Debouncer<[], Promise<void>>` field decl |
| `:122` | `metadataCacheChangeRef: EventRef` |
| `:132` | `unloaded = false` |
| `:238-241` | 2500 ms debounce def (rate limiter, `resetTimer=false`) — G2 target |
| `:243-246` | `vault "modify"` handler ignores file arg → `debouncedRefreshCurrentFileTokens` — G6 target |
| `:247-253 / :254-260 / :261-269` | rename/delete/create handlers: `markSourceStale/onRename/onDelete` + `folderRankCache.bumpStructure()` + `primeFolderSummaryIdle()` + `debouncedRefreshInternalLinkTokens()` |
| `:270-280` | leaf-change: `await refreshCurrentFileTokens()` + **`refreshInternalLinkTokens()` (full O(vault) rebuild per switch)** — G5 target |
| `:282-290` | `metadataCache "changed" (f)`: markSourceStale + frontmatter bits + `debouncedRefreshInternalLinkTokens()` — G1 target |
| `:293-304` | `"resolved"` one-shot: `invalidate()` + full refreshes (stays) |
| `:423-435` | `unregister()`: all `offref`s; teardown point for the scheduler |
| `:505-508` | `updateSettings`: `settings = settings`, `linkRankIndex.invalidate()`, `folderRankCache.invalidate()` |
| `:672-681` | typing-path option bag: `{enabled, currentFilePath, limitingFolder}` only — no rankData |
| `:960-978` | `primeFolderSummaryIdle` (rIC, timeout 2000; `setTimeout` fallback) |
| `:980-1069` | `refreshInternalLinkTokens`: status bar, disabled-branch clearWords, `refreshWords({...})` (:996-1018), annotate block (:1020-1058, generation-guarded rIC timeout 4000), `setInternalLinkIndexed` (:1060), `primeFolderSummaryIdle()` (:1064) |
| `:1156-1179` | `onTrigger` head — `noteKeystroke()` hook point (very first line, before all gates/bails) |
| `src/provider/InternalLinkWordProvider.ts:19-21` | `words: Word[]`, `wordsByFirstLetter`, `lastRefresh` |
| `:28-222` | `refreshWords(option)` — clearWords (:42), ignorePrefix compile (:44-55), per-file filter (:58-84), flatMap word build (:85-148), phantoms (:150-165), **fileTier stamping block (:172-202)**, bucket fill (:204-209), lastRefresh (:211-216), catch rethrow (:217-221) |
| `:224-259` | `annotateRankData(...)`: builds option + cachedList via `folderRankCache.getList` (:239-246), per-word `computeLinkRank` + stamp `fileTier/folderProximity/linkRank/_rankPrecomputed` (:248-258) |
| `:261-268` | `clearWords()` (keeps lastRefresh), `wordCount` |
| `src/storage/FolderRankCache.ts:38-48` | `FolderQualification {qualified, version}` (version dead), `VaultSummary {version, structureEpoch, direct, nonLeaf}` |
| `:152-194` | `ensureSummary`: memo key = `summary.version === currentVersion && summary.structureEpoch === structureEpoch` (:155-158) — G3 target; scan at :165-175; qualifications write :184-193 (`.version: currentVersion` at :192 — dead, read only `?.qualified` at :90-91) |
| `:68-117` | `getList` — limiting-folder bail (:73-76), list cache key includes `rankIndex.currentVersion` (:101-113) — **stays** |
| `src/storage/LinkRankIndex.ts:105-121` | `markSourceStale` with uncommitted `builtForLimitingFolder === ""` early return |
| `src/provider/suggester.ts:17` | `WordsByFirstLetter = { [firstLetter: string]: Word[] }` |
| `:47-65` | `suggestionUniqPredicate` — `createdPath` participates for non-phantom internalLink |
| `:67-79` | `pushWord` — appends, **no dedupe** (no removal precedent anywhere) |
| `src/model/LinkRank.ts:53-107` (uncommitted) | `computeLinkRank`: `_rankPrecomputed` short-circuit (:58-64); uncommitted `!rankData` branch returns `{fileTier: word.fileTier ?? false}` (:66-73) — **G4 collision, see D-4** |
| `src/model/Word.ts:54-63` | `InternalLinkWord {phantom, aliasMeta, fileTier, folderProximity, linkRank, _rankPrecomputed}` |
| `src/setting/settings.ts:104-123, :241-259` | word-affecting settings (the 11-list for the settings signature) |
| `:281-286` | folderPriority defaults + **uncommitted comment: "a blank limitingFolder degrades to fileTier-only ranking"** — another G4-collision marker |
| `src/main.ts:237-256` | `saveSettings` → `updateSettings` + optional `refreshInternalLinkTokens()` (:253-255) |
| `:213-220` | manual `reload-internal-link-index` command → direct full rebuild (stays) |
| `src/ui/popup-commands.ts:130-135` | one-shot `"changed"` listener → direct `refreshInternalLinkTokens()` (stays) |
| `bench/` | `pnpm benchmark` (21 it) / `benchmark:quick` (7 it, BENCH_N=7) / `benchmark:bundle`; scenario modules in `bench/scenarios/*.ts`, fixtures deterministic seed, `bench/harness.ts` builds a stub app; `refresh-after-change.ts` measures per-save suggest pass and prints BUMPED/unchanged |

---

## 1. Assumptions

1. **Wave A first, no behavioral ordering changes beyond documented ones** — the repo favors minimal,
   behavior-preserving diffs (AGENTS.md; every prior perf commit is structured this way). Each wave
   is independently shippable and bench-measured.
2. **The scheduler never clears the index.** `refreshWords` is synchronous clear+rebuild inside one
   call today (no visible empty window — typing-path doc §4.3); the gate keeps calling exactly that
   function, preserving the invariant.
3. **Per-file word signature is file-shape-only + a separately compared global settings signature.**
   Per-file sigs survive settings changes without repopulation (file inputs don't change when
   settings do); this avoids an O(vault) sig repopulation after every settings rebuild.
   (Deviation from design §5.2's single-hash spec: same properties, clearer ownership.)
4. **maxWait anchors on firstPendingAt (first signature check request), not firstDirtyAt.**
   Strictly tighter than §1's `firstDirtyAt`; identical guarantee class (≤10 s staleness).
5. **Structure events keep Tier 1 (full rebuild) in Wave C.** Create/rename/delete are rare and
   phantom words of *other* source files change when a target appears/disappears; patching only the
   event file would leave stale phantoms. Full rebuild handles that coupling for free.
6. **Jest has no `requestIdleCallback`** (Node) — all new idle code must degrade to `setTimeout(_, 0)`
   like `:971-977` and `:1051-1057` already do. Tests exercise the fallback path.

---

## 2. Decisions (asked-for call + rationale)

### D-1: Scheduler lives in `src/util/idle-refresh-scheduler.ts` (new, framework-free)
- The scheduler's state machine (idle gate, maxWait, re-check loop, coalescing) is exactly the test
  surface design §7 demands; testing it inside `AutoCompleteSuggest` would drag in Svelte/Obsidian
  (that file has **zero tests today** — the doc'd root cause of the dead-wiring defect).
- `AutoCompleteSuggest` keeps only thin event wiring (same pattern as the existing debouncers).
- Signatures: injectable clock/timers so tests and `bench/` (Node) drive it deterministically.

### D-2: Data ownership
| State | Owner | Why |
|---|---|---|
| `storedWordSig: Map<path, number>` + `pendingSigCheck: Set<path>` | **new `InternalLinkIndexGate`** (`src/provider/internal-link-index-gate.ts`) | single owner of the dirty ledger; provider knows *how* to compute signatures, gate decides *when* |
| scheduler state (`lastActivityAt`, timers, pending keys) | `IdleRefreshScheduler`, owned by the gate | pure, injected fire callback |
| word index (`words`, `wordsByFirstLetter`, **+ Wave C `wordsByPath`**) | `InternalLinkWordProvider` | as today |
| last keystroke timestamp | scheduler (`noteActivity()`, called from `onTrigger`) | design §1 line 1 |
| rank index / structure epoch | `LinkRankIndex` / `FolderRankCache.bumpStructure` — untouched | already delta-aware (audit ✅ rows 10/11) |

### D-3: Minimal-diff stance
- Keep `refreshInternalLinkTokens()` as the Tier-1 entry point (settings, manual command,
  popup-commands, startup `"resolved"` all keep calling it directly — cheap, rare, correct).
- Only the **hot recurring paths** (metadata "changed", leaf-change, vault "modify") move behind
  the gate. No new abstraction layers beyond the two new util/provider modules.
- The `debouncedRefreshInternalLinkTokens` field + definition (`:104`, `:238-241`) are **removed**
  (no other callers — verified by grep); the 2500 ms rate limiter is fully replaced by the gate.

### D-4: **G4 — remove refresh-time `fileTier` stamping. DECISION STATED EXPLICITLY + COLLISION FLAGGED**
The instruction says the fileTier stamping (`InternalLinkWordProvider.ts:176-202`) is "verified dead
at defaults". **That was true at HEAD `bfc58e8` but is FALSE in the working tree**: an uncommitted
edit to `computeLinkRank` (`src/model/LinkRank.ts:66-73`) makes the `!rankData` branch return
`{fileTier: word.fileTier ?? false}` — and the default config (`folderPriority.enabled: true`,
`limitingFolder: ""`) runs `compareLinkTier` on every keystroke, reading exactly that stamp. The
uncommitted `settings.ts:281-283` comment documents this as intended product behavior
("blank limitingFolder degrades to fileTier-only ranking").

Semantically the stamping is still wrong by construction (it is active-file-relative and refreshed
by event luck, not by note switch — design §5.5). Therefore:

- **Implemented (per instruction):** delete the stamping block (`:172-202`) and drop the
  `currentFilePath` option field from `refreshWords` + its caller (`:1017`).
- **Consequence:** at defaults, internalLink ordering loses the fileTier boost (unstamped words →
  `fileTier false` → `compareLinkTier` ties). In limited-folder mode the annotate path remains the
  only fileTier producer (kept, as instructed), restamped on note switch (G5) and after patches.
- **Flag for the orchestrator:** the uncommitted `LinkRank.ts` fallback becomes dead-ish at defaults;
  the uncommitted `settings.ts` comment and the design doc now disagree. **Ask the boss:** keep
  default-config fileTier-only ranking (revert G4 / move the stamp into a leaf-change restamp —
  "Variant B" below) or accept inertia at defaults (Variant A, implemented here). **Plan proceeds
  with Variant A** because the boss explicitly instructed removal; nothing in Wave A breaks the
  uncommitted `computeLinkRank` unit test (it tests the function contract, not the wiring).
- Variant B sketch (only if boss says so): keep stamping as a standalone
  `restampFileTier(activePath)` method, called once per full rebuild (preserves today's ordering)
  and on leaf-change via the idle annotate machinery; costs ~1 ms per rebuild retained.

### D-5: Where Wave C patch() anchors the drain
`InternalLinkIndexGate.fire()` distinguishes two drained classes:
- `structureSet` non-empty (create/rename/delete) → one `refreshFull()` (covers phantom coupling).
- else → `patchFiles(dirtyPaths)` (Tier 3) when present; falls back to `refreshFull()` in Wave A.

---

## 3. Wave A — gates (G1 signature+ledger, G2 idle scheduler, G3 memo key, G4 stamping removal, G5 leaf-change dirty-only, G6 modify guard)

### Step A1 — new `src/util/idle-refresh-scheduler.ts`
```ts
export type IdleRefreshSchedulerOptions = {
  idleThresholdMs?: number;  // default 2000 (design §1)
  maxWaitMs?: number;        // default 10000
  pollIntervalMs?: number;   // default 2000
  now?: () => number;                       // injectable, default () => Date.now()
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  cancelTimeout?: (handle: unknown) => void; // injectable for tests
};
export class IdleRefreshScheduler {
  constructor(private fire: () => void, private opts: IdleRefreshSchedulerOptions);
  noteActivity(): void;                 // O(1): lastActivityAt = now
  markPending(key: string): void;       // adds key; arms loop if idle
  hasPending(): boolean; pendingCount(): number;
  pendingKeys(): ReadonlySet<string>;
  lastActivityAt: number; firstPendingAt?: number;   // exposed for tests/bench
  stop(): void;                         // cancel timer + clear pending (for unregister())
}
```
Loop (matches design §1 `fire()` pseudocode verbatim):
```
check():
  pending empty → armTimer = undefined; return
  idle = now - lastActivityAt >= idleThresholdMs
  late = now - firstPendingAt >= maxWaitMs
  idle || late ? (armTimer = undefined; this.fire())
               : scheduleTimeout(check, pollIntervalMs)
```
No vault/suggester imports. No O(vault) anything (AGENTS.md keystroke-path rule).

### Step A2 — new `src/provider/internal-link-word-signature.ts`
```ts
export const SEPARATOR = "\u0001"; // per-field, "\u0002" between list items
export function computeFileWordsSignature(
  file: TFile,
  parts: { aliases: string[]; excluded: boolean; tags: string[]; unresolvedNames: string[] },
): number;  // FNV-1a 32-bit of: path ‖ basename ‖ sorted(aliases) ‖ excluded ‖ sorted(tags) ‖ sorted(unresolvedNames)
export function computeInternalLinkSettingsSignature(settings: Settings): number;
// FNV-1a over EXACTLY the word-affecting 11 (settings.ts:104-123):
//   suggestInternalLinkWithAlias, suggestAliasesOnly, internalLinkIgnoreTriggerPrefixes,
//   excludeInternalLinkPathPrefixPatterns, excludeInternalLinkPathGlobPatterns,
//   matchingWithoutEmoji, treatAccentDiacriticsAsAlphabeticCharacters,
//   frontMatterKeyForExclusionInternalLink, tagsForExclusionInternalLink,
//   excludeUnresolvedInternalLinks, enableInternalLinkComplement
export function collectFileWordsParts(app: App, appHelper: AppHelper, file: TFile, option: RefreshOption-ish): parts;
// ONE getFileCache per file (getAliases/getBoolFrontMatter/getTagsProperty each call getFileCache
// today — do not call them 3×; read cache once and derive). unresolvedNames =
// Object.keys(metadataCache.unresolvedLinks[file.path] ?? {}) — raw case (design §5.2,
// verification Q4: word index keeps raw case; only LinkRankIndex lowercases).
```
Rationale for colocating with the provider: the signature fields ARE `refreshWords`' per-file
inputs (`InternalLinkWordProvider.ts:85-165`); proximity makes input drift a review obligation, and
the test imports both together.

### Step A3 — new `src/provider/internal-link-index-gate.ts`
```ts
export type InternalLinkIndexGateDeps = {
  computeFileSignature: (path: string) => number;
  computeSettingsSignature: () => number;
  isIndexEnabled: () => boolean;          // enableInternalLinkComplement
  refreshFull: () => void;                // Tier 1 = existing refreshInternalLinkTokens()
  patchFiles?: (paths: Set<string>) => void;   // Wave C; absent in Wave A
};
export class InternalLinkIndexGate {
  constructor(deps, schedulerOpts?: IdleRefreshSchedulerOptions);
  noteKeystroke(): void;                       // → scheduler.noteActivity()
  requestSignatureCheck(path: string): void;   // metadata "changed" / "resolve"
  requestStructureRefresh(op: {kind: "create"|"rename"|"delete"; path: string; oldPath?: string}): void;
      // delete: storedSigs.delete(path) + dirty(path) directly (file gone — sig diff meaningless)
      // create/rename(newPath): storedSigs.delete(oldPath?) + pendingSigCheck.add(newPath)
  noteSettingsChanged(): void;                 // recompute settingsSig (µs); per-file sigs untouched (Assumption 3)
  populateSignatures(): void;                  // O(vault) one pass → stored sigs; called after the startup
                                               // "resolved" full rebuild (and any later cold-store fill)
  clearSignatures(): void;                     // when disabled / plugin teardown
  stop(): void;                                // scheduler.stop()
  // internals: private storedSigs = new Map<string, number>();
  //            private dirtyPaths = new Set<string>(); private settingsSig: number;
  fire(): void;   // scheduler callback: drain pending → diff → collect dirty →
                  // D-5 dispatch (Tier 1 in Wave A, patch when available); empty dirty → no-op
  // test hooks: forceFire(), stats (fires, rebuildsCoalesced, sigDiffsChecked)
}
```
Ignored-prefix files: `computeFileSignature` still returns a value, but the gate **skips storage**
for files whose basename matches `internalLinkIgnoreTriggerPrefixes`-compiled patterns (design
§5.2 "skip storage for ignore-prefix files") — implementation: deps include
`isIgnoredBasename(path)`. Skipped storage ⇒ stored===undefined ⇒ every `changed` marks them dirty
(conservative; matches pre-gate behavior; saves are rare for these generated-name files).

### Step A4 — rewire `src/ui/AutoCompleteSuggest.ts`
1. **Fields:** delete `debouncedRefreshInternalLinkTokens` (`:104`) and its def (`:238-241`); add
   `internalLinkGate?: InternalLinkIndexGate` (created in `static new()` after `folderRankCache`,
   with deps wired to `appHelper`, `this.settings`, `this.refreshInternalLinkTokens`).
2. **`onTrigger`** (`:1156`): first statement `this.internalLinkGate?.noteKeystroke();` — before all
   gates/bails so every editor change (incl. bails, mouse moves, IME) counts as activity.
3. **`vault "modify"`** (`:243-246`): G6 —
   `if (f instanceof TFile && ins.appHelper.isActiveFile(f)) ins.debouncedRefreshCurrentFileTokens();`
   (non-active saves no longer schedule a re-tokenize of the active file; audit row 8; history-persist
   logic inside the 300ms debounced callback is selection-history driven and can only be dirty from
   active-file completion, so skipping is safe).
4. **rename** (`:247-253`): keep `onRename`, `bumpStructure`, `primeFolderSummaryIdle`; replace
   `debouncedRefreshInternalLinkTokens()` with `ins.internalLinkGate.requestStructureRefresh({kind:"rename", path: file.path, oldPath})`.
5. **delete** (`:254-260`): same with `{kind:"delete", path: file.path}`.
6. **create** (`:261-269`): keep `markSourceStale(f.path)` (rank), `bumpStructure`, prime; then
   `requestStructureRefresh({kind:"create", path: f.path})`.
7. **leaf-change** (`:270-280`): G5 — keep `predictableCycleState = null` and
   `await refreshCurrentFileTokens()`; **remove `refreshInternalLinkTokens()`**; add
   `ins.internalLinkGate.requestAnnotationRefresh()` — limited-folder mode only (see Step A6).
   At defaults this does nothing (no word or rank work per note switch — audit table row 6).
8. **`metadataCache "changed"`** (`:282-290`): keep `markSourceStale(f.path)` + the frontmatter
   bits (unchanged behavior); replace the final `debouncedRefreshInternalLinkTokens()` with
   `ins.internalLinkGate.requestSignatureCheck(f.path)`.
9. **`"resolved"`** (`:293-304`): after `refreshInternalLinkTokens()`, add
   `ins.internalLinkGate.populateSignatures()` (one O(vault) pass, ~5-10 ms, same event that already
   did the O(vault) rebuild). Note: `unresolvedLinks`-driven sig content needs metadataCache to hold
   the file cache — it does at this point (that's the event's contract).
10. **`updateSettings`** (`:505-508`): after `this.settings = settings`, call
    `this.internalLinkGate?.noteSettingsChanged()`.
11. **`unregister`** (`:423+`): `this.internalLinkGate?.stop(); this.internalLinkGate?.clearSignatures();`
12. **Optional hardening (recommended, 3 lines):** also register
    `metadataCache.on("resolve", (f) => ins.internalLinkGate.requestSignatureCheck(f.path))`
    (with its own `EventRef` + `offref`) — closes the phantom-lag window (verification Q7: resolution
    can land after `changed`; `resolve` always follows `changed` for the same file). Over-triggers
    are cheap (sig diff, µs each).

### Step A5 — `src/storage/FolderRankCache.ts` (G3)
- `ensureSummary` (`:152-160`): drop the `version` term → memo on `structureEpoch` only;
  delete the now-unused `currentVersion` local (`:153`).
- `VaultSummary` (`:43-48`): remove `version`; `FolderQualification` (`:38-41`): remove `version`;
  `:192` becomes `this.qualifications.set(folder, { qualified })`.
- `getList`'s version keying (`:101-113`) **stays** — it is correct (delta-aware bump; audit rows 10/11).
- Verified consequence-free: qualification output cannot depend on links (`:165-175` reads only
  `file.path`); `qualifications[].version` is dead (`:192`, read `?.qualified` only `:90-91`).

### Step A6 — `refreshInternalLinkTokens` annotate block → reusable method (enables G5 + Wave B/C)
Extract `:1020-1058` into:
```ts
private scheduleFolderRankAnnotation(capturedActivePath: string | null, capturedLimitingFolder: string): void
```
- same generation guard (`folderAnnotationGeneration`), same rIC/timeout fallback, same settings re-checks.
- `refreshInternalLinkTokens` calls it where the inline block ran (no behavior change).
- Gate dep for leaf-change: `requestAnnotationRefresh()` → in limited mode bumps generation and
  schedules the annotate closure for the NEW active file (rank stamps are active-file-relative);
  at defaults: no-op. This is the "dirty-only" reading of design §2 row 6.

### Behavior preserved per AGENTS.md
- No O(vault) on the keystroke path (scheduler is idle-gated or capped; `noteKeystroke` is O(1)).
- Delta-aware invalidation semantics (bump only where a value changed) — signature diff literally
  implements "value changed" for the word index; G3 removes a bump that could not change output.
- Latency-sensitive refreshes: maxWait 10 s replaces the starving 2500 ms rate limiter
  (AGENTS.md "hidden cost of debounced reindex"); no clear-then-rebuild window introduced.
- `structureEpoch` still bumps on create/rename/delete → folder structures stay fresh.

### Wave A tests (colocated)
| File | Cases |
|---|---|
| **new** `src/util/idle-refresh-scheduler.test.ts` | idle re-arm (keystroke at t, check at t+1.5 s re-arms); fires when idle ≥2000; keystroke postpones fire; maxWait forces at 10 s despite activity; coalescing: `markPending` ×500 → one `fire()`; empty pending → never fires (no timer leak); `stop()` cancels pending (fake timers) |
| **new** `src/provider/internal-link-word-signature.test.ts` | alias add/remove → differ; basename change → differ; unresolved name add → differ; phantom resolution (unresolved shrinks) → differ; tags toggle → differ; exclusion flag toggle → differ; prose edit → equal; link-between-existing (only `resolvedLinks` changed) → equal; each of the 11 settings → settingsSig differs; non-word settings (folderPriority, delay, etc.) → settingsSig equal; path-only rename → differ |
| **new** `src/provider/internal-link-index-gate.test.ts` | `requestSignatureCheck` + equal sig → no rebuild (refreshFull spy 0); differing sig → dirty → exactly 1 `refreshFull` per fire (500 dirty paths coalesced); ignore-prefix file → always dirty; settingsSig bump → dirty-all on next fire; rename/delete/create routing; `populateSignatures` fills store so a post-populate no-change event is a no-op; `stop()` clears |
| **extend** `src/storage/FolderRankCache.test.ts` (F3 describe, `:616-640`) | link-version bump WITHOUT structure bump → `ensureSummary` does **not** rescan (spy `getMarkdownFiles` call count; existing tests at `:299`/`:323` cover buildList version-keying — keep passing); `bumpStructure` → rescan (existing `:638` keeps) |

### Risks & simplification traps — Wave A
- **Signature drift:** `refreshWords` gains a word-affecting input without the signature following →
  silent staleness. Mitigation: signature module colocated with the provider; the signature comment
  enumerates the option fields; review checklist note on the provider's option type.
- **Startup double rebuild:** first drain with an empty store treats every checked path dirty → one
  extra coalesced full rebuild (~2.7-3.5 ms, idle) alongside the `"resolved"` build. Accepted;
  idempotent; guard against repeats via `populateSignatures()` in Step A4.9.
- **`lastKeystrokeAt` missed (starvation/never-idle):** hook must be the first statement of
  `onTrigger` (before every bail). Tests cover reschedule-then-fire.
- **Reverting the wrong debounce:** the 300 ms current-file debouncer (`:228-236`) is a **different**
  mechanism — untouched except the G6 event guard.
- **Ignoring the working-tree collision (D-4):** do NOT silently revert the uncommitted
  `LinkRank.ts` fallback; surface to the boss.
- **`resolve`-listener flood at startup** is the same O(vault) drain coalesced once — harmless.

---

## 4. Wave B — C1 chunked annotate (audit rows 3b; typing-path §7.3)

### Step B1 — `src/provider/InternalLinkWordProvider.ts`: resumable annotate
```ts
export type AnnotateBudget = { maxWordsPerSlice?: number };   // fallback 2000
createAnnotateIterator(
  currentFilePath: string | null, limitingFolder: string,
  rankData: LinkRankData, folderRankCache?: any,
  startFrom?: number,
): Iterator<void>   // yields after every slice; yields {done} only after the last word
```
- Refactor `annotateRankData` (`:224-259`) into a private generator `*annotateGenerator(...)` with
  **identical per-word body and order** (`:248-258` unchanged: `computeLinkRank` → stamp
  `fileTier/folderProximity/linkRank/_rankPrecomputed`); `annotateRankData` becomes
  `for (const _unused of this.annotateGenerator(...)) {}` (all existing callers/tests keep passing).
- `getList` + option assembly (`:232-246`) run ONCE before iteration (they are single cold-capable
  calls; `getRankData`/`getList` stay in the first slice — can't chunk without restructuring
  `LinkRankIndex.rebuild`, out of scope, they are already idle + rare).

### Step B2 — `AutoCompleteSuggest.ts` driver inside `scheduleFolderRankAnnotation`
- `annotate()` closure: `const it = this.internalLinkWordProvider.createAnnotateIterator(...)`;
  slice loop bounded by rIC `deadline.timeRemaining()` when available (rIC callback receives
  `IdleDeadline` — accept it in the callback signature) with the **timeRemaining > 2ms** guard and a
  fixed 2000-word fallback when `deadline` is absent (Node/Jest tests, `setTimeout` fallback).
- After each slice, if `!done && generation current && !unloaded` → re-arm rIC
  `{timeout: 4000}` (same escape hatch class as today's single rIC).
- Partial-stamp visibility is acceptable and MORE fresh than today (between refresh and idle-annotate
  all words are unstamped today; typing-path §3.3): unstamped words fall back to
  `computeLinkRank`'s documented branches; the generation guard drops superseded slices.
- Behavior preserved: same stamps, same order, same option assembly, same generation semantics
  (AGENTS.md "precomputed structures must be behavior-preserving" — cached score ≡ live score).

### Step B3 — annotate wiring test (the gap that hid the defect)
| File | Cases |
|---|---|
| extend `src/provider/InternalLinkWordProvider.test.ts` | iterator with `limitingFolder !== ""` produces byte-identical stamps vs `annotateRankData` (same order, same option); resume across manual `next()` yields (startFrom works); `annotateRankData` still runs to completion (back-compat); with `limitingFolder === ""` and no `_rankPrecomputed`, words are NOT stamped (Variant A pin for D-4) |

### Risks & simplification traps — Wave B
- **Chunking the wrong thing:** do not try to split `getRankData`/`getList` (single calls, ~12-30 ms
  cold when the version/limiting folder changed); only the 14k-word loop is resumable. Document this
  in the annotate comment so nobody "fixes" it by chunking the rebuild.
- **Timer churn:** re-arming per 2000-word slice ≈ 7 slices at 14k words — bounded, idle-time.
- **Deadline API absence:** always keep the `setTimeout(_, 0)` fallback (tests + Electron edge).

---

## 5. Wave C — T3 per-file patch (`wordsByPath`)

### Step C1 — `InternalLinkWordProvider` state
```ts
private wordsByPath = new Map<string, InternalLinkWord[]>();  // single source of truth per path
private lastOption?: <RefreshWordsOption>;                    // captured at refreshWords for patch derivation
```
- `refreshWords` fills `wordsByPath` while building (resolved words → `x.path`; phantoms → their
  source path — same objects as `this.words`); `clearWords()` clears it too.
- `words`/`wordsByFirstLetter` remain derived views (verification Q6's recommendation).

### Step C2 — patch mechanics (design §5.4, §6)
```ts
patchFiles(paths: Set<string>): void;   // coalesced drain entry (one call per scheduler fire)
private deriveWordsForPath(path: string): InternalLinkWord[];   // same buildWord code path as refreshWords
    // resolved: identical flatMap branch (aliases mode, suppress, ignorePrefix);
    // phantoms: searchPhantomLinks() filtered to this source path (full-map read is O(unresolved) ≈ µs, audit row 6)
private removeWords(words: InternalLinkWord[]): void;  // identity-based
    // words[]: this.words = this.words.filter(w => !identities.has(w))
    // buckets: for value.charAt(0) + every alias.charAt(0): filter by identity
    // includes duplicate-entry case (alias char === value char → two entries in one bucket)
private addWords(words: InternalLinkWord[]): void;     // exact same pushWord loops as :204-209
```
- **Transactional per design §6:** derive ALL new word arrays first (any throw → index untouched),
  then remove, then add. Preserves "never leave the index cleared/reduced if a build throws".
- **Patch ≡ full rebuild** guaranteed by construction: `deriveWordsForPath` is the *same function
  body* refactor of the flatMap, not a copy (extract `deriveWordsForEntries(entries: TFile[])`
  used by both refresh loop and patch).
- After patch, in limited-folder mode: call `scheduleFolderRankAnnotation` (Wave B path) so stamped
  ranks cover patched words (0.26 ms warm; cold only when the version actually bumped).
- `wordCount` updates naturally; `lastRefresh` (full rebuilds only) unchanged; `wordsByPath` deletion
  for emptied paths (delete/rename-out case: structure events use Tier 1 anyway — but a patch that
  empties a path sets `wordsByPath[path] = []`, delete the key).

### Step C3 — gate dispatch (D-5) + callers
- Gate gains `patchFiles` dep → `fire()` runs `patchFiles(dirtyPaths)` when `structureSet` is empty.
- `metadataCache "changed"` → `requestSignatureCheck(path)` (unchanged from Wave A); Wave C only
  changes what happens at fire time. Structure events and settings changes still go Tier 1.
- `AutoCompleteSuggest` passes `patchFiles` into `InternalLinkIndexGateDeps`.

### Wave C tests
| File | Cases |
|---|---|
| extend `src/provider/InternalLinkWordProvider.test.ts` | **property test:** full rebuild ≡ patch(50 random files) — compare `wordsByFirstLetter` as sorted bucket JSON + sorted `words[]`; alias-word removal from the alias bucket; phantom value changed by an unresolved-link edit on one source (other sources' phantoms untouched by the patch, cleaned by Tier-1 on structure events — asserted in gate test); duplicate first-char bucket (value and alias share the initial); `wordsByPath` in sync after patch; derivation throw → index untouched (transactional); `patchFiles` on empty set → no-op |
| extend `src/provider/internal-link-index-gate.test.ts` | fire with `patchFiles` dep calls patch not refreshFull for sig-driven dirt; refreshFull still chosen when a structure event is coalesced into the same window |

### Risks & simplification traps — Wave C
- **No bucket-removal precedent** (verification Q6: every provider writes buckets wholesale) — the
  identity-filter helper is genuinely new; the property test is the safety net. Do NOT dedupe
  buckets (no dedupe exists today, `pushWord :67-79`; adding one would change candidate counts).
- **Cross-path shared words:** none exist (every word is constructed per path in the flatMap;
  `createdPath` participates in identity, `suggestionUniqPredicate :57-63`) — removal by identity is
  unambiguous **only because `aliasMeta.origin` aliases are distinct objects**; do not share alias
  word objects across paths in the refactor.
- **Phantom coupling on create/rename/delete** (target appears → other files' phantoms die): handled
  by keeping Tier 1 for structure events (Assumption 5). Documented so nobody patches create events.
- **Memory claim honesty (AGENTS.md):** `wordsByPath` holds references + Map shells for 14k paths —
  measure retained heap delta in `bench/scenarios/memory.ts` (extend), do not guess.
- **Stale `lastOption` after settings change:** settings changes force Tier 1 which re-captures the
  option; patch between a settings edit and the forced rebuild cannot happen (the edit path rebuilds
  synchronously).

---

## 6. Final measurement step (AGENTS.md hard requirement)

**Before starting Wave A** (baseline already exists — `bench/results/latest.md`; re-run to confirm on
this machine before edits):
```
pnpm benchmark:bundle      # build the bench bundle
pnpm benchmark             # full run (21 iter); or `pnpm benchmark:quick` while iterating
```

**After each wave**, same commands plus a `git tag`-able record; write the artifact to
`research/performance-measurement-2026-10-28-lazy-gate-waves.md` citing per-scenario before/after
tables (no "feels faster"; every perf-sensitive merge needs numbers per AGENTS.md).

Baseline numbers to beat/verify (14k-file fixture, N=7 quick):
| Scenario | Before |
|---|---|
| refresh-internal-links warm | p50 2.644 / p95 7.308 ms (cold 3.660/4.625) |
| refresh-after-change save (fp on) | p50 3.494 / p95 4.674 ms (suggest+rank pass after a prose save) |
| folderrank structure bump | p50 10.892 ms (ensureSummary rescan) |
| session-sim 300 keystrokes | 540 ms total; 4 frames > 16.7 ms |

**New bench scenario required** — `bench/scenarios/refresh-gate.ts` (instantiates the framework-free
gate + scheduler + real provider; injected clock):
1. `gate: prose save (sig equal)` — one changed-event → `requestSignatureCheck` → force-fire:
   expect sig-diff-only cost (~µs-0.01 ms) and **zero** `refreshWords` calls (count them).
2. `gate: alias edit (sig changed)` — same flow with edited aliases: Wave A = one coalesced
   full rebuild (~current refresh cost); Wave C = one `patchFiles` (~0.05-0.2 ms).
3. `gate: scheduler tick cost` — the re-check loop's per-tick price (≤10 µs).

**Targets (from the boss's prompt + AGENTS.md):**
- After Wave A: **zero** word-index rebuilds on prose/link-traffic saves (event-path rebuilds
  ~5-17 ms per metadata change mid-typing → 0; measured as scenario 1 vs the pre-gate
  refresh-after-change/refresh-internal-links costs). Zero folder-summary work on link-only saves
  (G3: `folderrank` version-bump rescan disappears — verify with a scenario or the
  `refresh-after-change` BUMPED/unchanged note + `ensureSummary` call counts).
- After Wave C: residual rebuilds O(edited words) — alias-edit drain ≈ 0.05-0.2 ms instead of 2.7-3.5 ms.
- Wave B: annotate split so no single idle slice exceeds ~2-4 ms (report max slice ms).

---

## 7. Ordered build order for minion-builder

1. **Wave A in this order:** A3 signature module (+tests) → A1 scheduler (+tests) → A5 G3 (+tests)
   → A2 gate (+tests) → A4 wiring → A6 extract annotate-scheduling → **bench baseline re-run + gate
   scenarios + artifact.** Each step: `pnpm typecheck && pnpm test` (tsgo strict; jest colocated);
   `pnpm format` at the end (Prettier 2-space, Conventional Commits: `perf:` per repo history).
2. **Wave B:** B1 (+tests) → B2 → B3 → bench + artifact.
3. **Wave C:** C1 (+tests) → C2 (+property test) → C3 → extend memory scenario → bench + artifact.

## 8. Open questions (orchestrator)
1. **D-4 Variant A vs B** (default-config fileTier-only ranking): implemented plan assumes A;
   if the boss wants to keep the uncommitted default ranking, Wave A.6 changes (keeping stamping +
   leaf-change restamp) must be applied instead of A4.7's defaults no-op.
2. Whether `primeFolderSummaryIdle` should also fold into the gate's scheduler (currently rIC per
   call, ≤5 calls/event) — left as-is in Wave A; revisit only if the artifact shows timer churn.
3. Frontmatter provider's re-flatten per non-active metadata change (audit row 9, default off) —
   explicitly out of scope; same signature pattern later.
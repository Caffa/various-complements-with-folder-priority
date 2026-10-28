# Lazy-gate design: stop doing full vault recomputes (2026-10-28)

Builds on `research/typing-and-lazy-index-analysis-2026-10-28.md` (analysis) and
`research/lazy-gate-verification-notes.md` (code verification). Design only — no code yet.

## 0. TL;DR

- **Correction to the analysis doc (§4A):** "recompute when links change" is the **wrong
  predicate for the word index**. The internal-link word index does **not** read the file's own
  `resolvedLinks` at all (`InternalLinkWordProvider.ts:85-148`). A new `[[link]]` between two
  existing notes changes **zero words** — so today's full reindex produces an identical index.
  Only these change words: basename, aliases, unresolved names (phantoms), exclusion
  paths/tags, and settings.
- Therefore the gate is a **per-file word signature**, not a link diff. A new
  `[[existing Note]]` ⇒ signature unchanged ⇒ **nothing runs at all**.
- The correct scope for patching is **the file, not the folder** (§3): word identity is
  `(createdPath, value)`, buckets are keyed by first character, and phantom words are already
  per-source-file. Folder-scoping would help nothing; file-scoping makes every rebuild O(edited
  file).
- Sequencing: gates first (signature + dirty ledger + idle scheduler), chunked annotate second,
  per-file patch third (§8).

---

## 1. The core design: a dirty ledger with two gates

Replace the three independent event handlers' ad-hoc flows with **one scheduler** and a
**dirty set**, gated on (a) *words actually changed* and (b) *user idle*.

```
onTrigger            → lastKeystrokeAt = now                 (O(1), no work)

metadata "changed"   → (only at debounce FIRE, not in handler — see §5 resolve-lag note)
                         sig(wordSignatureOf(f))
                         if sig !== storedWordSig[f.path]:
                             storedWordSig[f.path] = sig
                             dirty.add(f.path)

vault create/delete  → dirty.add(path) + structureEpoch++
vault rename         → same (move words: old path → new path)
settings change      → fullRebuild() (index is settings-derived — keep, rare)
vault "modify"       → guard: skip unless f.path === active file; else re-tokenize
                        (save already happens ~2 s after typing pauses — Obsidian's
                        TextFileView.requestSave is a 2 s debounced save)

fire():                             // armed dirty set + check loop
  if (dirty empty) return
  idle  = now - lastKeystrokeAt ≥ 2000
  late  = now - firstDirtyAt ≥ 10_000          // maxWait — hard cap, no starvation
  if (!idle && !late) { setTimeout(fire, 2000); return }
  const work = drain(dirty)
  // Tier 3: per-file patch(work)  — O(edited words)
  // Tier 1: one coalesced full rebuild for all drained paths (never per-file loops)
  requestIdleCallback(chunked annotate, { timeout: 4000 })
```

Why this shape — each property answers a requirement:

| Requirement | Mechanism |
|---|---|
| "Not every save" | signature gate — prose/link-traffic saves diff equal |
| "No mid-typing debounces" | idle gate keyed on `lastKeystrokeAt`, not on event timing |
| "Can't starve" | `firstDirtyAt + 10 s` maxWait (Obsidian debounce has none — hand-rolled) |
| "Don't clear-then-rebuild visibly" | Tier 3 patches in place; Tier 1 rebuild stays synchronous-in-one-call (today's behavior already safe) |
| "Coalescing" | drain the whole dirty set once per fire — a bulk import of 500 files = one rebuild |
| Delta-aware invalidation (AGENTS.md) | version bump only where a value actually changed (unchanged rank-index logic) |

Obsidian's own save path already gives partial idleness: `vault "modify"` fires ~2 s after the
last keystroke (`TextFileView.requestSave` debounce), and `metadataCache "changed"` follows it.
So the 2000 ms idle gate mostly protects the *reschedule* path (rapid saves during bursts),
while maxWait bounds the worst case to ≤10 s staleness — same freshness bound class as today's
2.5 s rate limiter, but the work only runs when words actually changed.

---

## 2. Event → gate table (after the fix)

| Event | Today | After | Work when gate passes |
|---|---|---|---|
| metadata "changed", link between existing notes | full 14k reindex + annotate ~5–17 ms | **nothing** | 0 |
| metadata "changed", prose edit | full reindex | **nothing** | 0 |
| metadata "changed", alias added/edited | full reindex | dirty | patch aliases (Tier 3) |
| metadata "changed", new unresolved name (phantom) | full reindex | dirty | patch that file's phantoms (Tier 3) |
| file create/delete | full reindex | dirty | patch in/out |
| file rename | full reindex | dirty | move words (old path → new) |
| active-leaf-change | full reindex per switch | **dirty-only** | usually nothing |
| vault "modify" | re-tokenize active file, ignores its file arg | guard `f.path === active` | re-tokenize active file only |
| settings change | full rebuild | keep | full rebuild |

After Tier 3, the only remaining O(vault) scans are: startup `resolved` build (once),
settings-change rebuild, and — until Tier 3 lands — a coalesced rebuild when word-signatures
actually changed.

---

## 3. Why the **file**, not the folder (your folder question)

- Word index buckets are keyed by first **character**, contents are just `Word[]`; there is no
  folder partition to refresh. The natural remove/add unit is one file's word objects: every
  `Word` knows its `createdPath` ("createdPath", `suggester.ts:57-63`), alias entries are the
  same object in the alias's first-char bucket, and phantom words are already per-source-file
  (`InternalLinkWordProvider.ts:153-164`).
- So "recompute just the set of folders" would still iterate everything unless it went down to
  per-file — at which point the folder layer disappears entirely.
- The only true folder artifacts are (a) `ensureSummary` — and it consumes **paths only**, no
  link data at all (`FolderRankCache.ts:152-194`), so it is gated by `structureEpoch` alone
  (fix G3 below, verified consequence-free: the `qualifications[].version` field is dead,
  `:192`, read `?.qualified` only `:90-91`); and (b) `getList`, correct to key on rank version,
  which only bumps on a real contribution change and only when `limitingFolder !== ""`.

---

## 4. Fix list — every audit item mapped (fills the gap you asked about)

The previous ranked table (§5 of the analysis) omitted two audit rows; here is the complete
map. "Why the little things": items 7–9 are constant-factor cuts on the hottest path (every
keystroke) or dead-work removals — individually ~0.1–1 ms, nearly free while touching the file,
never behavior-changing. They rank last on purpose.

| Audit row | Fix | Tier |
|---|---|---|
| 1. ungated full word reindex | **G1** word-signature gate + dirty ledger | 1 |
| 2. rate limiter / no maxWait / mid-typing | **G2** idle scheduler (2000 ms + 10 s maxWait) | 1 |
| 3. `ensureSummary` version leak | **G3** memo on `structureEpoch` only | 1 |
| 5. dead `fileTier` precompute / inert ordering | **G4** remove stamping; compute transiently only when `limitingFolder !== ""` (needs product decision) | 1 |
| 6. `active-leaf-change` full reindex per switch | **G5** dirty-only | 1 |
| 8. full re-tokenize per save (+ wrong file arg) | **G6** file-guard + fold into scheduler | 1 |
| 3b. annotate as one unchunked long task | **C1** chunk the annotate loop (generator + rIC) | 2 |
| 7. keystroke constants (per-candidate `toLowerCase()`, `linkRanks` rebuild, double `getOrComputeLinkRank`, unmatchable phrase-query scans) | **K1** lowercase shadow values at refresh, dedupe phrase queries, single rank lookup, persist linkRanks across passes | 3 |
| 9. small stuff (eager debug strings, `querySelector("body")` per keystroke, partial-mode flatten) | **K2** lazy debug strings, cache body ref, defer partial-mode flatten (non-default) | 3 |
| — beyond the audit: rebuild still O(vault) | **T3** per-file patch via `wordsByPath` | 3 |
| — beyond the audit: frontmatter provider re-flattens on every non-active metadata change (default off) | same signature-gate pattern when enabled | later |

Coverage answer: **yes, G1–G6 + C1 cover all nine audit rows**; K1/K2 + T3 are the optional
constant-factor and structural layers. The rank index needs no new gate — it is already
delta-aware (0.014 ms/save, 0/20 bumps on prose saves).

---

## 5. Design details that verification forced

1. **Diff at fire time, not in the event handler.** `metadataCache "changed"` gives
   `(file, data, cache)`, but resolution lags indexing ("sometimes after a file has been
   indexed" — `obsidian.d.ts:4108-4112`): an in-handler diff can read pre-resolution
   `resolvedLinks` and mis-judge. The scheduler compares signatures when it runs.
2. **Signature spec** (per file, ~O(1) to store/compare):
   `fnv(path ‖ basename ‖ aliases(join) ‖ excluded ‖ tags(join) ‖ unresolvedNames(join)) ‖ settingsSig`.
   Note unresolved names stay **case-sensitive raw** (the word index keeps raw case; only
   `LinkRankIndex` lowercases — `InternalLinkWordProvider.ts:153-164` vs
   `LinkRankIndex.ts:367-404`). `settingsSig` is global because settings (alias-as-word,
   suppress-basename, ignore-prefixes, synonyms, exclusion globs) change words without any file
   changing. 14k entries ≈ tens of KB — acceptable; skip storage for files matching
   ignore-prefixes.
3. **`markSourceStale`-boolean idea is dropped for the word index.** Its snapshot only exists
   in-limiting-folder mode and lowercases unresolved names — right oracle for rank, wrong one
   for words. Word-signature state is new but tiny and purpose-built.
4. **Per-file patch is well-defined here** (unlike the frontmatter provider, where per-path
   removal is ambiguous): remove by identity from `value.charAt(0)` + every `alias.charAt(0)`
   bucket (O(bucket) ≈ tens of µs per touched bucket) and from `words[]` (feeds
   `annotateRankData`, `:248`). No precedent exists in-repo for bucket removal → new helper +
   tests.
5. **`fileTier` as stored per-Word is unfixable as-is**: it means "target is linked from the
   *active* file", so it changes on every note switch — per-file static stamping is wrong by
   construction. Either compute it as an annotate-time transient when a limiting folder is set,
   or drop the feature flag's cost entirely until someone configures it.

---

## 6. Correctness properties the build must preserve

- Never leave the index cleared if a rebuild throws (today's behavior: `lastRefresh` untouched
  on throw, `:217-221`) — patch path must be transactional per file (remove-then-add in one
  call).
- Cached-vs-live equivalence: a patched word must be byte-identical to what a full rebuild
  would produce (same synonyms/transforms at same settingsSig).
- No O(vault) work in `onTrigger`/`getSuggestions` under any of the new paths; scheduler work
  is idle-gated or capped.
- The `structureEpoch` bump remains for create/delete/rename so folder structures stay fresh
  even when the word patch is a no-op for folders.

---

## 7. Test plan

- `WordSignature`: alias add/remove, basename change (via rename), unresolved add (new note
  name), phantom resolution (unresolved shrinks), tags/paths exclusion toggle, settingsSig
  bump → dirty; prose edit + link-between-existing → not dirty.
- Scheduler: idle-reschedule (keystroke at t, check at t+1.5s re-arms), maxWait forces at 10s,
  drain-coalescing (500 dirty paths → one rebuild), empty-dirty no-op.
- `FolderRankCache`: link-version bump does **not** rescan; structure change does.
- Patch mechanics vs full rebuild: property test — patch(50 random files) ≡ full rebuild (same
  buckets as JSON).
- Wiring: annotate path actually runs with `limitingFolder !== ""` (the currently uncovered gap
  that let the dead-wiring defect survive).

---

## 8. Sequencing

1. **Wave A (gates)** — G3 (1 line), G6 guard (1 line), G1 signature+ledger (~40–60 lines),
   G2 scheduler (~30–50 lines), G5 dirty-only leaf-change, G4 stamping removal (pending the
   product decision on inert folder ordering). Biggest win: ~all recurring event-path waste
   gone.
2. **Wave B** — C1 chunked annotate.
3. **Wave C** — T3 `wordsByPath` per-file patch (makes the residual rebuilds O(edited file);
   becomes attractive once Wave A shows remaining rebuild frequency).
4. **Wave D (optional)** — K1/K2 keystroke constant factors.

After Wave A alone, the measured steady state while typing prose + completing links to existing
notes should be: zero word-index work, zero folder-summary work, re-tokenize once per save,
annotate gone. That is the honest end-state of the analysis doc's §5 items 1–3.
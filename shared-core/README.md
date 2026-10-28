# Shared link-core: do we need one?

**Short answer: no plugin, no mandatory dependency.** There is exactly **one**
expensive derived structure in this pair of plugins (`Various Complements`'
folder-level link inversion), and the *other* plugin does not want it. So there is
nothing to de-duplicate today.

What is worth doing: **optional, versioned runtime APIs** — Link Colorer exposes
"color for this link", Various Complements optionally consumes it; Various
Complements exposes a stable ordering snapshot, Link Colorer may ignore it.
Optionally, a **pure-utility npm package** later, if real shared logic appears.

Ship preference: **C (optional runtime API) now; B (shared library) only for
pure, non-trivial helpers; not A (separate core plugin).**

---

## 1. What actually gets recomputed

| Data | Who owns it | Cost | Rebuilt by |
| --- | --- | --- | --- |
| `resolvedLinks` / `unresolvedLinks` (source → target → count) | **Obsidian** `metadataCache` | incremental, per changed file | Obsidian core |
| Folder-level inversion (target → source folder → count) | `src/storage/LinkRankIndex.ts:168` | **21.2 ms** median full rebuild at 12k files / 65,624 edges (`research/performance-measurement-2026-10-28.md`); ~8.2 MB | Various Complements, lazily, per `limitingFolder` |
| Per-file targets (`currentFileTargets`) | `LinkRankIndex.rebuildFilePart` (`:454`) | O(links of one file) | Various Complements, on file switch |
| Ranked list for one leaf folder | `src/storage/FolderRankCache.ts` | **36.7 ms** cold (10.8 ms summary + 25.5 ms list), ~0.076 ms warm hit/pass; 510 B/entry measured, up to ~166 MB working set | Various Complements, memoized per `(folder, LinkRankIndex.currentVersion)` (`:102-113`) |
| Internal-link completion words (basename + aliases) | `src/provider/InternalLinkWordProvider.ts:55` | 10.6–11.0 ms cold `refreshWords` at 12k files | Various Complements, debounced 1000 ms |
| Link text → color | Link Colorer (`k`, `x`, `L` module caches) | O(1) hash + LRU; ≤3,500 keys (medium tier) | Link Colorer, on demand per rendered link |
| Vault file count | `vault.getMarkdownFiles().length` | ~10 ms at 12k files | Link Colorer **once** in `onload` (size tiering); Various Complements on reindex |

Two conclusions follow directly from that table.

**Obsidian already shares the expensive part.** Both plugins sit on
`app.metadataCache`. It is maintained by core, incrementally, at zero cost to
either plugin. Nobody re-parses vault files to build a link graph. A "link core"
plugin would therefore have nothing to *compute* that is not already computed —
it could only *relocate* an existing computation.

**The one heavy derived structure has exactly one owner and no second customer.**
`LinkRankIndex` is used by the completion comparator
(`src/ui/AutoCompleteSuggest.ts:675`), memoized and delta-aware
(`LinkRankIndex.ts:105-148`, `:339-360`). Link Colorer never reads link
frequencies; it hashes text. So the potential saving from centralising it is
**0 ms and 0 MB today**.

## 2. What "do we need multiple recomputes?" means here

Three questions, three answers:

1. **Is anything computed twice, by two plugins?** No. The only overlap is a
   ~5-line `getParentFolder`/`normalizeFolderPath` pair
   (`src/model/FolderProximity.ts:131-148`), which is cheaper to copy than to
   dependency-manage.
2. **Would a third plugin create duplication?** Possibly — *only if* it needs
   frequency-weighted link ordering. Anything that needs "what links to this and
   how often" must rebuild the inversion, because Obsidian exposes the graph in
   `source → target` form, which is the wrong direction for ranking.
3. **Is per-plugin recompute a problem even without sharing?** No, because each
   plugin's compute is lazy and guarded: Link Colorer's only vault-wide call is
   `.length` on load; Various Complements' scans are debounced and, since commit
   `8a53ba0`, delta-aware (unchanged links no longer bump the version, which is
   what turned a 36.7 ms cold cache rebuild per auto-save into ~0).

## 3. Why not a mandatory core plugin (option A)

Obsidian has no dependency declaration, no auto-install, and no plugin-load
ordering guarantee. A "core" plugin therefore does not remove coordination — it
moves it into install instructions and still forces every consumer to handle
"core not loaded yet". Concretely:

| Concern | What a core plugin costs |
| --- | --- |
| Install burden | Every user must install and enable **3** plugins instead of 2; the feature silently disappears if they skip the third. Community plugin review + release pipeline ×1 more repo. |
| Lifecycle | Indices must be built, invalidated, and torn down in one place. If the core is disabled mid-session, *both* features degrade at once instead of each degrading alone. |
| Load order | Still not guaranteed. Consumers still need `workspace.onLayoutReady` + retry, so option A does not delete a single line of the coordination code — it adds a dependency check on top of it. |
| Version skew | A 2-way matrix (VC × LC) becomes 3-way (core × VC × LC), and the core must be backward-compatible with every consumer version users happen to have. |
| Blast radius | A crash or slow build in the core takes down suggestions *and* coloring. Today a bug in one plugin is one plugin's problem. |
| Memory | One shared index means one shared cap and one owner of the eviction policy. The measured worst case (up to ~166 MB of folder lists, projected ~518 MB at the 512-list cap) becomes a cross-plugin budget debate instead of a per-plugin tuning knob. |
| Measured benefit | None available. Nothing is duplicated, so there is no ms or MB to win. |
| Mobile | `app.plugins.plugins` is reachable on mobile, so option C works there; option A adds an install step on the platform where installing is most annoying. |

The only thing option A genuinely buys is a single *definition* of "link rank".
That is a correctness/design argument, not a performance one, and it does not
require a plugin: it requires one implementation plus optional APIs (§5).

## 4. The three options, compared

Scoring: ✅ good, ⚠️ acceptable, ❌ poor.

| Criterion | **A. Separate core plugin** | **B. npm library bundled per plugin** | **C. Optional runtime API** |
| --- | --- | --- | --- |
| Install burden | ❌ 3 plugins, hard dependency | ✅ none | ✅ none |
| Load-order coupling | ❌ must be loaded first | ✅ none (build time) | ⚠️ detect at use + retry |
| Version skew surface | ❌ 3-way | ✅ semver at build time | ⚠️ integer contract version at runtime |
| Blast radius | ❌ shared | ✅ isolated | ✅ isolated |
| Works when peer absent | ❌ core is mandatory | ✅ | ✅ fallback = today's behaviour |
| Ships stateful data (indices) | ✅ | ❌ (bundled copy = duplicate state) | ✅ single owner, read-only views |
| Static type safety | ⚠️ via detection only | ✅ compile-time | ⚠️ duck-typed, runtime-checked |
| Dev/release cost | ❌ new repo, release, review | ⚠️ publish + semver discipline | ✅ ~30 lines each side |
| Benefit *today* | none | none (nothing worth sharing yet) | removes a visible colour mismatch |
| Verdict | **rejected** | **accepted for pure helpers only** | **accepted** |

Why B cannot carry state: Obsidian plugins bundle all their code, so an npm
"shared" package is *duplicated bytes and duplicated state at runtime*. That is
fine for pure functions (one source of truth for logic and tests) and wrong for
indices (two caches, two invalidation policies, two memory footprints).

## 5. Concrete opportunities, ranked

### 5.1 Link Colorer exposes colour per link → Various Complements colours its suggestions (highest value)

Today a user sees the same link in two colours on one screen: coloured in the
editor, theme-default in the completion popup. Fixing that needs no new index
and no shared state — just a getter.

**Blocker found in Link Colorer 2.0.8** (bundled `main.js`, verified): the three
advertised functions are **module-level exports**
(`module.exports = { getTextColorMap, getColorUsageMap, getLinkPaletteIndexMap }`),
bound to module-scope caches. The **plugin instance** exposes only
`getLinkColorMap()` and `getColorUsageStats()`, and every one of those maps is
keyed by an *internal composite key*, not by link text or target path:

```
"vibrant-dark-r0-5381-70-90-60-75-random-chapter|t1"
  palette  theme  css-change  seed  ranges  mode  normalized text
```

So a consumer cannot answer "what colour is `Chapter - T1`?" without either
re-implementing the hash or string-parsing the key tail. Both are fragile.
This is the single API gap worth closing: Link Colorer should add

```ts
getColorForLinkText(text: string): string | undefined;
getTargetColorMap(): ReadonlyMap<string, string>; // target path or lowercased name → colour
getVersion(): LinkCoreVersion;
```

`shared-core/types.ts` already declares them as optional extensions and
`example-consumer.ts` implements all three resolution paths with graceful
degradation.

### 5.2 Various Complements exposes internal-link words + rank snapshot → Link Colorer may reuse (low value, cheap to offer)

VC owns the only expensive structures, so it is the natural provider. A
`RankSnapshot` would let Link Colorer order its "Links by colour" table by story
proximity, or make `folder-based colour consistency` use real link structure
instead of folder path. Neither is requested today; the value is speculative.
Cost of exposing it read-only: one object literal in `onload` (~30 lines,
lazy getters, no new scans). Worth publishing *because it is nearly free*, not
because it is needed.

### 5.3 Shared pure utilities (defer)

Candidates: `getParentFolder`, `normalizeFolderPath`, `isWithinFolder`
(5 lines each, currently copied in `src/model/FolderProximity.ts:131-148`).
Not worth a package. Revisit only if a third consumer needs non-trivial shared
logic — e.g. folder-proximity scoring, or phonetic normalization
(Link Colorer already carries a `phonetic-ipa` implementation; VC carries
`synonymAliases` accent/emoji normalization).

### 5.4 What not to share

- **`LinkRankData` itself.** It holds live `Map`s owned by `LinkRankIndex`; sharing
  it shares mutation and lifecycle. Share flattened, immutable snapshots.
- **The colour caches.** ~3,500 LRU entries of presentation state. Two plugins
  reading one another's LRU means one plugin's eviction becomes the other's cache
  miss.
- **Any vault-wide event hook.** A core that listens to `metadataCache` "changed"
  on both plugins' behalf would double the per-save wakeups it was meant to save.
  See the perf guardrails in `AGENTS.md`.

## 6. Lifecycle for the recommended shape

1. **Producer** builds its API handle in `onload` (after its own index objects
   exist), attaches it as `plugin.linkCoreApi`, and never populates an index
   eagerly. Every getter is allowed to lazily build on first call.
2. **Consumer** does not detect in `onload`. It detects at *first use*
   (`workspace.onLayoutReady` at the earliest), caches the handle, and retries a
   bounded number of times (3 × 250–500 ms) to cover a slow peer enable.
3. **Version gate**: integer `api` in `LinkCoreVersion`. Provider older than
   `LINK_CORE_MIN_SUPPORTED_API` or newer than `LINK_CORE_API_VERSION` → reject
   and fall back. Never parse the provider's semver for control flow.
4. **Fallback** is the current behaviour. No API, no error, no notice, no log
   spam — one debug line at most.
5. **Teardown**: consumer calls `dispose()` on *its* handle (unsubscribe only);
   the handle must not outlive the provider. Cached handles are re-detected after
   any provider failure, and detection is cheap enough (one property read plus
   `typeof` checks) to redo per pass if in doubt.

## 7. Files here

| File | Purpose |
| --- | --- |
| `types.ts` | Contract + `detectOptionalApis`. No `obsidian` import, no app wiring. |
| `example-consumer.ts` | Feature-detected colour lookup and rank ordering; shows every degradation path. |
| `INTEGRATION.md` | Integration sketches, retry pattern, risk table. |
| `DECISION.md` | What was accepted/rejected, and what would change our mind. |
| `tsconfig.json` | Typecheck scope for this directory (the app's `tsconfig.json` includes only `src/`, by design — commit `dc99c93`). |

Verification (the repo's `pnpm typecheck` is scoped to `src/` and stays green
without touching this directory):

```sh
pnpm exec tsgo -p shared-core/tsconfig.json   # strict, no emit, must exit 0
pnpm exec prettier --check shared-core
```

Nothing here is imported by `src/`; adopting it is an explicit later step.

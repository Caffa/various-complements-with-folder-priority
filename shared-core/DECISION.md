# Decision record: shared link-core

**Date:** 2026-10-28
**Status:** accepted (design + type scaffold only; nothing wired into `src/`)
**Scope:** `various-complements-with-folder-priority` (VC) and `link-colorer` (LC)

---

## Context

Two plugins in the same vault both deal with links:

- VC reads `metadataCache.resolvedLinks` / `unresolvedLinks` and derives the
  folder-level inversion used by folder-priority completion ranking
  (`src/storage/LinkRankIndex.ts:168`, 21.2 ms full rebuild at 12k files /
  65,624 edges, ~8.2 MB resident; scoped per-leaf-folder ranked lists another
  ~166 MB at a 164-folder working set, 510 B/entry measured).
- LC maintains no link graph at all. It hashes normalized link text into a
  palette index and caches text → colour (≤3,500 LRU entries), calling
  `vault.getMarkdownFiles()` exactly once, for `.length`, on load.

The question was whether the pair should share a "link core", and in what form.

## Decision

**Accepted: option C — optional, versioned runtime APIs.** Each plugin stays
independently installable and independently useful. Sharing happens through a
namespaced handle on the plugin instance (`plugin.linkCoreApi`), detected at
first use via `detectOptionalApis`, gated by an integer contract version, with
the current behaviour as the fallback.

**Accepted for pure helpers only: option B — a small npm package**, if and only
if non-trivial shared logic appears (folder-proximity scoring, phonetic
normalization). Not for state: Obsidian bundles each plugin, so a "shared"
package that holds caches yields two caches and two invalidation policies.
Today the only shared logic is `getParentFolder`/`normalizeFolderPath`/
`isWithinFolder`, ~5 lines each; copying is cheaper than publishing.

**Rejected: option A — a separate core plugin.** No dependency mechanism, no load
ordering, no auto-install, so it adds an install step and *still* requires the
same optional detection. It also concentrates blast radius (one crash takes down
suggestions and colouring), multiplies the version matrix (2-way → 3-way), and
buys zero measured performance, because nothing is duplicated today.

**Rejected: sharing live index objects** (`LinkRankData`, `FolderRankCache`
lists). That shares mutation and lifecycle, not just data. Snapshots only.

## Why the benefit is real but small

| Item | Measured / estimated | Source |
| --- | --- | --- |
| Duplicated link-graph work | **0 ms** | LC has no graph index; VC reads `metadataCache` (already shared by Obsidian) |
| Duplicated inversion-index memory | **0 MB** today | one owner (`LinkRankIndex`), no second reader |
| Saved by centralising the inversion | **0 ms / 0 MB** | nothing to remove |
| Cost of a core plugin | +1 install/enable step for every user; +1 release pipeline; 3-way version matrix | not measurable in ms, but it is pure overhead |
| Benefit of C for the user | same link no longer shows **two colours** on one screen (editor vs completion popup) | §below |
| Cost of C | ~30 lines per side; one duck-type check per suggestion pass; no keystroke-path scan | — |

The honest summary: the *performance* case for sharing is zero, the
*consistency* case is real and cheap. That is why the answer is a runtime API and
not a plugin.

## The one blocker that must be closed first

LC 2.0.8 exposes colour maps keyed by an internal composite key
(`palette-theme-r{cssChange}-{seed}-{ranges}-random-{text}`), not by link text or
target path. Its three advertised functions are `module.exports` bindings, which
Obsidian does not hand to other plugins. So VC cannot ask "what colour is
`Chapter - T1`?" without re-implementing the hash or string-parsing the key tail.

Until LC ships `getColorForLinkText(text)` (and optionally
`getTargetColorMap()` + `getVersion()`), the bridge is a heuristic. The heuristic
is implemented in `example-consumer.ts` and documented as fallback-only.

## What would justify a real core plugin (option A)

Any one of these, with numbers:

1. **A third consumer of the inversion.** If a third plugin needs
   frequency-weighted link ordering, the inversion is derived twice — 8.2 MB and
   ~21 ms duplicated, and worse, two definitions of "how often is this linked".
2. **LC adds frequency-weighted colouring** (e.g. "hot" links get hotter colours).
   Then LC must build the inversion itself, and centralising saves a full
   measured copy of it.
3. **A shared memory budget that is actually exceeded.** If combined plugin
   residency crosses a stated ceiling (e.g. >100 MB attributable to link indices)
   and per-plugin tuning cannot bring it down, one owner of the cap becomes worth
   the install cost.
4. **A shared UI surface** (e.g. one settings panel for both), which optional APIs
   cannot express.
5. **The optional-API maintenance cost exceeds the coupling cost** — i.e. two
   duck-typing layers and two retry loops become harder to keep correct than one
   plugin. Not the case at 2 plugins.

Absent one of these, a core plugin is negative value.

## Next experiment (concrete, falsifiable)

1. **LC 2.x minor**: add `getColorForLinkText(text)`, `getColorRevision()`,
   `getVersion()`, and a `LINK_COLOR_API_VERSION` constant. No behaviour change;
   existing maps untouched.
2. **VC minor**: read it behind an off-by-default setting
   `colorizeInternalLinkSuggestions`, detected at first use with
   `onLayoutReady` + ≤3 retries.
3. **Measure** (this is the gate, not a vibe check):
   - *Correctness*: sample 50 internal links in the novel vault; suggestion
     colour must equal the rendered `a.internal-link` colour for **all 50**
     (aliases, prefix-ignored names, and unresolved links included). Today's
     heuristic path is expected to miss aliases — that miss is the reason for step 1.
   - *Keystroke cost*: added cost per suggestion pass with the peer present must
     stay **< 0.1 ms** (build the text→colour map once per pass, ≤3,500 entries;
     cite the measurement, not a feeling).
   - *Cold start*: enabling the peer mid-session must take effect without a
     restart, and disabling it must not leave stale colours.
   - *Load order*: all three orders (VC first, LC first, both at once) behave
     identically.
4. **Kill criterion**: if step 1 is rejected upstream and the heuristic misses
   more than ~10 % of sampled links, keep the feature off by default and keep
   `shared-core` as documentation only.

## Consequences

- No change to `package.json`, `src/`, `bench/`, or `tsconfig.json` (the app's
  `tsconfig.json` keeps `include: ["src/**/*.ts"]` per commit `dc99c93`; this
  directory carries its own `tsconfig.json` instead).
- `shared-core/` is dead code until adopted. It must not be imported from `src/`
  without the experiment above.
- Verification commands:
  `pnpm exec tsgo -p shared-core/tsconfig.json` (exit 0) and
  `pnpm exec prettier --check shared-core`.

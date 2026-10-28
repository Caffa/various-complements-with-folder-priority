# Integration sketches

Both directions are **optional at runtime**. Neither plugin may fail to load, log
an error, or change behaviour when the other is missing, disabled, too old, or
unloaded mid-session.

The contract lives in `types.ts`. Everything below is a sketch of calls, not code
to paste into `src/`.

---

## 0. Conventions

| Item | Value |
| --- | --- |
| Provider handle | `plugin.linkCoreApi` (`LINK_CORE_API_KEY`) |
| Provider ids probed | `various-complements-with-folder-priority`, then `various-complements` |
| Contract version | integer `LinkCoreVersion.api`, gate against `LINK_CORE_MIN_SUPPORTED_API … LINK_CORE_API_VERSION` |
| Detection | `detectOptionalApis(app)` — pure read of `app.plugins?.plugins`, never throws, never builds an index |
| Detection timing | first use only (≥ `workspace.onLayoutReady`), never in `onload` |
| Missing peer | current behaviour, silently |

`app.plugins` is not in Obsidian's public typings, which is why `types.ts` takes
`unknown` and duck-types. Do not add `app.plugins` to any `App` cast that the rest
of the code depends on; keep the cast inside the detection helper.

---

## 1. Various Complements as **provider**

### 1.1 Where the handle lives

Build the object in `onload`, after `this.suggester` exists
(`src/main.ts`, right after `this.registerEditorSuggest(this.suggester)`). Every
getter stays lazy: `LinkRankIndex` and `FolderRankCache` already build on demand,
so the handle must not call them.

```ts
// sketch — src/main.ts (do not apply yet)
import {
  LINK_CORE_API_VERSION,
  type LinkCoreSnapshot,
  type LinkCoreService,
  type RankSnapshot,
} from "../shared-core/types";

private buildLinkCoreApi(): LinkCoreService {
  const listeners = new Set<(s: LinkCoreSnapshot) => void>();
  const version = { api: LINK_CORE_API_VERSION, plugin: this.manifest.version };

  const snapshot = (): LinkCoreSnapshot => {
    const index = this.suggester.linkRankIndex;
    return {
      version,
      revision: index.currentVersion,
      builtAt: this.linkCoreBuiltAt ?? 0,
      fileCount: this.app.vault.getMarkdownFiles().length, // ← see §1.4
      resolvedLinkCount: 0, // omit or memoize; must not rescan per call
      unresolvedLinkCount: 0,
      buildMs: index.lastBuildMs,
    };
  };

  const api: LinkCoreService = {
    id: this.manifest.id,
    getVersion: () => version,
    getSnapshot: snapshot,
    getInternalLinkWords: () =>
      this.suggester.internalLinkWordProvider.toSnapshots(), // new, ~6 lines
    getRankData: (filePath, limitingFolder) =>
      this.suggester.buildRankSnapshot(filePath, limitingFolder),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => listeners.clear(),
  };
  this.linkCoreApi = api;
  return api;
}
```

### 1.2 `RankSnapshot` from data VC already has

```ts
// sketch — flatten LinkRankData + FolderRankList; no new computation
buildRankSnapshot(filePath: string | null, limitingFolder: string): RankSnapshot {
  const rankData = this.linkRankIndex.getRankData(filePath, limitingFolder);
  const list =
    filePath === null || limitingFolder === ""
      ? undefined
      : this.folderRankCache.getList(filePath, limitingFolder, rankData);

  const entries: RankEntrySnapshot[] = [];
  const push = (kind: "resolved" | "unresolved", scores: Map<string, FolderRankScoreEntry> | undefined) => {
    if (!scores) return;
    for (const [key, e] of scores) {
      entries.push({ kind, key, level: e.level, frequency: e.frequency, score: e.score, rank: e.rank });
    }
  };
  push("resolved", list?.resolvedScores);
  push("unresolved", list?.unresolvedScores);
  entries.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.score - a.score);

  return {
    revision: this.linkRankIndex.currentVersion,
    filePath,
    limitingFolder,
    fileTargets: [...rankData.currentFileTargets.keys()],
    fileUnresolvedKeys: [...rankData.currentFileUnresolvedNames.keys()],
    entries,
    // MAX_LIST_SIZE is 500 in FolderRankCache; true when the list may be clipped.
    truncated: (list?.resolvedScores.size ?? 0) + (list?.unresolvedScores.size ?? 0) >= 500,
  };
}
```

Notes:

- `rank` restarts at 1 for resolved and for unresolved entries. They are separate
  orderings; consumers must key lookups by `(kind, key)`, not by `rank` alone.
- `getList` is memoized on `(folder, rankIndex.currentVersion)`
  (`FolderRankCache.ts:102-113`), so repeated calls in one suggestion pass are
  map hits. Calling it from a full-CSV consumer on a foreign thread of execution
  would be the only new cost, and it is bounded by 1 build per (folder, revision).
- A file outside `limitingFolder` yields `entries: []`, which is the correct
  "no opinion" answer.

### 1.3 `subscribe` must not add wakeups

The whole point of commit `8a53ba0` was to stop paying ~36.7 ms per auto-save.
An emit per `metadataCache` "changed" would reintroduce a wakeup per save for
every subscriber.

```ts
// sketch — coalesce, and only emit when the measured data changed
this.registerEvent(
  this.app.metadataCache.on("changed", () => {
    this.debouncedLinkCoreEmit(); // debounce(300, false) with maxWait
  }),
);

debouncedLinkCoreEmit = debounce(
  () => {
    const revision = this.linkRankIndex.currentVersion; // -1 until first build
    if (revision < 0 || revision === this.lastEmittedRevision) {
      return; // nothing observable changed
    }
    this.lastEmittedRevision = revision;
    const s = this.linkCoreApi!.getSnapshot();
    for (const l of listeners) {
      try {
        l(s);
      } catch {
        // a consumer's bug must not break the provider
      }
    }
  },
  300,
  true,
);
```

### 1.4 Cost rules for provider getters

| Getter | Allowed to do | Must not do |
| --- | --- | --- |
| `getVersion` | return a cached literal | touch vault/metadataCache |
| `getSnapshot` | return cached counters | `vault.getMarkdownFiles()` per call (~10 ms at 12k files) |
| `getInternalLinkWords` | iterate the existing word list | re-run `refreshWords` |
| `getRankData` | reuse `getRankData` + memoized `getList` | full rescan, or a fresh `FolderRankCache` |

If a counter is not already maintained, **omit it** (`resolvedLinkCount: 0` is
better than a per-call scan). `LinkCoreSnapshot` is diagnostics; no consumer may
branch on it.

---

## 2. Various Complements as **consumer** of Link Colorer

```ts
// sketch — colour internal-link suggestion rows to match the editor
import { detectOptionalApis, type SuggestionColorHint } from "../shared-core/types";
import { resolveSuggestionColors } from "../shared-core/example-consumer";

// once per suggestion pass, at the point where words are judged
const hints: readonly SuggestionColorHint[] = this.settings
  .colorizeInternalLinkSuggestions
  ? resolveSuggestionColors(this.app, internalLinkWords)
  : [];
```

Where it plugs in: `src/provider/suggester.ts` builds suggestion rows; a hint is
`value → css colour`. Render with an inline `color` style (Link Colorer itself
uses `!important` inline styles, so plain class-level CSS will lose specificity).

Rules:

- **No new work on a miss.** `detectOptionalApis` is one property read plus
  `typeof` checks; `resolveSuggestionColors` returns `[]` immediately when the
  peer is absent. On a hit, the colour map copy is bounded by 3,500 entries —
  build it once per pass, not per row, and do not retain it across passes.
- **Do not cache colours indefinitely.** Link Colorer changes colours on
  re-roll, on theme change (`css-change` clears its caches), and on unload. A
  stale colour is worse than no colour.
- **Filter by theme.** The cache key embeds `dark`/`light`, so a vault viewed in
  both themes has two entries per text; inject
  `document.body.classList.contains("theme-dark")` into the lookup.
- Wrap the whole call in a setting (default **off** until §2 works end to end).

---

## 3. Link Colorer as **provider** (the missing primitive)

What Link Colorer needs to add (2.x minor), and why each piece:

```ts
// sketch — link-colorer/plugin
import { LINK_COLORER_API_VERSION, type LinkCoreVersion } from "shared-core/types";

getVersion(): LinkCoreVersion {
  return { api: LINK_COLORER_API_VERSION, plugin: this.manifest.version };
}

/** The primitive a consumer actually needs. Colour is a function of text. */
getColorForLinkText(text: string): string | undefined {
  return this.getColorFor(text, this.settings, isDarkTheme()); // existing He()
}

/** Optional, cache it: resolving ~3.5k texts to paths is not free. */
getTargetColorMap(): ReadonlyMap<string, string> {
  // for each distinct text in the colour cache: app.metadataCache
  //   .getFirstLinkpathDest(text, "") → path; keep first colour per path
}

/** Optional but strongly recommended: lets consumers drop stale colours. */
getColorRevision(): number { return this.colorRevision; } // bump in resetColorState/reroll/css-change
```

Why `getColorForLinkText` and not a target map first: Link Colorer only ever sees
*rendered text*, never target paths. Building `target → colour` requires
`getFirstLinkpathDest` per distinct text. That is fine once per revision and bad
per call, so it is the optional one.

What must **not** change: the module-level exports
(`getTextColorMap` / `getColorUsageMap` / `getLinkPaletteIndexMap`) stay for the
stats modal; the instance methods (`getLinkColorMap`, `getColorUsageStats`) stay
for compatibility with anything already reading them. New API goes *next to*
them, versioned.

---

## 4. Link Colorer as **consumer** of the rank snapshot

```ts
// sketch — order the collision table / pick priority colours by story proximity
import { detectOptionalApis } from "shared-core/types";
import { orderInternalLinkWords } from "shared-core/example-consumer";

const { linkCore } = detectOptionalApis(this.app);
const ordered = linkCore
  ? orderInternalLinkWords(this.app, activeFilePath, limitingFolder, words)
  : { words, revision: null, truncated: false };
```

Value today: low (Link Colorer has no frequency need). It is offered because the
provider side is nearly free. If it stays unused for a release, drop the
`subscribe`/`getRankData` half and keep `getSnapshot` + `getInternalLinkWords`.

---

## 5. Degradation matrix

| Peer state | Detected as | VC behaviour | LC behaviour |
| --- | --- | --- | --- |
| Not installed | absent (`undefined`) | default theme colour | no ordering |
| Installed, **disabled** | absent (Obsidian removes it from `app.plugins.plugins`) | default theme colour | no ordering |
| Enabled but no API | present, `typeof` check fails → `rejectedPluginIds` | default theme colour, one debug line | no ordering |
| API with `api` < min | rejected | fallback | fallback |
| API with `api` > consumer | rejected (never guess forward) | fallback | fallback |
| Enabled, loaded **after** consumer | absent at first use → retry | retried ≤3×, then fallback | same |
| Unloaded mid-session | getter throws | catch → fallback + re-detect next pass | same |
| Mobile | same as desktop | works | works |

Detection outcome is per call and intentionally not cached for the lifetime of
the session; caching it is what turns "user enabled the peer" into "restart
Obsidian".

---

## 6. Load order and retry

```ts
// sketch — consumer side, once, lazily
private linkCoreAttempts = 0;

private resolvePeer(): void {
  if (this.app.workspace.layoutReady === false) return; // don't race startup
  const detected = detectOptionalApis(this.app);
  if (detected.linkCore || detected.linkColorer) {
    this.peerApi = detected;
    return;
  }
  if (this.linkCoreAttempts++ >= 3) return; // bounded: 3 × 500 ms
  window.setTimeout(() => this.resolvePeer(), 500);
}
```

`workspace.onLayoutReady(cb)` is the earliest safe point; the timer covers a user
enabling the peer from the settings UI in the same session. Do not retry
unbounded, and do not show a notice — absence is the normal case.

---

## 7. Risks

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| **Private instance APIs** (`app.plugins.plugins[id]`) | Not in Obsidian's typings; a rename breaks the bridge silently | Take `unknown`, duck-type every member, gate the feature behind a setting, fall back on any shape failure |
| **Colour map keys are internal** | Verified 2.0.8 format `palette-theme-r{cssChange}-{seed}-{ranges}-random-{text}`; a version bump can change it | Prefer `getColorForLinkText`; treat key inversion as a fallback that returns `undefined` rather than guessing |
| **Module exports are unreachable** | `getTextColorMap` et al. live on `module.exports`, and Obsidian does not expose plugin modules | Do not design against them from the plugin-instance side; `detectOptionalApis` normalizes both namings if a future build exposes them |
| **Load order** | No ordering guarantee; peer may load after consumer | `onLayoutReady` + ≤3 retries + per-pass detection (§6) |
| **Version mismatch** | 2-way matrix, both directions | Integer `api` gate both ways; reject rather than coerce; add optional members only |
| **Colour identity churn** | Re-roll, theme change (`css-change` clears caches), and unload all change colours | Never persist colours; rebuild per pass; drop cache on `layout-change`/`css-change` |
| **Mobile** | Same APIs, tighter memory, slower `getMarkdownFiles` | Keep maps per-pass (≤3,500 entries), no session-level retention |
| **Provider wakeups** | An emit per save reintroduces the ~36.7 ms/save class of bug fixed in `8a53ba0` | Emit only on revision change, debounced with `maxWait`; consumers must tolerate missed emits |
| **Cross-plugin memory** | A consumer that retains the 8.2 MB inversion or a 500-entry folder list per folder | Snapshot payloads only, no `Map` handover, no retention |
| **Silent divergence** | Two plugins may disagree about "same link" (case, aliases, `-` prefixes, `#` anchors) | Share *values* (colour, rank), never *semantics*; keep normalization in each owner and document it |

---

## 8. Do-not list

- Do not import `obsidian` from `shared-core/types.ts`.
- Do not share live `Map`s owned by `LinkRankIndex`/`FolderRankCache`.
- Do not call `vault.getMarkdownFiles()` from any getter or from detection.
- Do not put a hard dependency in `manifest.json` (there is no such field) or in
  a settings description ("requires X") — the feature must work without it.
- Do not emit provider events on `metadataCache` "changed" without a revision
  gate and a debounce.
- Do not cache a peer handle across plugin unload; re-detect instead.

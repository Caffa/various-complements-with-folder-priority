# Plan: optional color-match between link-colorer and various-complements

Scheduled to start: 2026-11-28 (one month after 2026-10-28).

## Goal
Make link-colorer the sole owner of link text -> color. When both plugins are
installed, various-complements (VC) reads colors from link-colorer to paint
internal-link suggestions to match the editor. Each plugin still works alone.

## Repos
- VC: /Users/caffae/Local-Projects-2026/various-complements-with-folder-priority
- Link colorer (LC): /Users/caffae/Notes/TestPlugin/.obsidian/plugins/links-coloring

## Why no core plugin / no shared index
- Obsidian's metadataCache already shares the link graph.
- LC does not use link frequencies; VC's folder ranking has no second consumer.
- Only benefit is cosmetic consistency (editor vs suggestion popup).
- Therefore share values via optional runtime APIs, with fallbacks.

## Phase 1 - Link colorer: expose color primitive
Files: LC/src/main.ts (+ manifest version already there).

1. Add public plugin method:
   `getColorForLinkText(text: string): string | undefined`
   implementation should call existing `getColor(text, this.settings, isDarkTheme())`.
2. Add `getVersion(): LinkCoreVersion` returning
   `{ api: LINK_COLORER_API_VERSION, plugin: this.manifest.version }`.
   This can live locally or via shared-core copy.
3. Optional: `getTargetColorMap()` mapping target path/lower text to color.
4. Add a color revision counter bumped on:
   - theme change (css-change handler)
   - reroll commands
   - resetColorState
   Expose as `getColorRevision(): number`.
5. Keep old module exports and instance methods untouched for compatibility.

Verification (LC):
- tsc clean; vitest clean.
- Method returns exact same color as rendering path for sampled links.

## Phase 2 - VC: consume colors (off by default)
Files: VC src/setting/settings.ts, src/ui/AutoCompleteSuggest.ts (or suggester), plus a new helper.

1. Add setting `colorizeInternalLinkSuggestions` default false.
2. At suggestion pass, if setting on, detect LC via `detectOptionalApis(app)`.
3. Build a value -> color map once per pass using `getColorForLinkText` first,
   then target map, then cache-key inversion fallback.
4. Apply color as inline `style="color: ..."` on suggestion rows.
5. Wrap all peer access in try/catch; re-detect each pass; no hard cache of handle.
6. Never call `vault.getMarkdownFiles()` from detection/getters.

Verification (VC):
- typecheck src.
- setting off => no peer detection cost and default colors.
- setting on with LC installed => suggestion colors match editor for sampled links.
- missing/disabled/unloaded LC => graceful default, one debug line max.

## Phase 3 - Coordinates / detection (optional but keeps both directions consistent)
- VC can expose `linkCoreApi` providing `getInternalLinkWords`, `getRankData`,
  `getVersion`, `subscribe`, `dispose`.
- LC can optionally consume rank snapshot if useful (currently low value).
- If unused for a release, drop the rank half and keep color API + snapshot.

## Tests and measurement
- Shared-core typecheck: `pnpm exec tsgo -p shared-core/tsconfig.json`.
- LC build/test.
- VC typecheck + jest.
- Measurement (required before default-on):
  - sample 50 internal links in novel vault; suggestion color == rendered color.
  - added suggestion-pass cost < 0.1 ms with peer present.
  - all load orders (VC first, LC first, both) behave identically.
- Load-order/manual checks on desktop and mobile.

## Risks (from shared-core/INTEGRATION.md)
- Private `app.plugins.plugins` access: duck-type everything, fall back on failure.
- LC cache keys internal: prefer `getColorForLinkText`, treat key inversion as fallback.
- Color identity churn on reroll/theme/unload: rebuild per pass, no persistent cache.
- Mobile memory: per-pass maps only, <= 3500 entries.
- Provider wakeups: emit only on revision change, debounced with maxWait.

## User notification
Notify Discord user 141798255112617984 when the implementation is ready for review
or if a decision is needed.

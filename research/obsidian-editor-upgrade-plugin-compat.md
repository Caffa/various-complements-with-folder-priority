# Obsidian Desktop Editor Upgrade & Plugin Compatibility (as of late Aug 2026)

Research date: 2026-08-26. Focus: latest stable desktop version, CodeMirror 6 (CM6) changes, plugin API deprecations relevant to autocomplete/suggestion plugins, official advisories, and the `various-complements` plugin status.

---

## 1. Latest stable Obsidian desktop version & editor changes

**Latest stable desktop release: Obsidian Desktop v1.13.8** (released 2026-08-20; the 1.13.8 changelog entry is a mobile-only fix, so the newest *desktop* build is effectively **v1.13.7**, 2026-08-12). The 1.13.x line is the current major series.

Sources:
- https://obsidian.md/changelog/ (changelog index)
- https://github.com/obsidianmd/obsidian-releases/releases (release list; v1.13.8 tagged "Latest")

### The big editor change: CodeMirror upgraded in v1.13.4

The most significant editor-related change in the recent major releases is in **Obsidian Desktop v1.13.4 (2026-07-30)**, whose Developers section states:

> **"Upgraded CodeMirror to the latest version."**

This is the headline CM6 change. Other editor/Live Preview changes in 1.13.x are feature/bug-fix work on top of that upgrade (image selection/resizing, lightbox, inline math fixes, table memory-leak fix, etc.), not further API breaks.

Obsidian's published API type definitions (`obsidian-api` package.json) currently pin the CM6 peer dependencies at:
- `@codemirror/state` **6.7.0**
- `@codemirror/view` **6.43.5**

(Source: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/package.json — package version 1.13.2.)

For reference, the latest published CM6 versions on npm are `@codemirror/view` 6.43.9 and `@codemirror/state` 6.7.1, so Obsidian is on a very recent CM6 build.

### Other 1.13.x developer-relevant changes (non-editor)
- **New declarative Settings API** (1.13.0/1.13.4): `PluginSettingTab#getSettingDefinitions()`; settings now open in a new window with search. Official migration guide exists (see §3). This is the main *plugin-facing* API change in 1.13, not the editor.
- `SettingDefinitionBase#disabled` added (1.13.6).
- New `ConfirmationModal` component (1.13.4).
- Base colors migrated to OKLCH; `--callout-color` now expects a valid CSS color (breaking CSS change, 1.13.4).
- Electron bumped to v43.x (installer reinstall required).

---

## 2. Did Obsidian change CM6 / the Editor abstraction / Live Preview internals / deprecate plugin APIs?

**No breaking changes to the plugin-facing editor API were announced or documented for the 1.13.4 CM6 upgrade.** The official developer docs still describe the same stable surface, and no deprecations of the APIs relevant to autocomplete/suggestion plugins were found.

Key findings:

- **`Editor` abstraction is unchanged and still the recommended bridge.** The docs explicitly say: "`Editor` serves as an abstraction to bridge features between CM6 and CM5 (legacy editor, only available on desktop). By using `Editor` instead of directly accessing the CodeMirror instance, you ensure that your plugin works on both platforms." (https://docs.obsidian.md/Plugins/Editor/Editor)
- **`registerEditorExtension()` is unchanged** and remains the way to register CM6 extensions: `this.registerEditorExtension([examplePlugin, exampleField])`. (https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- **`editor.cm` access is unchanged** (still untyped, requires `@ts-expect-error`): `const editorView = view.editor.cm as EditorView;`. (https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions)
- **Decorations, State fields, View plugins, Viewport** docs are all current and unchanged. (https://docs.obsidian.md/Plugins/Editor/Decorations, .../Viewport)
- **`EditorSuggest`** (the primary API for autocomplete/suggestion plugins) is unchanged: `onTrigger`, `getSuggestions`, `context`, `limit`, `setInstructions` all present. (obsidian.d.ts)
- **`Editor` interface methods** (`getCursor`, `setCursor`, `getSelection`, `replaceSelection`, `replaceRange`, `getLine`, `lineCount`, `getScrollInfo`, `scrollIntoView`, etc.) are all still present and unchanged. (obsidian.d.ts)
- **CM6 view access via StateField** (`editorEditorField`, `editorInfoField`, `editorLivePreviewField`) is unchanged.

### Known 1.13.4 CM6-upgrade-related bug (not an API break)
A Live Preview crash surfaced after the 1.13.4 CM6 upgrade: **"No tile at position" errors** when following an internal heading link in a long note (reported 2026-08-04, Android; duplicates on iOS and desktop). This is an Obsidian-internal Live Preview bug, not a plugin API issue, and is tracked as a bug report (not a plugin compatibility problem). It does not require plugin changes.

Sources:
- https://forum.obsidian.md/t/live-preview-following-a-heading-link-crashes-the-editor-repeated-no-tile-at-position-errors/116903
- https://forum.obsidian.md/t/editing-broken-iphone-11-ios-26-5-2/116951
- https://forum.obsidian.md/t/render-failures-after-following-an-internal-page-link/117071

---

## 3. Official plugin developer advisories / migration guides / minAppVersion bumps

- **No official advisory or migration guide was published specifically for the 1.13.4 CodeMirror upgrade.** The `obsidian-api` CHANGELOG (https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/CHANGELOG.md) is stale — its last entry is v1.7.2 and it does not mention the CM6 upgrade or any editor API deprecation.
- **The one official migration guide for 1.13 is for the new Settings API**, not the editor:
  - Guide: https://docs.obsidian.md/plugins/guides/migrate-declarative-settings ("Migrate to declarative settings", requires Obsidian 1.13.0+)
  - Settings docs: https://docs.obsidian.md/Plugins/User+interface/Settings
  - This is opt-in. Plugins that don't adopt it keep working; the new API only appears in the global settings search if migrated.
- **`minAppVersion` guidance:** The docs recommend bumping `minAppVersion` to `1.13.0` only if you adopt the declarative settings API (Path A). For the editor/CM6 upgrade, **no `minAppVersion` bump is required** — the editor API is backward compatible. The only 1.13.4 breaking change that could affect plugins is the CSS `--callout-color` format change (now expects a valid CSS color instead of an RGB triplet).
- **Electron note:** Because 1.13.x moved to Electron v43, Obsidian recommends reinstalling from the download page after upgrading (relevant to dev environments, not plugin code).

---

## 4. `various-complements` (tadashi-aikawa) status for the new editor

**Repo:** https://github.com/tadashi-aikawa/obsidian-various-complements-plugin (the canonical repo; the short name `various-complements` is the plugin id).

- **Latest release: v11.4.1 (2026-08-26)** — actively maintained (released the same day as this research).
- **`minAppVersion`: "1.11.4"** and devDependency `obsidian: 1.11.4` — the plugin has **NOT** bumped for 1.13.x. (manifest.json + package.json on `main`.)
- **No published notes/changes specifically for the 1.13.4 CM6 upgrade.** The 11.0.0 release (2026-01-25) bumped minAppVersion to 1.11.4 and updated dependencies, but nothing since addresses the 1.13 CM6 upgrade.
- **No open issues reference 1.13 or CM6 compatibility problems.** Searching the repo's issues for "1.13", "CodeMirror", "cm6" returns no compatibility reports (only old, unrelated items). The plugin's open issues are feature requests and unrelated bugs.
- **Why it's insulated from the CM6 upgrade:** A full scan of all 50 TypeScript source files shows the plugin uses **only the stable `EditorSuggest` API** (`onTrigger`/`getSuggestions`/`context`) and does **not** use `editor.cm`, `registerEditorExtension`, `ViewPlugin`, `Decoration`, `editorEditorField`, `coordsAtPos`, `cursorCoords`, `posToDOM`, `domToPos`, or `getScrollInfo`. Because it relies on the stable `Editor`/`EditorSuggest` abstraction rather than CM6 internals, it is largely unaffected by the 1.13.4 CodeMirror upgrade.

Sources:
- https://github.com/tadashi-aikawa/obsidian-various-complements-plugin
- https://github.com/tadashi-aikawa/obsidian-various-complements-plugin/releases
- https://raw.githubusercontent.com/tadashi-aikawa/obsidian-various-complements-plugin/main/manifest.json
- https://raw.githubusercontent.com/tadashi-aikawa/obsidian-various-complements-plugin/main/package.json
- https://raw.githubusercontent.com/tadashi-aikawa/obsidian-various-complements-plugin/main/src/ui/AutoCompleteSuggest.ts

---

## Actionable summary for plugin developers (esp. autocomplete/suggestion plugins)

1. **No code changes are required for the 1.13.4 CM6 upgrade** if your plugin uses the stable `Editor` / `EditorSuggest` / `registerEditorExtension` APIs. The editor API surface is unchanged and backward compatible.
2. **Do NOT bump `minAppVersion` to 1.13.x for the editor.** The only reason to bump to 1.13.0 is to adopt the new declarative Settings API (`getSettingDefinitions()`), which is optional.
3. **If you touch CM6 internals directly** (`editor.cm`, `ViewPlugin`, `Decoration`, `coordsAtPos`, `posToDOM`, `domToPos`, `getScrollInfo`), re-test against 1.13.4+ since the underlying CM6 build was upgraded to ~`@codemirror/view` 6.43.x / `@codemirror/state` 6.7.x. These are internal, untyped, and not covered by the API contract — they can change behavior between CM6 point releases.
4. **Watch the "No tile at position" Live Preview crash** if your plugin triggers navigation/scroll in long notes — it's an Obsidian-internal bug from the CM6 upgrade, not a plugin API issue, but it can surface as a crash in Live Preview.
5. **CSS breaking change to check:** if your plugin/theme sets `--callout-color`, it must now be a valid CSS color (e.g. `#ff0000` or `rgb(...)`), not an RGB triplet `255,0,0`.
6. **`various-complements` is safe and current** (v11.4.1, minAppVersion 1.11.4) — it uses only the stable `EditorSuggest` API and needs no changes for the new editor.

---

## Source URLs (all verified)

- Changelog: https://obsidian.md/changelog/
- Releases: https://github.com/obsidianmd/obsidian-releases/releases
- 1.13.4 desktop changelog (CM6 upgrade): https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/
- obsidian-api package.json (CM6 peer deps): https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/package.json
- obsidian-api CHANGELOG: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/CHANGELOG.md
- Editor docs: https://docs.obsidian.md/Plugins/Editor/Editor
- Editor extensions docs: https://docs.obsidian.md/Plugins/Editor/Editor+extensions
- Decorations docs: https://docs.obsidian.md/Plugins/Editor/Decorations
- Viewport docs: https://docs.obsidian.md/Plugins/Editor/Viewport
- Communicating with editor extensions: https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions
- Settings migration guide: https://docs.obsidian.md/plugins/guides/migrate-declarative-settings
- various-complements repo: https://github.com/tadashi-aikawa/obsidian-various-complements-plugin
- various-complements releases: https://github.com/tadashi-aikawa/obsidian-various-complements-plugin/releases
- various-complements manifest: https://raw.githubusercontent.com/tadashi-aikawa/obsidian-various-complements-plugin/main/manifest.json
- Forum "No tile at position" bug: https://forum.obsidian.md/t/live-preview-following-a-heading-link-crashes-the-editor-repeated-no-tile-at-position-errors/116903

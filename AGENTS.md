# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source.
  - `src/main.ts`: Obsidian plugin entry.
  - `src/ui/`: Svelte UI components.
  - `src/provider/`, `src/tokenizer/`, `src/util/`, `src/setting/`: core logic and helpers.
- Root artifacts: `manifest.json`, `styles.css`, bundled `main.js`.
- Tests: colocated `*.test.ts` next to sources (e.g., `src/util/strings.test.ts`).

## Build, Test, and Development Commands
- `pnpm dev`: Start esbuild in watch mode. Copies `main.js`, `manifest.json`, `styles.css` to your Obsidian vault if `VAULT_DIR` in `esbuild.config.mjs` is set.
- `pnpm build`: Type-check then production bundle to `main.js`.
- `pnpm typecheck`: Run TypeScript in strict mode without emit.
- `pnpm test` | `pnpm test:watch`: Run Jest tests (with coverage by default).
- `pnpm format`: Prettier check for `*.ts` files.
- `pnpm verify`: Install, Build, Check for CI.

## Coding Style & Naming Conventions
- Language: TypeScript (strict). UI in Svelte where applicable.
- Formatting: Prettier with `prettier-plugin-organize-imports` (run `pnpm format`).
- Indentation: Prettier defaults (2 spaces). Avoid inline `any` and prefer explicit types.
- Names: `PascalCase` for types/classes, `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants.
- File names: `kebab-case.ts`; tests as `name.test.ts` colocated with the unit under test.

## Testing Guidelines
- Framework: Jest via `esbuild-jest` transform.
- Location: colocated `*.test.ts` near sources.
- Coverage: `pnpm test` generates coverage; keep or improve existing coverage.
- Test style: small, focused cases; prefer deterministic inputs; mock Obsidian APIs as needed.

## Commit & Pull Request Guidelines
- Commits: Conventional Commits (e.g., `feat:`, `fix:`, `build:`, `style:`). Releases are automated via semantic‑release.
- PR policy: This project generally does not accept PRs except obvious bug fixes, typos/docs, or items explicitly requested in issues/discussions (see `pull_request_template.md`). Open an issue/discussion first.
- PR content: clear description, linked issue, reproduction or before/after notes; attach screenshots only for UI-facing changes.

## Security & Configuration Tips
- Local dev vault: set `VAULT_DIR` in `esbuild.config.mjs` to your Obsidian vault to enable hot-copying during `pnpm dev`.
- External modules: Obsidian and Node builtins are marked external in bundling; avoid relying on unavailable runtime modules.

## Performance Conventions (Obsidian vaults are large — read before adding features)

**Why this section exists.** Internal-complement and ranking code runs on Obsidian's main UI thread, against vaults with 10k+ notes, 100k+ link edges, and thousands of aliases. A per-save or per-keystroke O(vault-size) operation is invisible in the lab and turns into visible lag in real use. In one incident (stage-2 per-folder rank cache, 2026-10-28), a single version counter caused `FolderRankCache` to do a 10.8 ms full `getMarkdownFiles()` scan + 25.5 ms cold rebuild on *every* save — even prose edits that changed no links — producing ~18 ms/s of added cost, 149 frame stalls over 5 minutes, and p95 frame times of ~36 ms. The fix (delta-aware version bump) reduced that to ~0.25 ms/s and zero stalls.

Rules:

- **No O(vault-size) work on the keystroke path.** Per-keystroke work must be O(matched candidates) after trimming; vault-wide work must be (a) memoized/cached and (b) triggered only by structure events or lazy first-use.
- **Never gate heavy caches on a coarse "version" bump unless the bump is delta-aware.** Cache-invalidation versions must mean "the measured data changed", not "some event fired". When in doubt, prefer `markSourceStale`-style per-key invalidation over a global bump.
- **`app.vault.getMarkdownFiles()` is NOT free.** At ~12k files it costs ~10 ms. Do not call it on the keystroke path, per-metadata-change, or per-suggestion-pass. Either memoize once per structure change (create/rename/delete) or lazy-build behind `requestIdleCallback` and a structure epoch.
- **Latency-sensitive data refreshes (e.g., internal-link reindex) must be debounced with `maxWait` and must never synchronously `clear()` then rebuild, leaving a visible empty window.** Hidden cost of debounced reindex under continuous editing is a frequent issue ~1x per ~10–30s.
- **Precomputed structures (caches, ranked lists) must be behavior-preserving.** Cached score ≡ live score (both must run the same function), cache misses fall back to the live path, and a cache must be *fully inert* when its gating setting is off. The stage-2 cache did this right; the cost model was what was wrong.
- **Memory claims in docs/tests must be honest.** Measure entry size (`process.memoryUsage().heapUsed` before/after push) instead of guessing. The cache was documented as "~20–30 MB worst case"; measured was 510 B/entry vs 179 B claimed (≈175 MB at the 512/2000 caps). LRU caps bound only the list *count* — entry count also matters.
- **Every performance-sensitive merge must include before/after numbers**, not "feels faster". Cite a measurement artifact (e.g., `research/performance-measurement-*.md`) with the scenarios and frame budget.
- **Use `bunx critique` + an analytic + deep review pass for cache/index changes.** The staged reviews in this repo (in `research/codebase-map.md`'s follow-ups) caught the correctness; the perf report (`research/performance-measurement-2026-10-28.md`) caught the regression after shipping.
- **Before adding a new cache/index feature, ask: does the user actually need stable rank ordering for search?** Most of the win comes from correctness (delta-aware reindex, no redundant scan), not from precomputing top-K.

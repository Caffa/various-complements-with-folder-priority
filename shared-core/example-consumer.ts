/**
 * Illustrative consumer. NOT imported by `src/` and not wired into the plugin.
 *
 * Two examples, both of which must be correct when the other plugin is missing,
 * disabled, too old, or unloaded mid-session:
 *
 * 1. {@link resolveSuggestionColors} — color internal-link suggestions to match
 *    what Link Colorer already painted in the editor.
 * 2. {@link orderInternalLinkWords} — sort candidate words by Various
 *    Complements' folder-priority ordering, without owning its index.
 *
 * Both are pure functions over the detection result, so they are testable with a
 * fake `app` object and add zero cost on the keystroke path when the peer plugin
 * is absent (one property read + one duck-type check per pass).
 */

import {
  detectOptionalApis,
  type LinkColorApiLike,
  type LinkCoreService,
  type RankSnapshot,
  type WordSnapshot,
} from "./types";

/* -------------------------------------------------------------------------- */
/* 1. Suggestion colors from Link Colorer                                     */
/* -------------------------------------------------------------------------- */

export interface SuggestionColorHint {
  /** The word's completion value, echoed back for the caller to match on. */
  readonly value: string;
  /** CSS color, hex. */
  readonly color: string;
}

/**
 * Link Colorer encodes the link text as the tail of its cache key:
 * `${palette}-${theme}-r${cssChange}-${seed}-${ranges}-${mode}-${text}`.
 *
 * Recovering `text` from the tail is a *fallback*, not the supported path: the
 * separator, field order, and theme tag are all internal. `-random-` is verified
 * against Link Colorer 2.0.8 `main.js`; a future version may change it, in which
 * case this returns undefined and the caller simply gets no colors.
 */
const COLOR_CACHE_KEY_SEPARATOR = "-random-";

/** Best-effort: recover the link text from a Link Colorer cache key. */
export function linkTextFromColorCacheKey(key: string): string | undefined {
  const index = key.lastIndexOf(COLOR_CACHE_KEY_SEPARATOR);
  if (index < 0) {
    return undefined;
  }
  const text = key.slice(index + COLOR_CACHE_KEY_SEPARATOR.length);
  return text.length === 0 ? undefined : text;
}

/**
 * Inverts Link Colorer's cache-key → color map into text → color.
 *
 * Theme is part of the key, so a vault that has been viewed in both themes holds
 * two entries per text. First entry wins here; a real consumer should filter on
 * the current theme instead of relying on insertion order.
 */
function deriveColorByLinkText(
  api: LinkColorApiLike,
): ReadonlyMap<string, string> {
  const byText = new Map<string, string>();
  for (const [key, color] of api.getTextColorMap()) {
    const text = linkTextFromColorCacheKey(key);
    if (text !== undefined && !byText.has(text)) {
      byText.set(text, color);
    }
  }
  return byText;
}

/**
 * Resolves one word's color using the best available API, in order:
 * `getColorForLinkText` (future, exact) → `getTargetColorMap` (future, exact) →
 * cache-key inversion (today, heuristic).
 */
function resolveWordColor(
  api: LinkColorApiLike,
  word: WordSnapshot,
  derived: ReadonlyMap<string, string>,
): string | undefined {
  const exact = api.getColorForLinkText?.(word.value);
  if (exact !== undefined) {
    return exact;
  }

  const byTarget = api.getTargetColorMap?.();
  if (byTarget !== undefined) {
    const targetColor =
      byTarget.get(word.path) ??
      byTarget.get(word.value) ??
      byTarget.get(word.value.toLowerCase());
    if (targetColor !== undefined) {
      return targetColor;
    }
  }

  // Link Colorer lowercases the text before hashing, so the lowercase key is
  // the one that hits; `value` is a fallback for future case-preserving modes.
  return derived.get(word.value.toLowerCase()) ?? derived.get(word.value);
}

/**
 * Returns a color hint for every word Link Colorer currently knows about.
 * Returns [] when Link Colorer is absent/rejected — callers then render
 * suggestions with the theme's default color, exactly as today.
 */
export function resolveSuggestionColors(
  app: unknown,
  words: readonly WordSnapshot[],
): readonly SuggestionColorHint[] {
  const { linkColorer } = detectOptionalApis(app);
  if (linkColorer === undefined || words.length === 0) {
    return [];
  }

  const derived = deriveColorByLinkText(linkColorer);
  const hints: SuggestionColorHint[] = [];
  for (const word of words) {
    const color = resolveWordColor(linkColorer, word, derived);
    if (color !== undefined) {
      hints.push({ value: word.value, color });
    }
  }
  return hints;
}

/* -------------------------------------------------------------------------- */
/* 2. Stable ordering from Various Complements                                */
/* -------------------------------------------------------------------------- */

export interface OrderedWordsResult {
  /** Re-ordered copy (never the input array). */
  readonly words: readonly WordSnapshot[];
  /** Provider revision the ordering came from, or null when absent/not applicable. */
  readonly revision: number | null;
  /** True when the provider's ranked list was truncated, so tail order is arbitrary. */
  readonly truncated: boolean;
}

/** `getRankData` on a provider that may have unloaded between detection and use. */
function safeRankSnapshot(
  service: LinkCoreService,
  currentFilePath: string | null,
  limitingFolder: string,
): RankSnapshot | undefined {
  try {
    return service.getRankData(currentFilePath, limitingFolder);
  } catch {
    return undefined;
  }
}

/**
 * Sorts words by rank position, falling back to the input order.
 *
 * Words outside the ranked set (rank undefined or not present) keep their
 * relative order and sort last: Array.prototype.sort is stable in every engine
 * Obsidian ships.
 */
export function orderInternalLinkWords(
  app: unknown,
  currentFilePath: string | null,
  limitingFolder: string,
  words: readonly WordSnapshot[],
): OrderedWordsResult {
  const { linkCore } = detectOptionalApis(app);
  if (linkCore === undefined || limitingFolder === "") {
    return { words, revision: null, truncated: false };
  }

  const rank = safeRankSnapshot(linkCore, currentFilePath, limitingFolder);
  if (rank === undefined) {
    return { words, revision: null, truncated: false };
  }

  const resolvedPosition = new Map<string, number>();
  const unresolvedPosition = new Map<string, number>();
  for (const entry of rank.entries) {
    if (entry.rank === undefined) {
      continue;
    }
    const target =
      entry.kind === "resolved" ? resolvedPosition : unresolvedPosition;
    target.set(entry.key, entry.rank);
  }

  const positionOf = (word: WordSnapshot): number => {
    const key = word.phantom === true ? word.value.toLowerCase() : word.path;
    const position =
      word.phantom === true
        ? unresolvedPosition.get(key)
        : resolvedPosition.get(key);
    return position ?? Number.POSITIVE_INFINITY;
  };

  const ordered = words
    .map((word, index) => ({ word, index, position: positionOf(word) }))
    .sort((a, b) =>
      a.position === b.position ? a.index - b.index : a.position - b.position,
    )
    .map((entry) => entry.word);

  return { words: ordered, revision: rank.revision, truncated: rank.truncated };
}

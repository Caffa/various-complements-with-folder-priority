/**
 * Shared link-core contract: optional, versioned runtime APIs between Obsidian
 * plugins that care about links (Various Complements w/ Folder Priority and
 * Link Colorer).
 *
 * Design rules this file encodes:
 *
 * 1. No runtime dependency on `obsidian`. This module is pure data + duck
 *    typing so it can be typechecked, unit-tested, or bundled anywhere.
 * 2. Nothing here is authoritative. Payloads cross a plugin boundary that the
 *    Obsidian API does not type or version, so every consumer must feature-detect
 *    (`detectOptionalApis`) and must keep working when a member is missing.
 * 3. Wire shapes are plain values (`readonly` arrays, `ReadonlyMap`, numbers),
 *    not live class instances. A future worker/IPC/serialized path can carry the
 *    same shapes without a second set of types.
 * 4. Version gates are integers. The provider reports the contract version it
 *    implements; the consumer declares the range it understands. Version skew is
 *    rejected, never coerced.
 */

/**
 * Contract version implemented by this file (i.e. the highest version a
 * consumer built from this file can understand).
 *
 * Bump on any breaking change to {@link LinkCoreService} or {@link LinkColorApi}.
 * Adding an optional member does not require a bump.
 */
export const LINK_CORE_API_VERSION = 1;

/**
 * Oldest provider contract version this consumer can still drive. A provider
 * reporting a lower `api` is rejected rather than called with guessed semantics.
 */
export const LINK_CORE_MIN_SUPPORTED_API = 1;

/** Contract version of the link-colorer side of the bridge. */
export const LINK_COLORER_API_VERSION = 1;

/**
 * Property name a plugin should use to expose its service on its own plugin
 * instance, e.g. `app.plugins.plugins["various-complements-..."].linkCoreApi`.
 *
 * Exposing a namespaced object (instead of letting consumers call incidental
 * methods on the plugin instance) is what makes the API opt-in: internal
 * refactors stay internal as long as this handle keeps its contract.
 */
export const LINK_CORE_API_KEY = "linkCoreApi";

/**
 * Plugin ids that may provide a {@link LinkCoreService}, most specific first.
 * The first id found in `app.plugins.plugins` wins.
 */
export const LINK_CORE_PLUGIN_IDS = [
  "various-complements-with-folder-priority",
  "various-complements",
] as const;

/** Plugin id of Link Colorer. */
export const LINK_COLORER_PLUGIN_ID = "link-colorer";

/* -------------------------------------------------------------------------- */
/* Versions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Identifies *which* implementation of a contract is talking, and *which*
 * revision of the contract it implements.
 *
 * `plugin` is the provider's manifest version (informational only: consumers
 * must gate on `api`, never on a parsed semver of `plugin`).
 */
export interface LinkCoreVersion {
  /** Contract version, compared against LINK_CORE_MIN_SUPPORTED_API..LINK_CORE_API_VERSION. */
  api: number;
  /** Provider manifest version, e.g. "11.4.1". Informational. */
  plugin: string;
}

/* -------------------------------------------------------------------------- */
/* Link graph                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One resolved edge of Obsidian's own link graph, flattened.
 *
 * Authoritative source is `app.metadataCache.resolvedLinks[source][target]`,
 * which Obsidian maintains incrementally. Providers must not recompute it.
 */
export interface ResolvedLink {
  /** Vault-relative path of the file containing the link. */
  source: string;
  /** Vault-relative path of the link target. */
  target: string;
  /** How many times `source` links to `target`. */
  count: number;
}

/**
 * One unresolved (phantom) edge, flattened.
 *
 * Authoritative source is `app.metadataCache.unresolvedLinks[source][name]`.
 * Note the two-key shape: Obsidian stores the raw link text, while ranking code
 * (and `LinkRankIndex`) keys on a lowercased form. Both are carried so consumers
 * do not re-derive normalization.
 */
export interface UnresolvedLink {
  /** Vault-relative path of the file containing the link. */
  source: string;
  /** Link text as written, e.g. "Chapter - T1". */
  name: string;
  /** Lookup key used by ranking: `name.toLowerCase()`. */
  key: string;
  /** How many times `source` contains this unresolved link. */
  count: number;
}

/**
 * A snapshot of one internal-link completion word.
 *
 * Mirrors the subset of `InternalLinkWord` that crosses a plugin boundary:
 * everything a consumer needs to render or order a suggestion, and nothing that
 * depends on Obsidian object identity (no `TFile`, no editor offsets).
 */
export interface WordSnapshot {
  /** The completion text (basename, alias, or unresolved link text). */
  value: string;
  /**
   * Vault-relative path of `createdPath`: the target file for resolved words,
   * or the file that mentions it for phantom words.
   */
  path: string;
  /** Synonym aliases that also match this word. */
  aliases?: readonly string[];
  /** Human-readable description (usually the target path). */
  description?: string;
  /** True for unresolved/phantom links. */
  phantom?: boolean;
}

/**
 * One ranked key in a folder-priority ordering.
 *
 * A flattened projection of `FolderRankScoreEntry`, with the key kind made
 * explicit so a consumer never has to guess whether `key` is a path or a
 * lowercased link name.
 */
export interface RankEntrySnapshot {
  /** Path (resolved) or lowercased link name (unresolved). */
  key: string;
  kind: "resolved" | "unresolved";
  /** Folder distance from the current file: 0 = same folder, 1 = parent/child, ... */
  level: number;
  /** Occurrences of this link at the best source-folder level. */
  frequency: number;
  /** `frequency / (level + 1)`, higher is better. */
  score: number;
  /** 1-based stable position, present only for the top-K. */
  rank?: number;
}

/**
 * A stable ordering snapshot for one (file, limiting folder) pair.
 *
 * This is deliberately *not* `LinkRankData`: `LinkRankData` carries live `Map`s
 * owned by the provider's index. Sharing those directly across a plugin boundary
 * would share the provider's mutation and lifecycle. This is an immutable,
 * already-computed view.
 */
export interface RankSnapshot {
  /** Provider revision this snapshot was derived from. Same value ⇒ same ordering. */
  revision: number;
  /** File the ordering was computed for, or null when outside folder priority. */
  filePath: string | null;
  /** Root folder that bounded the computation; "" means folder priority is off. */
  limitingFolder: string;
  /** Targets linked from `filePath` (file tier). Order is not significant. */
  fileTargets: readonly string[];
  /** Lowercased unresolved names linked from `filePath` (file tier). */
  fileUnresolvedKeys: readonly string[];
  /** Ranked entries, best first. Empty when `limitingFolder` is "". */
  entries: readonly RankEntrySnapshot[];
  /** True when the provider trimmed `entries` below the true ranked set size. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Immutable describe-the-index payload. Cheap: providers must return an
 * already-built value, never trigger a vault scan inside a getter.
 */
export interface LinkCoreSnapshot {
  version: LinkCoreVersion;
  /**
   * Monotonic revision of the underlying link data. Bumped only when the data
   * actually changed (not on every metadata event), so consumers can use it as
   * a cache key.
   */
  revision: number;
  /** Epoch ms when the underlying index was last (re)built. */
  builtAt: number;
  /** Markdown files known to the index. */
  fileCount: number;
  /** Resolved edges (source→target pairs, not link occurrences). */
  resolvedLinkCount: number;
  /** Unresolved edges (source→name pairs). */
  unresolvedLinkCount: number;
  /** Duration of the last index build, ms. Diagnostics only. */
  buildMs?: number;
}

/**
 * Listener for revision changes. Called synchronously on the provider's thread.
 * Must not throw: a throwing listener must not break the provider's emit loop.
 */
export type LinkCoreListener = (snapshot: LinkCoreSnapshot) => void;

/**
 * The optional service a link-aware plugin may expose.
 *
 * Lifecycle contract (see INTEGRATION.md):
 * - The provider builds this object during `onload` but must not populate any
 *   index eagerly; every getter may lazily build on first call.
 * - The provider keeps it usable until its plugin unloads.
 * - `dispose()` on this handle unsubscribes the *caller only*. It never unloads
 *   the provider. Consumers must tolerate a disposed handle.
 * - After provider unload, getters may throw. Consumers that cached the handle
 *   must re-detect on the next use instead of retrying forever.
 */
export interface LinkCoreService {
  /** Provider plugin id, e.g. "various-complements-with-folder-priority". */
  readonly id: string;
  /** Contract + plugin version. Cheap, no index build. */
  getVersion(): LinkCoreVersion;
  /** Index metadata. Cheap, no index build. */
  getSnapshot(): LinkCoreSnapshot;
  /** Current internal-link completion words (resolved + phantom). */
  getInternalLinkWords(): readonly WordSnapshot[];
  /**
   * Folder-priority ordering for one file. Must be memoized by the provider for
   * the current revision, so repeated calls in one pass are O(1).
   */
  getRankData(
    currentFilePath: string | null,
    limitingFolder: string,
  ): RankSnapshot;
  /** Subscribe to revision changes. Returns an unsubscribe function. */
  subscribe(listener: LinkCoreListener): () => void;
  /** Detach the caller. Safe to call more than once. */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Link Colorer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The color API we *want* Link Colorer to expose.
 *
 * Reality check (Link Colorer 2.0.8, bundled `main.js`): the three functions in
 * this interface exist as **module-level exports**
 * (`module.exports = { getTextColorMap, getColorUsageMap, getLinkPaletteIndexMap }`),
 * not as plugin-instance methods. Obsidian does not hand out plugin modules, so
 * a consumer resolving the plugin instance only gets `getLinkColorMap()` and
 * `getColorUsageStats()`. `detectOptionalApis` normalizes both namings; treat
 * every member of this interface as optional in practice.
 *
 * Key caveat (both namings): maps are keyed by Link Colorer's *internal cache
 * key*, not by link text or target path, e.g.
 * `"vibrant-dark-r0-5381-70-90-60-75-random-chapter|t1"`. See INTEGRATION.md.
 */
export interface LinkColorApi {
  /** Internal cache key → CSS color (hex). Colour includes theme + seed. */
  getTextColorMap(): ReadonlyMap<string, string>;
  /** Internal usage key → usage count (collision avoidance bookkeeping). */
  getColorUsageMap(): ReadonlyMap<string, number>;
  /** Internal cache key → palette index. */
  getLinkPaletteIndexMap(): ReadonlyMap<string, number>;
}

/**
 * Members that do not exist yet but that this design asks Link Colorer to add.
 * Optional on purpose: consumers must degrade when they are absent.
 */
export interface LinkColorApiExtensions {
  /** Contract + plugin version. */
  getVersion?(): LinkCoreVersion;
  /** The missing primitive: color for a link, keyed by the text it renders. */
  getColorForLinkText?(text: string): string | undefined;
  /** Target path (or lowercased unresolved name) → color. */
  getTargetColorMap?(): ReadonlyMap<string, string>;
}

/**
 * Normalized color API. `getTextColorMap` is the one member duck-typing
 * requires (every Link Colorer build so far exposes it under one of its two
 * names); the rest may be absent.
 */
export type LinkColorApiLike = {
  getTextColorMap(): ReadonlyMap<string, string>;
} & Partial<Omit<LinkColorApi, "getTextColorMap">> &
  LinkColorApiExtensions;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/** Result of inspecting `app.plugins.plugins` once. Never throws. */
export interface DetectedOptionalApis {
  /** Present and version-compatible. Undefined when absent or rejected. */
  readonly linkCore?: LinkCoreService;
  /** Present and duck-typed. Undefined when absent or rejected. */
  readonly linkColorer?: LinkColorApiLike;
  /**
   * Plugin ids that were *installed and loaded* but whose API was rejected
   * (wrong shape or unsupported contract version). Empty in the normal case.
   * Useful for one debug log line; never for control flow.
   */
  readonly rejectedPluginIds: readonly string[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Reads `target[key]` if it is a function and returns a `this`-preserving
 * wrapper. Keeping the receiver bound matters: plugin APIs are class methods
 * that read `this.settings`.
 */
function bindFn(
  target: unknown,
  key: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  const value = target[key];
  if (typeof value !== "function") {
    return undefined;
  }
  const fn = value as (...args: unknown[]) => unknown;
  return (...args: unknown[]): unknown => fn.apply(target, args);
}

/** `app.plugins.plugins`, or undefined when the community-plugin host is absent. */
function readPluginsMap(app: unknown): UnknownRecord | undefined {
  if (!isRecord(app)) {
    return undefined;
  }
  const pluginHost = app["plugins"];
  if (!isRecord(pluginHost)) {
    return undefined;
  }
  const map = pluginHost["plugins"];
  return isRecord(map) ? map : undefined;
}

function parseLinkCoreVersion(value: unknown): LinkCoreVersion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const api = value["api"];
  const plugin = value["plugin"];
  if (typeof api !== "number" || !Number.isInteger(api)) {
    return undefined;
  }
  if (typeof plugin !== "string") {
    return undefined;
  }
  return { api, plugin };
}

/**
 * Wraps a candidate in {@link LinkCoreService} when its shape and contract
 * version are acceptable.
 *
 * Deliberately does not call `getSnapshot`/`getInternalLinkWords`/`getRankData`:
 * detection may run before the provider's first build, and a getter is allowed
 * to lazily build an index. Payloads are validated by the consumer at use site.
 */
function toLinkCoreService(candidate: unknown): LinkCoreService | undefined {
  const getVersion = bindFn(candidate, "getVersion");
  const getSnapshot = bindFn(candidate, "getSnapshot");
  const getInternalLinkWords = bindFn(candidate, "getInternalLinkWords");
  const getRankData = bindFn(candidate, "getRankData");
  const subscribe = bindFn(candidate, "subscribe");
  const dispose = bindFn(candidate, "dispose");

  if (
    getVersion === undefined ||
    getSnapshot === undefined ||
    getInternalLinkWords === undefined ||
    getRankData === undefined ||
    subscribe === undefined ||
    dispose === undefined
  ) {
    return undefined;
  }

  let version: LinkCoreVersion | undefined;
  try {
    version = parseLinkCoreVersion(getVersion());
  } catch {
    return undefined;
  }
  if (version === undefined) {
    return undefined;
  }
  if (
    version.api < LINK_CORE_MIN_SUPPORTED_API ||
    version.api > LINK_CORE_API_VERSION
  ) {
    return undefined;
  }

  const rawId = isRecord(candidate) ? candidate["id"] : undefined;
  const id = typeof rawId === "string" ? rawId : "unknown";

  return {
    id,
    getVersion: (): LinkCoreVersion =>
      parseLinkCoreVersion(getVersion()) ?? { api: 0, plugin: "unknown" },
    getSnapshot: (): LinkCoreSnapshot => getSnapshot() as LinkCoreSnapshot,
    getInternalLinkWords: (): readonly WordSnapshot[] =>
      getInternalLinkWords() as readonly WordSnapshot[],
    getRankData: (
      currentFilePath: string | null,
      limitingFolder: string,
    ): RankSnapshot =>
      getRankData(currentFilePath, limitingFolder) as RankSnapshot,
    subscribe: (listener: LinkCoreListener): (() => void) => {
      const unsubscribe = subscribe(listener);
      return typeof unsubscribe === "function"
        ? (unsubscribe as () => void)
        : () => undefined;
    },
    dispose: (): void => {
      dispose();
    },
  };
}

/**
 * Normalizes a Link Colorer plugin instance (or module-export-like object) into
 * {@link LinkColorApiLike}.
 *
 * Accepts either naming: `getLinkColorMap`/`getColorUsageStats` (2.0.8 instance)
 * or `getTextColorMap`/`getColorUsageMap` (module exports). Coverage color API
 * that exposes neither shape is rejected.
 */
function toLinkColorApi(candidate: unknown): LinkColorApiLike | undefined {
  const textColorMap =
    bindFn(candidate, "getTextColorMap") ??
    bindFn(candidate, "getLinkColorMap");
  if (textColorMap === undefined) {
    return undefined;
  }

  const colorUsageMap =
    bindFn(candidate, "getColorUsageMap") ??
    bindFn(candidate, "getColorUsageStats");
  const paletteIndexMap = bindFn(candidate, "getLinkPaletteIndexMap");
  const colorForText = bindFn(candidate, "getColorForLinkText");
  const targetColorMap = bindFn(candidate, "getTargetColorMap");
  const getVersion = bindFn(candidate, "getVersion");

  return {
    getTextColorMap: (): ReadonlyMap<string, string> =>
      textColorMap() as ReadonlyMap<string, string>,
    ...(colorUsageMap === undefined
      ? {}
      : {
          getColorUsageMap: (): ReadonlyMap<string, number> =>
            colorUsageMap() as ReadonlyMap<string, number>,
        }),
    ...(paletteIndexMap === undefined
      ? {}
      : {
          getLinkPaletteIndexMap: (): ReadonlyMap<string, number> =>
            paletteIndexMap() as ReadonlyMap<string, number>,
        }),
    ...(colorForText === undefined
      ? {}
      : {
          getColorForLinkText: (text: string): string | undefined => {
            const color = colorForText(text);
            return typeof color === "string" ? color : undefined;
          },
        }),
    ...(targetColorMap === undefined
      ? {}
      : {
          getTargetColorMap: (): ReadonlyMap<string, string> =>
            targetColorMap() as ReadonlyMap<string, string>,
        }),
    ...(getVersion === undefined
      ? {}
      : {
          getVersion: (): LinkCoreVersion =>
            parseLinkCoreVersion(getVersion()) ?? { api: 0, plugin: "unknown" },
        }),
  };
}

/**
 * Inspects `app.plugins.plugins` and returns the optional APIs that are actually
 * usable right now.
 *
 * Contract:
 * - Pure read. No writes, no events, no index builds, no throwing.
 * - Takes `unknown` so this module needs no `obsidian` import; passing an
 *   `App` instance is fine and always assignable.
 * - Returns `{}` plus an empty `rejectedPluginIds` when the community-plugin
 *   host is unavailable (e.g. some test harnesses, future sandboxing).
 * - A plugin that is installed but *disabled* is absent from
 *   `app.plugins.plugins`, so it shows up as "absent", not "rejected".
 *
 * Call this at first use, not in `onload`: plugin load order is not guaranteed,
 * so an early detection legitimately fails. See INTEGRATION.md for the retry
 * pattern.
 */
export function detectOptionalApis(app: unknown): DetectedOptionalApis {
  const rejectedPluginIds: string[] = [];
  const plugins = readPluginsMap(app);
  if (plugins === undefined) {
    return { rejectedPluginIds };
  }

  let linkCore: LinkCoreService | undefined;
  for (const id of LINK_CORE_PLUGIN_IDS) {
    const instance = plugins[id];
    if (instance === undefined) {
      continue;
    }
    // Preferred: namespaced handle. Fallback: the instance itself, for
    // providers that expose the contract directly.
    const namespaced = isRecord(instance)
      ? instance[LINK_CORE_API_KEY]
      : undefined;
    const candidate = namespaced ?? instance;
    linkCore = toLinkCoreService(candidate);
    if (linkCore === undefined) {
      rejectedPluginIds.push(id);
    }
    break;
  }

  let linkColorer: LinkColorApiLike | undefined;
  const colorerInstance = plugins[LINK_COLORER_PLUGIN_ID];
  if (colorerInstance !== undefined) {
    linkColorer = toLinkColorApi(colorerInstance);
    if (linkColorer === undefined) {
      rejectedPluginIds.push(LINK_COLORER_PLUGIN_ID);
    }
  }

  return {
    ...(linkCore === undefined ? {} : { linkCore }),
    ...(linkColorer === undefined ? {} : { linkColorer }),
    rejectedPluginIds,
  };
}

/**
 * Lazy per-leaf-folder cache of precomputed folder-proximity rank lists.
 *
 * Only leaf folders (no subfolders with markdown files) with between
 * MIN_FILES_PER_FOLDER and MAX_FILES_PER_FOLDER direct markdown files are
 * qualified. Each qualified folder keeps up to MAX_LIST_SIZE entries
 * (resolved targets + unresolved names), with deterministic rank positions
 * for the top TOP_K entries.
 */

import type { App } from "obsidian";
import {
  calculateFolderLevel,
  getParentFolder,
  isWithinFolder,
  normalizeFolderPath,
  type FolderProximityScore,
} from "../model/FolderProximity";
import type {
  FolderRankCacheLike,
  FolderRankList,
  FolderRankScoreEntry,
  LinkRankData,
} from "../model/LinkRank";
import type { LinkRankIndex } from "./LinkRankIndex";

const MIN_FILES_PER_FOLDER = 20;
const MAX_FILES_PER_FOLDER = 2000;
const MAX_CACHED_LISTS = 512;
const MAX_LIST_SIZE = 500;
const TOP_K = 1000;

type CachedList = FolderRankList & {
  builtMs: number;
  buildTimeMs: number;
};

type FolderQualification = {
  qualified: boolean;
  version: number;
};

type VaultSummary = {
  version: number;
  structureEpoch: number;
  direct: Map<string, number>;
  nonLeaf: Set<string>;
};

export class FolderRankCache implements FolderRankCacheLike {
  private lists = new Map<string, CachedList>();
  private qualifications = new Map<string, FolderQualification>();
  private lastLimitingFolder?: string;
  private summary?: VaultSummary;
  private structureEpoch = 0;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private builds = 0;
  private lastBuildTimeMs = 0;

  constructor(
    private app: App,
    private rankIndex: LinkRankIndex,
  ) {}

  getList(
    currentFilePath: string,
    limitingFolder: string,
    rankData: LinkRankData,
  ): FolderRankList | undefined {
    if (limitingFolder === "") {
      this.misses++;
      return undefined;
    }

    if (this.lastLimitingFolder !== limitingFolder) {
      this.lists.clear();
      this.lastLimitingFolder = limitingFolder;
    }

    const folder = getParentFolder(currentFilePath);
    if (!isWithinFolder(folder, limitingFolder)) {
      this.misses++;
      return undefined;
    }

    this.ensureSummary();
    const qualification = this.qualifications.get(folder);
    if (!qualification?.qualified) {
      this.misses++;
      return undefined;
    }

    // Caller contract: the list contents come from the caller-supplied
    // rankData, but the cache key is (folder, LinkRankIndex version). This is
    // safe today because callers fetch rankData via getRankData in the same
    // synchronous pass that reads the version. A future caller that holds the
    // option bag across passes must re-fetch rankData or clear the cache.
    const cached = this.lists.get(folder);
    const currentGlobalVersion = this.rankIndex.currentVersion;
    if (
      cached &&
      cached.builtForLimitingFolder === limitingFolder &&
      cached.globalVersion === currentGlobalVersion
    ) {
      // Refresh recency: move to the end of the Map.
      this.lists.delete(folder);
      this.lists.set(folder, cached);
      this.hits++;
      return cached;
    }

    this.misses++;
    return this.buildList(folder, limitingFolder, rankData);
  }

  bumpStructure(): void {
    this.structureEpoch++;
  }

  primeSummary(): void {
    this.ensureSummary();
  }

  invalidate(): void {
    this.lists.clear();
    this.qualifications.clear();
    this.summary = undefined;
    this.lastLimitingFolder = undefined;
  }

  get stats(): {
    hits: number;
    misses: number;
    evictions: number;
    builds: number;
    cachedLists: number;
    lastBuildTimeMs: number;
  } {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      builds: this.builds,
      cachedLists: this.lists.size,
      lastBuildTimeMs: this.lastBuildTimeMs,
    };
  }

  private ensureSummary(): void {
    const currentVersion = this.rankIndex.currentVersion;
    const structureEpoch = this.structureEpoch;
    if (
      this.summary?.version === currentVersion &&
      this.summary?.structureEpoch === structureEpoch
    ) {
      return;
    }

    const direct = new Map<string, number>();
    const nonLeaf = new Set<string>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const parent = getParentFolder(file.path);
      direct.set(parent, (direct.get(parent) ?? 0) + 1);

      // Mark every strict ancestor of the file's parent as non-leaf.
      const parts = parent.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        nonLeaf.add(ancestor);
      }
    }

    this.summary = {
      version: currentVersion,
      structureEpoch,
      direct,
      nonLeaf,
    };

    for (const [folder, count] of direct) {
      const qualified =
        !nonLeaf.has(folder) &&
        count >= MIN_FILES_PER_FOLDER &&
        count <= MAX_FILES_PER_FOLDER;
      // The root folder ("") can be qualified here, but getList short-circuits
      // both an empty limitingFolder and folders outside the limitingFolder, so
      // mis-qualifying root as a leaf is harmless.
      this.qualifications.set(folder, { qualified, version: currentVersion });
    }
  }

  private buildList(
    folder: string,
    limitingFolder: string,
    rankData: LinkRankData,
  ): FolderRankList {
    const start = performance.now();

    const resolvedScores = this.buildScoreMap(
      rankData.targetToSourceFolders,
      folder,
      limitingFolder,
    );
    const unresolvedScores = this.buildScoreMap(
      rankData.unresolvedNameToSourceFolders,
      folder,
      limitingFolder,
    );

    const builtMs = Date.now();
    const buildTimeMs = performance.now() - start;

    // The version stamp guards staleness; the list contents still depend on the
    // caller-supplied rankData (see the contract note in getList).
    const list: CachedList = {
      folder,
      builtForLimitingFolder: limitingFolder,
      globalVersion: this.rankIndex.currentVersion,
      resolvedScores,
      unresolvedScores,
      builtMs,
      buildTimeMs,
    };

    this.lists.set(folder, list);
    this.builds++;
    this.lastBuildTimeMs = buildTimeMs;

    while (this.lists.size > MAX_CACHED_LISTS) {
      const firstKey = this.lists.keys().next().value as string;
      this.lists.delete(firstKey);
      this.evictions++;
    }

    return list;
  }

  private buildScoreMap(
    sourceFoldersByKey: Map<string, Map<string, number>>,
    folder: string,
    limitingFolder: string,
  ): Map<string, FolderRankScoreEntry> {
    const entries: Array<[string, FolderProximityScore]> = [];
    const normalizedLimitingFolder = normalizeFolderPath(limitingFolder);

    // Early-out mirrors calculateFolderProximityFromFolder's out-of-limit guard.
    if (!isWithinFolder(folder, normalizedLimitingFolder)) {
      return new Map();
    }

    // Folder-level distance depends only on (currentFolder, sourceFolder,
    // limitingFolder), not on the target. Memoize once per buildList; with 232
    // distinct folders this replaces ~10k redundant folder visits.
    const levelByFolder = new Map<string, number>();

    for (const [key, sourceFolders] of sourceFoldersByKey) {
      let bestScore: FolderProximityScore = {
        level: 999,
        frequency: 0,
        score: 0,
      };
      let bestFolder = "";

      for (const [sourceFolder, frequency] of sourceFolders) {
        if (!isWithinFolder(sourceFolder, normalizedLimitingFolder)) {
          continue;
        }
        let level = levelByFolder.get(sourceFolder);
        if (level === undefined) {
          level = calculateFolderLevel(
            folder,
            sourceFolder,
            normalizedLimitingFolder,
          );
          levelByFolder.set(sourceFolder, level);
        }
        const score = frequency / (level + 1);
        if (
          score > bestScore.score ||
          (score === bestScore.score &&
            score > 0 &&
            (level < bestScore.level ||
              (level === bestScore.level && sourceFolder < bestFolder)))
        ) {
          bestScore = { level, frequency, score };
          bestFolder = sourceFolder;
        }
      }

      if (bestScore.score > 0) {
        entries.push([key, bestScore]);
      }
    }

    entries.sort((a, b) => {
      const [, scoreA] = a;
      const [, scoreB] = b;
      if (scoreB.score !== scoreA.score) {
        return scoreB.score - scoreA.score;
      }
      if (scoreA.level !== scoreB.level) {
        return scoreA.level - scoreB.level;
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    const trimmed = entries.slice(0, MAX_LIST_SIZE);
    const result = new Map<string, FolderRankScoreEntry>();
    for (let i = 0; i < trimmed.length; i++) {
      const [key, score] = trimmed[i];
      result.set(key, {
        level: score.level,
        frequency: score.frequency,
        score: score.score,
        rank: i < TOP_K ? i + 1 : undefined,
      });
    }

    return result;
  }
}

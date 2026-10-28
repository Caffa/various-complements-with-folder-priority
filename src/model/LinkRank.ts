import type { FolderProximityScore } from "./FolderProximity";
import type { InternalLinkWord, Word } from "./Word";

export type LinkRankData = {
  builtForFilePath: string | null;
  builtForLimitingFolder: string;
  currentFileTargets: Map<string, number>;
  currentFileUnresolvedNames: Map<string, number>;
  targetToSourceFolders: Map<string, Map<string, number>>;
  unresolvedNameToSourceFolders: Map<
    string /*lowercased link name*/,
    Map<string /*source folder*/, number>
  >;
};

export type LinkRank = {
  fileTier: boolean;
  folderProximity?: FolderProximityScore;
  rank?: number;
};

export type FolderRankScoreEntry = FolderProximityScore & { rank?: number };

export type FolderRankList = {
  folder: string;
  builtForLimitingFolder: string;
  globalVersion: number;
  resolvedScores: Map<string, FolderRankScoreEntry>;
  unresolvedScores: Map<string, FolderRankScoreEntry>;
};

export interface FolderRankCacheLike {
  getList(
    currentFilePath: string,
    limitingFolder: string,
    rankData: LinkRankData,
  ): FolderRankList | undefined;
}

export type FolderPriorityOption = {
  enabled: boolean;
  currentFilePath: string | null;
  limitingFolder: string;
  rankData?: LinkRankData;
  folderRankCache?: FolderRankCacheLike;
  cachedList?: FolderRankList;
};

function resolveTarget(word: InternalLinkWord): string | undefined {
  return word.createdPath ?? word.aliasMeta?.origin;
}

export function computeLinkRank(
  word: InternalLinkWord,
  option: FolderPriorityOption,
): LinkRank {
  if ((word as any)._rankPrecomputed === true) {
    return {
      fileTier: (word as any).fileTier ?? false,
      folderProximity: (word as any).folderProximity,
      rank: (word as any).linkRank,
    };
  }

  const rankData = option.rankData;
  if (!rankData) {
    return { fileTier: false };
  }

  if (word.phantom) {
    const fileTier =
      typeof word.fileTier === "boolean"
        ? word.fileTier
        : rankData.currentFileUnresolvedNames.has(word.value.toLowerCase());

    let folderProximity: FolderProximityScore | undefined;
    let rank: number | undefined;
    if (
      option.enabled &&
      option.limitingFolder !== "" &&
      option.currentFilePath !== null
    ) {
      // Same memoized-list lookup as the resolved path; list keys are a subset
      // of unresolvedNameToSourceFolders keys.
      const list =
        option.cachedList ??
        option.folderRankCache?.getList(
          option.currentFilePath,
          option.limitingFolder,
          rankData,
        );
      const key = word.value.toLowerCase();
      const entry = list?.unresolvedScores.get(key);
      if (entry) {
        folderProximity = {
          level: entry.level,
          frequency: entry.frequency,
          score: entry.score,
        };
        rank = entry.rank;
      }
    }

    return { fileTier, folderProximity, rank };
  }

  const target = resolveTarget(word);
  if (target === undefined) {
    return { fileTier: false };
  }

  const fileTier =
    typeof word.fileTier === "boolean"
      ? word.fileTier
      : rankData.currentFileTargets.has(target);

  let folderProximity: FolderProximityScore | undefined;
  let rank: number | undefined;
  if (
    option.enabled &&
    option.limitingFolder !== "" &&
    option.currentFilePath !== null
  ) {
    // The per-folder list is consulted first. Its keys are a subset of the
    // inversion-map keys (only top-2000 scored targets with score > 0), so a
    // missing cache entry simply means the target was not stored. Builds are
    // memoized per (folder, LinkRankIndex version) inside getList.
    const list =
      option.cachedList ??
      option.folderRankCache?.getList(
        option.currentFilePath,
        option.limitingFolder,
        rankData,
      );
    const entry = list?.resolvedScores.get(target);
    if (entry) {
      folderProximity = {
        level: entry.level,
        frequency: entry.frequency,
        score: entry.score,
      };
      rank = entry.rank;
    }
  }

  return { fileTier, folderProximity, rank };
}

export function getOrComputeLinkRank(
  word: Word,
  option: FolderPriorityOption,
  cache: Map<Word, LinkRank>,
): LinkRank | undefined {
  if (word.type !== "internalLink") {
    return undefined;
  }

  if (!cache.has(word)) {
    cache.set(word, computeLinkRank(word, option));
  }
  return cache.get(word);
}

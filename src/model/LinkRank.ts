import type { FolderProximityScore } from "./FolderProximity";
import { calculateFolderProximity } from "./FolderProximity";
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
};

export type FolderPriorityOption = {
  enabled: boolean;
  currentFilePath: string | null;
  limitingFolder: string;
  rankData?: LinkRankData;
};

function resolveTarget(word: InternalLinkWord): string | undefined {
  return word.createdPath ?? word.aliasMeta?.origin;
}

export function computeLinkRank(
  word: InternalLinkWord,
  option: FolderPriorityOption,
): LinkRank {
  const rankData = option.rankData;
  if (!rankData) {
    return { fileTier: false };
  }

  if (word.phantom) {
    const fileTier = rankData.currentFileUnresolvedNames.has(
      word.value.toLowerCase(),
    );

    let folderProximity: FolderProximityScore | undefined;
    if (
      option.enabled &&
      option.limitingFolder !== "" &&
      option.currentFilePath !== null
    ) {
      const sourceFolders = rankData.unresolvedNameToSourceFolders.get(
        word.value.toLowerCase(),
      );
      if (sourceFolders) {
        folderProximity = calculateFolderProximity(
          sourceFolders,
          option.currentFilePath,
          option.limitingFolder,
        );
      }
    }

    return { fileTier, folderProximity };
  }

  const target = resolveTarget(word);
  if (target === undefined) {
    return { fileTier: false };
  }

  const fileTier = rankData.currentFileTargets.has(target);

  let folderProximity: FolderProximityScore | undefined;
  if (
    option.enabled &&
    option.limitingFolder !== "" &&
    option.currentFilePath !== null
  ) {
    const sourceFolders = rankData.targetToSourceFolders.get(target);
    if (sourceFolders) {
      folderProximity = calculateFolderProximity(
        sourceFolders,
        option.currentFilePath,
        option.limitingFolder,
      );
    }
  }

  return { fileTier, folderProximity };
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

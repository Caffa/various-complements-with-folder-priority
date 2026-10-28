/**
 * Calculates folder proximity scores for internal link prioritization.
 *
 * When writing in a story folder, links that appear frequently in nearby
 * folders should rank higher than links from distant folders.
 */

export interface FolderProximityScore {
  /** Distance from current file: 0 = same file, 1 = same folder, etc. */
  level: number;
  /** How many times this link appears at this folder level */
  frequency: number;
  /** Combined score: frequency / (level + 1) */
  score: number;
}

/**
 * Calculate the folder level distance between current folder and a link's source folders.
 *
 * @param linkSourceFolders - Folders where this link appears (folder -> count)
 * @param currentFolder - Folder the current file lives in
 * @param limitingFolder - Root folder to stop at (e.g., "Novel")
 * @returns The best (lowest) proximity score across all source folders
 */
export function calculateFolderProximityFromFolder(
  linkSourceFolders: Map<string, number>,
  currentFolder: string,
  limitingFolder: string,
): FolderProximityScore {
  const normalizedLimitingFolder = normalizeFolderPath(limitingFolder);

  // If current file is outside limiting folder, return default
  if (!isWithinFolder(currentFolder, normalizedLimitingFolder)) {
    return { level: 999, frequency: 0, score: 0 };
  }

  let bestScore: FolderProximityScore = { level: 999, frequency: 0, score: 0 };
  let bestFolder = "";

  for (const [folder, frequency] of linkSourceFolders) {
    // Skip if folder is outside limiting folder
    if (!isWithinFolder(folder, normalizedLimitingFolder)) {
      continue;
    }

    const level = calculateFolderLevel(
      currentFolder,
      folder,
      normalizedLimitingFolder,
    );
    const score = frequency / (level + 1);

    if (
      score > bestScore.score ||
      (score === bestScore.score &&
        score > 0 &&
        (level < bestScore.level ||
          (level === bestScore.level && folder < bestFolder)))
    ) {
      bestScore = { level, frequency, score };
      bestFolder = folder;
    }
  }

  return bestScore;
}

/**
 * Convenience wrapper: derives the current folder from a file path and then
 * delegates to {@link calculateFolderProximityFromFolder}.
 */
export function calculateFolderProximity(
  linkSourceFolders: Map<string, number>,
  currentFilePath: string,
  limitingFolder: string,
): FolderProximityScore {
  return calculateFolderProximityFromFolder(
    linkSourceFolders,
    getParentFolder(currentFilePath),
    limitingFolder,
  );
}

/**
 * Calculate the folder level distance between two folders within the limiting folder.
 *
 * Level 0 = same folder
 * Level 1 = parent folder or immediate child
 * Level 2 = grandparent or grandchild
 * etc.
 *
 * For siblings/cousins, level = sum of distances from common ancestor
 */
export function calculateFolderLevel(
  currentFolder: string,
  targetFolder: string,
  limitingFolder: string,
): number {
  if (currentFolder === targetFolder) return 0;

  const currentParts = currentFolder.split("/").filter(Boolean);
  const targetParts = targetFolder.split("/").filter(Boolean);

  // Find common prefix length
  let commonLength = 0;
  for (let i = 0; i < Math.min(currentParts.length, targetParts.length); i++) {
    if (currentParts[i] === targetParts[i]) {
      commonLength++;
    } else {
      break;
    }
  }

  // Calculate distances from common ancestor
  const currentDepthFromCommon = currentParts.length - commonLength;
  const targetDepthFromCommon = targetParts.length - commonLength;

  // If target is an ancestor (inside current folder's hierarchy)
  if (
    targetParts.length < currentParts.length &&
    targetParts.every((part, i) => currentParts[i] === part)
  ) {
    return currentDepthFromCommon;
  }

  // For siblings/cousins, sum the distances
  // This makes siblings (level 2) rank lower than ancestors (level 1)
  return currentDepthFromCommon + targetDepthFromCommon;
}

export function getParentFolder(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

export function normalizeFolderPath(folder: string): string {
  return folder.replace(/^[\/]+|[\/]+$/g, "");
}

export function isWithinFolder(path: string, parentFolder: string): boolean {
  const normalizedPath = normalizeFolderPath(path);
  const normalizedParent = normalizeFolderPath(parentFolder);
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(normalizedParent + "/")
  );
}

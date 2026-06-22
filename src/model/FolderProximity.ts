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

export interface LinkFolderInfo {
  /** The link path (e.g., "Characters/John.md") */
  linkPath: string;
  /** Map of folder paths to appearance counts */
  folderFrequency: Map<string, number>;
}

/**
 * Calculate the folder level distance between current file and a link's source folders.
 *
 * @param linkSourceFolders - Folders where this link appears (folder -> count)
 * @param currentFilePath - Path of the file being edited
 * @param limitingFolder - Root folder to stop at (e.g., "Novel")
 * @returns The best (lowest) proximity score across all source folders
 */
export function calculateFolderProximity(
  linkSourceFolders: Map<string, number>,
  currentFilePath: string,
  limitingFolder: string,
): FolderProximityScore {
  const currentFolder = getParentFolder(currentFilePath);
  const normalizedLimitingFolder = normalizeFolderPath(limitingFolder);

  // If current file is outside limiting folder, return default
  if (!isWithinFolder(currentFolder, normalizedLimitingFolder)) {
    return { level: 999, frequency: 0, score: 0 };
  }

  let bestScore: FolderProximityScore = { level: 999, frequency: 0, score: 0 };

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

    if (score > bestScore.score) {
      bestScore = { level, frequency, score };
    }
  }

  return bestScore;
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
function calculateFolderLevel(
  currentFolder: string,
  targetFolder: string,
  limitingFolder: string,
): number {
  if (currentFolder === targetFolder) return 0;

  const currentParts = currentFolder.split("/").filter(Boolean);
  const targetParts = targetFolder.split("/").filter(Boolean);

  // Find common prefix length
  let commonLength = 0;
  for (
    let i = 0;
    i < Math.min(currentParts.length, targetParts.length);
    i++
  ) {
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

function getParentFolder(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

function normalizeFolderPath(folder: string): string {
  return folder.replace(/^[\/]+|[\/]+$/g, "");
}

function isWithinFolder(path: string, parentFolder: string): boolean {
  const normalizedPath = normalizeFolderPath(path);
  const normalizedParent = normalizeFolderPath(parentFolder);
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(normalizedParent + "/")
  );
}
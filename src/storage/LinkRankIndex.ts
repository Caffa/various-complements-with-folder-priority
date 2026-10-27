import type { App } from "obsidian";
import type { LinkRankData } from "../model/LinkRank";

export class LinkRankIndex {
  private cached?: LinkRankData;
  buildCalls = 0;

  constructor(private app: App) {}

  getRankData(
    currentFilePath: string | null,
    limitingFolder: string,
  ): LinkRankData {
    if (
      this.cached &&
      this.cached.builtForFilePath === currentFilePath &&
      this.cached.builtForLimitingFolder === limitingFolder
    ) {
      return this.cached;
    }

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks;

    const targetToSourceFolders = new Map<string, Map<string, number>>();
    if (limitingFolder !== "") {
      for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
        const sourceFolder = this.getParentFolder(sourcePath);
        if (!this.isWithinLimitingFolder(sourceFolder, limitingFolder)) {
          continue;
        }
        for (const [targetPath, count] of Object.entries(targets)) {
          let folderMap = targetToSourceFolders.get(targetPath);
          if (folderMap === undefined) {
            folderMap = new Map<string, number>();
            targetToSourceFolders.set(targetPath, folderMap);
          }
          folderMap.set(
            sourceFolder,
            (folderMap.get(sourceFolder) ?? 0) + count,
          );
        }
      }
    }

    const currentFileTargets = new Map<string, number>();
    if (currentFilePath !== null) {
      const targets = resolvedLinks[currentFilePath];
      if (targets !== undefined) {
        for (const [target, count] of Object.entries(targets)) {
          currentFileTargets.set(target, count);
        }
      }
    }

    const currentFileUnresolvedNames = new Map<string, number>();
    if (currentFilePath !== null) {
      const unresolved = unresolvedLinks[currentFilePath];
      if (unresolved !== undefined) {
        for (const [name, count] of Object.entries(unresolved)) {
          currentFileUnresolvedNames.set(name.toLowerCase(), count);
        }
      }
    }

    this.cached = {
      builtForFilePath: currentFilePath,
      builtForLimitingFolder: limitingFolder,
      currentFileTargets,
      currentFileUnresolvedNames,
      targetToSourceFolders,
    };
    this.buildCalls++;
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private getParentFolder(filePath: string): string {
    const parts = filePath.split("/");
    parts.pop();
    return parts.join("/");
  }

  private isWithinLimitingFolder(
    path: string,
    limitingFolder: string,
  ): boolean {
    const normalizedPath = this.normalizeFolderPath(path);
    const normalizedLimit = this.normalizeFolderPath(limitingFolder);
    return (
      normalizedPath === normalizedLimit ||
      normalizedPath.startsWith(normalizedLimit + "/")
    );
  }

  private normalizeFolderPath(folder: string): string {
    return folder.replace(/^[\/]+|[\/]+$/g, "");
  }
}

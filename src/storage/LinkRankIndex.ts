import type { App } from "obsidian";
import type { LinkRankData } from "../model/LinkRank";

export class LinkRankIndex {
  private global?: {
    builtForLimitingFolder: string;
    targetToSourceFolders: Map<string, Map<string, number>>;
    unresolvedNameToSourceFolders: Map<string, Map<string, number>>;
    sourceContributions: Map<
      string,
      { resolved: Map<string, number>; unresolved: Map<string, number> }
    >;
    version: number;
  };
  private filePart?: {
    builtForFilePath: string | null;
    currentFileTargets: Map<string, number>;
    currentFileUnresolvedNames: Map<string, number>;
    version: number;
  };
  private versionEpoch = 0;
  private filePartDirty = false;
  private staleSources: Set<string> = new Set();
  private staleSourceSnapshots = new Map<
    string,
    | {
        resolved: ReadonlyMap<string, number>;
        unresolved: ReadonlyMap<string, number>;
      }
    | undefined
  >();
  private lastReturned?: {
    data: LinkRankData;
    globalVersion: number;
    filePartVersion: number;
    filePath: string | null;
  };
  buildCalls = 0;
  lastBuildMs?: number;

  get currentVersion(): number {
    return this.global?.version ?? -1;
  }

  constructor(private app: App) {}

  getRankData(
    currentFilePath: string | null,
    limitingFolder: string,
  ): LinkRankData {
    if (!this.global || this.global.builtForLimitingFolder !== limitingFolder) {
      this.rebuild(limitingFolder);
    } else if (this.staleSources.size > 0 && limitingFolder !== "") {
      this.applyStaleSources(limitingFolder);
    } else if (this.staleSources.size > 0) {
      this.staleSources.clear();
      this.filePartDirty = true;
    }
    const global = this.global!;

    if (
      !this.filePart ||
      this.filePart.builtForFilePath !== currentFilePath ||
      this.filePartDirty
    ) {
      this.rebuildFilePart(currentFilePath);
    }
    const filePart = this.filePart!;

    if (
      this.lastReturned &&
      this.lastReturned.globalVersion === global.version &&
      this.lastReturned.filePartVersion === filePart.version &&
      this.lastReturned.filePath === currentFilePath
    ) {
      return this.lastReturned.data;
    }

    const data: LinkRankData = {
      builtForFilePath: currentFilePath,
      builtForLimitingFolder: limitingFolder,
      currentFileTargets: filePart.currentFileTargets,
      currentFileUnresolvedNames: filePart.currentFileUnresolvedNames,
      targetToSourceFolders: global.targetToSourceFolders,
      unresolvedNameToSourceFolders: global.unresolvedNameToSourceFolders,
    };
    this.lastReturned = {
      data,
      globalVersion: global.version,
      filePartVersion: filePart.version,
      filePath: currentFilePath,
    };
    return data;
  }

  invalidate(): void {
    this.global = undefined;
    this.filePart = undefined;
    this.filePartDirty = false;
    this.staleSources.clear();
    this.staleSourceSnapshots.clear();
    this.lastReturned = undefined;
  }

  markSourceStale(path: string): void {
    if (!this.global) {
      return;
    }
    this.snapshotSourceContributions(path);
    this.removeSourceContributions(path);
    this.staleSources.add(path);
    if (this.filePart?.builtForFilePath === path) {
      this.filePartDirty = true;
    }
  }

  onRename(oldPath: string, newPath: string): void {
    if (!this.global) {
      return;
    }
    this.snapshotSourceContributions(oldPath);
    this.removeSourceContributions(oldPath);
    this.staleSources.add(newPath);
    this.snapshotSourceContributions(newPath);
    if (this.filePart?.builtForFilePath === oldPath) {
      this.filePartDirty = true;
    }
  }

  onDelete(path: string): void {
    if (!this.global) {
      return;
    }
    const hadContribution = this.global.sourceContributions.has(path);
    this.removeSourceContributions(path);
    if (this.filePart?.builtForFilePath === path) {
      this.filePartDirty = true;
    }
    // A deleted file's contributions are removed once (no re-apply). Bump the
    // global version only if it actually contributed, so caches stay valid when
    // deleting a linkless note.
    if (hadContribution) {
      this.global.version = ++this.versionEpoch;
      this.staleSources.clear();
      this.staleSourceSnapshots.clear();
      this.lastReturned = undefined;
    }
  }

  private snapshotSourceContributions(path: string): void {
    if (!this.global || this.staleSourceSnapshots.has(path)) {
      return;
    }
    const current = this.global.sourceContributions.get(path);
    this.staleSourceSnapshots.set(
      path,
      current
        ? {
            resolved: current.resolved,
            unresolved: current.unresolved,
          }
        : undefined,
    );
  }

  private rebuild(limitingFolder: string): void {
    const start = performance.now();
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks;

    const targetToSourceFolders = new Map<string, Map<string, number>>();
    const unresolvedNameToSourceFolders = new Map<
      string,
      Map<string, number>
    >();
    const sourceContributions = new Map<
      string,
      { resolved: Map<string, number>; unresolved: Map<string, number> }
    >();

    if (limitingFolder !== "") {
      for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
        const sourceFolder = this.getParentFolder(sourcePath);
        if (!this.isWithinLimitingFolder(sourceFolder, limitingFolder)) {
          continue;
        }
        const resolved = new Map<string, number>();
        sourceContributions.set(sourcePath, {
          resolved,
          unresolved: new Map(),
        });
        for (const [targetPath, count] of Object.entries(targets)) {
          resolved.set(targetPath, count);
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

      for (const [sourcePath, unresolved] of Object.entries(unresolvedLinks)) {
        const sourceFolder = this.getParentFolder(sourcePath);
        if (!this.isWithinLimitingFolder(sourceFolder, limitingFolder)) {
          continue;
        }
        let contrib = sourceContributions.get(sourcePath);
        if (contrib === undefined) {
          contrib = { resolved: new Map(), unresolved: new Map() };
          sourceContributions.set(sourcePath, contrib);
        }
        for (const [name, count] of Object.entries(unresolved)) {
          const lowerName = name.toLowerCase();
          contrib.unresolved.set(lowerName, count);
          let folderMap = unresolvedNameToSourceFolders.get(lowerName);
          if (folderMap === undefined) {
            folderMap = new Map<string, number>();
            unresolvedNameToSourceFolders.set(lowerName, folderMap);
          }
          folderMap.set(
            sourceFolder,
            (folderMap.get(sourceFolder) ?? 0) + count,
          );
        }
      }
    }

    this.global = {
      builtForLimitingFolder: limitingFolder,
      targetToSourceFolders,
      unresolvedNameToSourceFolders,
      sourceContributions,
      version: ++this.versionEpoch,
    };
    this.buildCalls++;
    this.lastBuildMs = performance.now() - start;
    this.staleSources.clear();
    this.staleSourceSnapshots.clear();
    this.filePartDirty = true;
  }

  private applyStaleSources(limitingFolder: string): void {
    if (this.staleSources.size === 0 || !this.global) {
      return;
    }
    if (limitingFolder === "") {
      this.staleSources.clear();
      this.staleSourceSnapshots.clear();
      this.filePartDirty = true;
      return;
    }

    const MAX_DIFF_TARGETS = 5000;
    if (this.staleSources.size > MAX_DIFF_TARGETS) {
      this.rebuild(limitingFolder);
      return;
    }

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks;

    for (const sourcePath of this.staleSources) {
      const resolvedCount = Object.keys(resolvedLinks[sourcePath] ?? {}).length;
      const unresolvedCount = Object.keys(
        unresolvedLinks[sourcePath] ?? {},
      ).length;
      if (
        resolvedCount > MAX_DIFF_TARGETS ||
        unresolvedCount > MAX_DIFF_TARGETS
      ) {
        this.rebuild(limitingFolder);
        return;
      }
    }

    for (const sourcePath of this.staleSources) {
      this.removeSourceContributions(sourcePath);

      const sourceFolder = this.getParentFolder(sourcePath);
      const withinLimit =
        limitingFolder === "" ||
        this.isWithinLimitingFolder(sourceFolder, limitingFolder);
      if (!withinLimit) {
        continue;
      }

      const resolved = resolvedLinks[sourcePath];
      const unresolved = unresolvedLinks[sourcePath];
      if (!resolved && !unresolved) {
        continue;
      }

      const contrib = {
        resolved: new Map<string, number>(),
        unresolved: new Map<string, number>(),
      };
      this.global.sourceContributions.set(sourcePath, contrib);

      if (resolved) {
        for (const [targetPath, count] of Object.entries(resolved)) {
          contrib.resolved.set(targetPath, count);
          let folderMap = this.global.targetToSourceFolders.get(targetPath);
          if (folderMap === undefined) {
            folderMap = new Map<string, number>();
            this.global.targetToSourceFolders.set(targetPath, folderMap);
          }
          folderMap.set(
            sourceFolder,
            (folderMap.get(sourceFolder) ?? 0) + count,
          );
        }
      }

      if (unresolved) {
        for (const [name, count] of Object.entries(unresolved)) {
          const lowerName = name.toLowerCase();
          contrib.unresolved.set(lowerName, count);
          let folderMap =
            this.global.unresolvedNameToSourceFolders.get(lowerName);
          if (folderMap === undefined) {
            folderMap = new Map<string, number>();
            this.global.unresolvedNameToSourceFolders.set(lowerName, folderMap);
          }
          folderMap.set(
            sourceFolder,
            (folderMap.get(sourceFolder) ?? 0) + count,
          );
        }
      }
    }

    this.staleSources.clear();
    this.filePartDirty = true;

    // Only bump the global version if at least one stale source actually
    // changed the link data it contributes. If the live metadataCache matches
    // the pre-removal snapshot for every stale source, folder caches keyed on
    // this version can stay valid — this is the common case during prose typing
    // (content changes, links do not).
    // Renames that move a source in/out of the limiting folder, or create/delete
    // a source, naturally count as changes because the stored contribution goes
    // from present/non-empty to absent (or vice versa).
    let changed = false;
    for (const [path, snapshot] of this.staleSourceSnapshots) {
      const current = this.global.sourceContributions.get(path);
      if (!this.contributionsEqual(snapshot, current)) {
        changed = true;
        break;
      }
    }
    this.staleSourceSnapshots.clear();

    if (changed) {
      this.global.version = ++this.versionEpoch;
    }
  }

  private contributionsEqual(
    a:
      | {
          resolved: ReadonlyMap<string, number>;
          unresolved: ReadonlyMap<string, number>;
        }
      | undefined,
    b:
      | {
          resolved: ReadonlyMap<string, number>;
          unresolved: ReadonlyMap<string, number>;
        }
      | undefined,
  ): boolean {
    if (a === b) {
      return true;
    }
    if (a === undefined || b === undefined) {
      return false;
    }
    if (
      a.resolved.size !== b.resolved.size ||
      a.unresolved.size !== b.unresolved.size
    ) {
      return false;
    }
    for (const [key, count] of a.resolved) {
      if (b.resolved.get(key) !== count) {
        return false;
      }
    }
    for (const [key, count] of a.unresolved) {
      if (b.unresolved.get(key) !== count) {
        return false;
      }
    }
    return true;
  }

  private removeSourceContributions(path: string): void {
    if (!this.global) {
      return;
    }
    const old = this.global.sourceContributions.get(path);
    if (!old) {
      return;
    }

    const sourceFolder = this.getParentFolder(path);
    const limitingFolder = this.global.builtForLimitingFolder;
    const withinLimit =
      limitingFolder === "" ||
      this.isWithinLimitingFolder(sourceFolder, limitingFolder);
    if (!withinLimit) {
      this.global.sourceContributions.delete(path);
      return;
    }

    for (const [targetPath, count] of old.resolved) {
      const folderMap = this.global.targetToSourceFolders.get(targetPath);
      if (folderMap) {
        const newCount = (folderMap.get(sourceFolder) ?? 0) - count;
        if (newCount <= 0) {
          folderMap.delete(sourceFolder);
        } else {
          folderMap.set(sourceFolder, newCount);
        }
        if (folderMap.size === 0) {
          this.global.targetToSourceFolders.delete(targetPath);
        }
      }
    }

    for (const [lowerName, count] of old.unresolved) {
      const folderMap =
        this.global.unresolvedNameToSourceFolders.get(lowerName);
      if (folderMap) {
        const newCount = (folderMap.get(sourceFolder) ?? 0) - count;
        if (newCount <= 0) {
          folderMap.delete(sourceFolder);
        } else {
          folderMap.set(sourceFolder, newCount);
        }
        if (folderMap.size === 0) {
          this.global.unresolvedNameToSourceFolders.delete(lowerName);
        }
      }
    }

    this.global.sourceContributions.delete(path);
  }

  private rebuildFilePart(currentFilePath: string | null): void {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks;

    const currentFileTargets = new Map<string, number>();
    const currentFileUnresolvedNames = new Map<string, number>();
    if (currentFilePath !== null) {
      const targets = resolvedLinks[currentFilePath];
      if (targets !== undefined) {
        for (const [target, count] of Object.entries(targets)) {
          currentFileTargets.set(target, count);
        }
      }
      const unresolved = unresolvedLinks[currentFilePath];
      if (unresolved !== undefined) {
        for (const [name, count] of Object.entries(unresolved)) {
          currentFileUnresolvedNames.set(name.toLowerCase(), count);
        }
      }
    }

    this.filePart = {
      builtForFilePath: currentFilePath,
      currentFileTargets,
      currentFileUnresolvedNames,
      version: (this.filePart?.version ?? 0) + 1,
    };
    this.filePartDirty = false;
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

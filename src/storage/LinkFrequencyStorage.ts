import { App, TFile, TFolder } from "obsidian";
import type { LinkFolderInfo } from "../model/FolderProximity";

/**
 * Tracks how often each internal link appears in different folders.
 *
 * This is used for folder-based prioritization - links that appear frequently
 * in the current story folder should rank higher than links from other stories.
 *
 * Performance strategy:
 * - Build incrementally on-demand
 * - Cache results per folder
 * - Update on file modification
 */
export class LinkFrequencyStorage {
  /** linkPath -> { folderPath -> count } */
  private linkFolderFrequency: Map<string, Map<string, number>> = new Map();

  /** Folders that have been indexed */
  private indexedFolders: Set<string> = new Set();

  /** Files that have been indexed with their link counts */
  private fileLinkCache: Map<string, Map<string, number>> = new Map();

  private limitingFolder: string = "";
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Set the limiting folder for prioritization.
   * Links outside this folder are not prioritized.
   */
  setLimitingFolder(folder: string): void {
    this.limitingFolder = this.normalizePath(folder);
    // Clear cache when limiting folder changes
    this.linkFolderFrequency.clear();
    this.indexedFolders.clear();
    this.fileLinkCache.clear();
  }

  /**
   * Get the current limiting folder.
   */
  getLimitingFolder(): string {
    return this.limitingFolder;
  }

  /**
   * Get folders where a link appears and their frequencies.
   */
  getLinkFolders(linkPath: string): Map<string, number> | undefined {
    return this.linkFolderFrequency.get(linkPath);
  }

  /**
   * Check if a folder has been indexed.
   */
  isFolderIndexed(folderPath: string): boolean {
    return this.indexedFolders.has(this.normalizePath(folderPath));
  }

  /**
   * Index all links in a folder.
   * Uses Obsidian's metadata cache for fast link extraction.
   */
  async indexFolder(folderPath: string): Promise<void> {
    const normalizedPath = this.normalizePath(folderPath);

    if (this.indexedFolders.has(normalizedPath)) {
      return; // Already indexed
    }

    // Check if folder is within limiting folder
    if (!this.isWithinLimitingFolder(normalizedPath)) {
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(folder instanceof TFolder)) {
      return;
    }

    // Index all markdown files in this folder (non-recursive)
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        await this.indexFile(child);
      }
    }

    this.indexedFolders.add(normalizedPath);
  }

  /**
   * Index links in a single file.
   * Uses metadata cache for fast extraction.
   */
  async indexFile(file: TFile): Promise<void> {
    const filePath = file.path;

    // Skip if outside limiting folder
    if (!this.isWithinLimitingFolder(filePath)) {
      return;
    }

    // Skip if already indexed (unless forced)
    if (this.fileLinkCache.has(filePath)) {
      return;
    }

    // Use metadata cache to get links (fast)
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.links) {
      this.fileLinkCache.set(filePath, new Map());
      return;
    }

    const folderPath = this.getParentFolder(filePath);
    const fileLinks: Map<string, number> = new Map();

    for (const link of cache.links) {
      const linkPath = this.resolveLink(link.link, file.path);
      if (!linkPath) continue;

      // Track link frequency in this file
      const currentCount = fileLinks.get(linkPath) || 0;
      fileLinks.set(linkPath, currentCount + 1);

      // Increment frequency for this folder
      if (!this.linkFolderFrequency.has(linkPath)) {
        this.linkFolderFrequency.set(linkPath, new Map());
      }
      const folderMap = this.linkFolderFrequency.get(linkPath)!;
      const currentFolderCount = folderMap.get(folderPath) || 0;
      folderMap.set(folderPath, currentFolderCount + 1);
    }

    this.fileLinkCache.set(filePath, fileLinks);
  }

  /**
   * Remove a file from the index (when deleted or moved).
   */
  removeFile(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const fileLinks = this.fileLinkCache.get(normalizedPath);

    if (!fileLinks) {
      return;
    }

    const folderPath = this.getParentFolder(normalizedPath);

    // Decrement all link frequencies for this file
    for (const [linkPath, count] of fileLinks) {
      const folderMap = this.linkFolderFrequency.get(linkPath);
      if (folderMap) {
        const currentCount = folderMap.get(folderPath) || 0;
        if (currentCount <= count) {
          folderMap.delete(folderPath);
          if (folderMap.size === 0) {
            this.linkFolderFrequency.delete(linkPath);
          }
        } else {
          folderMap.set(folderPath, currentCount - count);
        }
      }
    }

    this.fileLinkCache.delete(normalizedPath);
  }

  /**
   * Update a file's links (re-index after modification).
   */
  async updateFile(file: TFile): Promise<void> {
    this.removeFile(file.path);
    await this.indexFile(file);
  }

  /**
   * Index the folder hierarchy for a given file path.
   * Walks up from the file's folder to the limiting folder.
   */
  async indexFolderHierarchy(filePath: string): Promise<void> {
    const fileFolder = this.getParentFolder(filePath);

    if (!this.isWithinLimitingFolder(fileFolder)) {
      return;
    }

    // Index current folder first (most important)
    await this.indexFolder(fileFolder);

    // Walk up and index parent folders
    let currentFolder = fileFolder;
    while (currentFolder && currentFolder !== this.limitingFolder) {
      const parentFolder = this.getParentFolder(currentFolder);
      if (parentFolder === currentFolder || !parentFolder) break; // Reached root

      await this.indexFolder(parentFolder);
      currentFolder = parentFolder;
    }
  }

  /**
   * Get the total count of links indexed.
   */
  getLinkCount(): number {
    return this.linkFolderFrequency.size;
  }

  /**
   * Get the total count of files indexed.
   */
  getFileCount(): number {
    return this.fileLinkCache.size;
  }

  /**
   * Clear all indexed data.
   */
  clear(): void {
    this.linkFolderFrequency.clear();
    this.indexedFolders.clear();
    this.fileLinkCache.clear();
  }

  // Private helpers

  private normalizePath(path: string): string {
    return path.replace(/^[\/]+|[\/]+$/g, "");
  }

  private getParentFolder(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
  }

  private isWithinLimitingFolder(path: string): boolean {
    if (!this.limitingFolder) return false;

    const normalized = this.normalizePath(path);
    return (
      normalized === this.limitingFolder ||
      normalized.startsWith(this.limitingFolder + "/")
    );
  }

  /**
   * Resolve a link reference to its target path.
   * Uses Obsidian's metadata cache for resolution.
   */
  private resolveLink(
    linkText: string,
    sourcePath: string,
  ): string | null {
    try {
      const file = this.app.metadataCache.getFirstLinkpathDest(
        linkText,
        sourcePath,
      );
      if (file) {
        return file.path;
      }
      // Unresolved link - store the link text as-is
      return linkText;
    } catch {
      return null;
    }
  }
}
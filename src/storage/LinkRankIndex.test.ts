import { describe, expect, it } from "@jest/globals";
import type { App } from "obsidian";
import { LinkRankIndex } from "./LinkRankIndex";

function createApp(
  resolvedLinks: Record<string, Record<string, number>> = {},
  unresolvedLinks: Record<string, Record<string, number>> = {},
): App {
  return {
    metadataCache: {
      resolvedLinks,
      unresolvedLinks,
    },
  } as unknown as App;
}

function mapsEqual<K, V>(a: Map<K, Map<K, V>>, b: Map<K, Map<K, V>>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, innerA] of a) {
    const innerB = b.get(k);
    if (!innerB || innerA.size !== innerB.size) return false;
    for (const [ik, iv] of innerA) {
      if (innerB.get(ik) !== iv) return false;
    }
  }
  return true;
}

function fullRebuildRankData(
  app: App,
  currentFilePath: string | null,
  limitingFolder: string,
): {
  targetToSourceFolders: Map<string, Map<string, number>>;
  unresolvedNameToSourceFolders: Map<string, Map<string, number>>;
  currentFileTargets: Map<string, number>;
  currentFileUnresolvedNames: Map<string, number>;
} {
  const targetToSourceFolders = new Map<string, Map<string, number>>();
  const unresolvedNameToSourceFolders = new Map<string, Map<string, number>>();

  const isWithin = (path: string) => {
    const normalizedPath = path.replace(/^[\/]+|[\/]+$/g, "");
    const normalizedLimit = limitingFolder.replace(/^[\/]+|[\/]+$/g, "");
    return (
      normalizedPath === normalizedLimit ||
      normalizedPath.startsWith(normalizedLimit + "/")
    );
  };
  const parent = (path: string) => {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
  };

  for (const [sourcePath, targets] of Object.entries(
    app.metadataCache.resolvedLinks,
  )) {
    const sourceFolder = parent(sourcePath);
    if (limitingFolder !== "" && !isWithin(sourceFolder)) continue;
    for (const [targetPath, count] of Object.entries(targets)) {
      let folderMap = targetToSourceFolders.get(targetPath);
      if (folderMap === undefined) {
        folderMap = new Map<string, number>();
        targetToSourceFolders.set(targetPath, folderMap);
      }
      folderMap.set(sourceFolder, (folderMap.get(sourceFolder) ?? 0) + count);
    }
  }

  for (const [sourcePath, unresolved] of Object.entries(
    app.metadataCache.unresolvedLinks,
  )) {
    const sourceFolder = parent(sourcePath);
    if (limitingFolder !== "" && !isWithin(sourceFolder)) continue;
    for (const [name, count] of Object.entries(unresolved)) {
      const lowerName = name.toLowerCase();
      let folderMap = unresolvedNameToSourceFolders.get(lowerName);
      if (folderMap === undefined) {
        folderMap = new Map<string, number>();
        unresolvedNameToSourceFolders.set(lowerName, folderMap);
      }
      folderMap.set(sourceFolder, (folderMap.get(sourceFolder) ?? 0) + count);
    }
  }

  const currentFileTargets = new Map<string, number>();
  const currentFileUnresolvedNames = new Map<string, number>();
  if (currentFilePath !== null) {
    const targets = app.metadataCache.resolvedLinks[currentFilePath];
    if (targets) {
      for (const [target, count] of Object.entries(targets)) {
        currentFileTargets.set(target, count);
      }
    }
    const unresolved = app.metadataCache.unresolvedLinks[currentFilePath];
    if (unresolved) {
      for (const [name, count] of Object.entries(unresolved)) {
        currentFileUnresolvedNames.set(name.toLowerCase(), count);
      }
    }
  }

  return {
    targetToSourceFolders,
    unresolvedNameToSourceFolders,
    currentFileTargets,
    currentFileUnresolvedNames,
  };
}

describe("LinkRankIndex", () => {
  it("inverts resolved links, aggregating source folders by count", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
      "Novel/A/Chapter 2.md": { "Characters/John.md": 2 },
    });
    const index = new LinkRankIndex(app);

    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.targetToSourceFolders.get("Characters/John.md")).toStrictEqual(
      new Map([["Novel/A", 3]]),
    );
    expect(index.buildCalls).toBe(1);
  });

  it("memoizes rank data for identical inputs", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
    });
    const index = new LinkRankIndex(app);

    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(first).toBe(second);
    expect(index.buildCalls).toBe(1);
  });

  it("does not bump buildCalls when only the current file path changes", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
      "Novel/A/Chapter 2.md": { "Characters/Jane.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    const second = index.getRankData("Novel/A/Chapter 2.md", "Novel");

    expect(second.currentFileTargets.has("Characters/John.md")).toBe(false);
    expect(second.currentFileTargets.has("Characters/Jane.md")).toBe(true);
    expect(index.buildCalls).toBe(1);
  });

  it("rebuilds after invalidate", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
    });
    const index = new LinkRankIndex(app);

    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    index.invalidate();
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(first).not.toBe(second);
    expect(index.buildCalls).toBe(2);
  });

  it("excludes source folders outside the limiting folder from the folder map", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
      "Resources/B/Chapter 1.md": { "Characters/John.md": 99 },
    });
    const index = new LinkRankIndex(app);

    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.targetToSourceFolders.get("Characters/John.md")).toStrictEqual(
      new Map([["Novel/A", 1]]),
    );
  });

  it("populates file tier data and unresolved inversion even when limiting folder is empty", () => {
    const app = createApp(
      {
        "Novel/A/Chapter 1.md": { "Characters/John.md": 3 },
      },
      {
        "Novel/A/Chapter 1.md": { Phantom: 2 },
      },
    );
    const index = new LinkRankIndex(app);

    const data = index.getRankData("Novel/A/Chapter 1.md", "");

    expect(data.targetToSourceFolders.size).toBe(0);
    expect(data.currentFileTargets.get("Characters/John.md")).toBe(3);
    expect(data.currentFileUnresolvedNames.get("phantom")).toBe(2);
    expect(data.unresolvedNameToSourceFolders.size).toBe(0);
  });

  it("applies stale source changes incrementally", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    (app.metadataCache as any).resolvedLinks = {
      "Novel/A/Chapter 1.md": { "Characters/John.md": 5 },
    };

    index.markSourceStale("Novel/A/Chapter 1.md");
    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.targetToSourceFolders.get("Characters/John.md")).toStrictEqual(
      new Map([["Novel/A", 5]]),
    );
    expect(index.buildCalls).toBe(1);
  });

  it("underflow-deletes empty folder entries when a source is removed", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    (app.metadataCache as any).resolvedLinks = {};

    index.markSourceStale("Novel/A/Chapter 1.md");
    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.targetToSourceFolders.has("Characters/John.md")).toBe(false);
  });

  it("inverts unresolved links by lowercased name", () => {
    const app = createApp(
      {},
      {
        "Novel/A/Chapter 1.md": { Phantom: 2, Another: 1 },
        "Novel/A/Chapter 2.md": { phantom: 3 },
      },
    );
    const index = new LinkRankIndex(app);

    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.unresolvedNameToSourceFolders.get("phantom")).toStrictEqual(
      new Map([["Novel/A", 5]]),
    );
    expect(data.unresolvedNameToSourceFolders.get("another")).toStrictEqual(
      new Map([["Novel/A", 1]]),
    );
  });

  it("forces a full rebuild when the limiting folder changes", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
      "Resources/B/Chapter 1.md": { "Characters/John.md": 99 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    const data = index.getRankData("Novel/A/Chapter 1.md", "Resources");

    expect(index.buildCalls).toBe(2);
    expect(data.targetToSourceFolders.get("Characters/John.md")).toStrictEqual(
      new Map([["Resources/B", 99]]),
    );
  });

  it("falls back to a full rebuild when a single stale source exceeds MAX_DIFF_TARGETS", () => {
    const resolved: Record<string, Record<string, number>> = {};
    const big: Record<string, number> = {};
    for (let i = 0; i < 5001; i++) {
      big[`Characters/${i}.md`] = 1;
    }
    resolved["Novel/A/Chapter 1.md"] = { "Characters/John.md": 1 };

    const app = createApp(resolved);
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    (app.metadataCache as any).resolvedLinks = {
      "Novel/A/Chapter 1.md": big,
    };

    index.markSourceStale("Novel/A/Chapter 1.md");
    index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(index.buildCalls).toBe(2);
  });

  it("falls back to a full rebuild when total stale sources exceed MAX_DIFF_TARGETS", () => {
    const resolved: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 5001; i++) {
      resolved[`Novel/A/Note ${i}.md`] = { "Characters/John.md": 1 };
    }
    const app = createApp(resolved);
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");

    for (const path of Object.keys(resolved)) {
      index.markSourceStale(path);
    }
    index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(index.buildCalls).toBe(2);
  });

  it("updates currentFileTargets when the current file is marked stale", () => {
    const app = createApp({
      "Novel/A/Note 0.md": { "Characters/1.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Note 0.md", "Novel");
    expect(
      index
        .getRankData("Novel/A/Note 0.md", "Novel")
        .currentFileTargets.has("Characters/1.md"),
    ).toBe(true);

    (app as any).metadataCache.resolvedLinks = {};
    index.markSourceStale("Novel/A/Note 0.md");
    const data = index.getRankData("Novel/A/Note 0.md", "Novel");

    expect(data.currentFileTargets.size).toBe(0);
  });

  it("keeps parity with a full rebuild over randomized edit sequences", () => {
    const seed = 12345;
    let rng = seed;
    const next = () => {
      rng = (rng * 16807) % 2147483647;
      return rng / 2147483647;
    };

    const files = Array.from({ length: 20 }, (_, i) => `Novel/A/Note ${i}.md`);
    const targets = Array.from({ length: 30 }, (_, i) => `Characters/${i}.md`);
    const unresolved = Array.from({ length: 15 }, (_, i) => `Phantom ${i}`);

    const resolvedLinks: Record<string, Record<string, number>> = {};
    const unresolvedLinks: Record<string, Record<string, number>> = {};

    const randomizeCache = () => {
      for (const file of files) {
        if (next() < 0.7) {
          const links: Record<string, number> = {};
          for (const target of targets) {
            if (next() < 0.3) {
              links[target] = Math.floor(next() * 3) + 1;
            }
          }
          resolvedLinks[file] = links;
        } else {
          delete resolvedLinks[file];
        }

        if (next() < 0.5) {
          const links: Record<string, number> = {};
          for (const name of unresolved) {
            if (next() < 0.2) {
              links[name] = Math.floor(next() * 2) + 1;
            }
          }
          unresolvedLinks[file] = links;
        } else {
          delete unresolvedLinks[file];
        }
      }
    };

    const app = createApp({}, {});
    const index = new LinkRankIndex(app);

    randomizeCache();
    (app as any).metadataCache.resolvedLinks = { ...resolvedLinks };
    (app as any).metadataCache.unresolvedLinks = { ...unresolvedLinks };
    index.getRankData("Novel/A/Note 0.md", "Novel");

    for (let step = 0; step < 30; step++) {
      randomizeCache();
      (app as any).metadataCache.resolvedLinks = { ...resolvedLinks };
      (app as any).metadataCache.unresolvedLinks = { ...unresolvedLinks };

      for (const file of files) {
        index.markSourceStale(file);
      }

      const data = index.getRankData("Novel/A/Note 0.md", "Novel");
      const expected = fullRebuildRankData(app, "Novel/A/Note 0.md", "Novel");

      expect(
        mapsEqual(data.targetToSourceFolders, expected.targetToSourceFolders),
      ).toBe(true);
      expect(
        mapsEqual(
          data.unresolvedNameToSourceFolders,
          expected.unresolvedNameToSourceFolders,
        ),
      ).toBe(true);
      expect(data.currentFileTargets).toStrictEqual(
        expected.currentFileTargets,
      );
      expect(data.currentFileUnresolvedNames).toStrictEqual(
        expected.currentFileUnresolvedNames,
      );
    }
  });

  it("handles renames by removing old contributions and queuing new path", () => {
    const app = createApp({
      "Novel/A/Old.md": { "Characters/John.md": 3 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Old.md", "Novel");
    (app.metadataCache as any).resolvedLinks = {
      "Novel/A/New.md": { "Characters/John.md": 5 },
    };

    index.onRename("Novel/A/Old.md", "Novel/A/New.md");
    const data = index.getRankData("Novel/A/New.md", "Novel");

    expect(data.targetToSourceFolders.get("Characters/John.md")).toStrictEqual(
      new Map([["Novel/A", 5]]),
    );
  });

  it("handles deletes by removing contributions", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");

    index.onDelete("Novel/A/Chapter 1.md");
    const data = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    expect(data.targetToSourceFolders.has("Characters/John.md")).toBe(false);
  });
});

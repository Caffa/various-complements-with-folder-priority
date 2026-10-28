import { describe, expect, it } from "@jest/globals";
import type { App, TFile } from "obsidian";
import { calculateFolderProximity } from "../model/FolderProximity";
import type { LinkRankData } from "../model/LinkRank";
import { FolderRankCache } from "./FolderRankCache";
import { LinkRankIndex } from "./LinkRankIndex";

function createApp(
  files: string[],
  resolvedLinks: Record<string, Record<string, number>> = {},
  unresolvedLinks: Record<string, Record<string, number>> = {},
): App {
  return {
    vault: {
      getMarkdownFiles: () =>
        files.map(
          (path) =>
            ({
              path,
              extension: "md",
            }) as TFile,
        ),
    },
    metadataCache: {
      resolvedLinks,
      unresolvedLinks,
    },
  } as unknown as App;
}

function buildRankData(overrides: Partial<LinkRankData> = {}): LinkRankData {
  return {
    builtForFilePath: "Novel/A/Chapter 1.md",
    builtForLimitingFolder: "Novel",
    currentFileTargets: new Map(),
    currentFileUnresolvedNames: new Map(),
    targetToSourceFolders: new Map(),
    unresolvedNameToSourceFolders: new Map(),
    ...overrides,
  };
}

function buildStandardRankData(): LinkRankData {
  return buildRankData({
    targetToSourceFolders: new Map([
      [
        "Novel/A/Johnny.md",
        new Map([
          ["Novel/A", 3],
          ["Novel/B", 1],
        ]),
      ],
      ["Novel/B/Job.md", new Map([["Novel/B", 2]])],
      ["Characters/John.md", new Map([["Resources/Characters", 5]])],
    ]),
    unresolvedNameToSourceFolders: new Map([
      ["phantomname", new Map([["Novel/A", 4]])],
    ]),
  });
}

function leafFiles(folder: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${folder}/Note ${i}.md`);
}

describe("FolderRankCache", () => {
  it("returns cached scores that match live calculateFolderProximity", () => {
    const app = createApp(
      leafFiles("Novel/A", 25),
      {
        "Novel/A/Note 0.md": { "Novel/A/Johnny.md": 1 },
        "Novel/A/Note 1.md": { "Novel/A/Johnny.md": 2 },
        "Novel/B/Note 0.md": { "Novel/A/Johnny.md": 1 },
      },
      {},
    );
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData)!;
    expect(list).toBeDefined();

    for (const [target, entry] of list.resolvedScores) {
      const sourceFolders = rankData.targetToSourceFolders.get(target)!;
      const expected = calculateFolderProximity(
        sourceFolders,
        "Novel/A/Chapter 1.md",
        "Novel",
      );
      expect({
        level: entry.level,
        frequency: entry.frequency,
        score: entry.score,
      }).toStrictEqual(expected);
    }

    for (const [name, entry] of list.unresolvedScores) {
      const sourceFolders = rankData.unresolvedNameToSourceFolders.get(name)!;
      const expected = calculateFolderProximity(
        sourceFolders,
        "Novel/A/Chapter 1.md",
        "Novel",
      );
      expect({
        level: entry.level,
        frequency: entry.frequency,
        score: entry.score,
      }).toStrictEqual(expected);
    }
  });

  it("assigns rank 1 to the top score and is deterministic", () => {
    const app = createApp(
      leafFiles("Novel/A", 25),
      {
        "Novel/A/Note 0.md": { "Novel/A/Zulu.md": 1 },
        "Novel/A/Note 1.md": { "Novel/A/Bravo.md": 2 },
      },
      {},
    );
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData)!;
    const resolved = Array.from(list.resolvedScores.entries());
    expect(resolved[0][1].rank).toBe(1);
    expect(resolved[0][0]).toBe("Novel/A/Bravo.md");
    expect(resolved[1][1].rank).toBe(2);
    expect(resolved[1][0]).toBe("Novel/A/Zulu.md");
  });

  it("is deterministic regardless of Map insertion order", () => {
    const app = createApp(leafFiles("Novel/A", 25), {}, {});
    const index = new LinkRankIndex(app);

    const rankDataA = buildRankData({
      targetToSourceFolders: new Map([
        [
          "Novel/A/Zulu.md",
          new Map([
            ["Novel/A", 1],
            ["Novel/B", 1],
          ]),
        ],
        [
          "Novel/A/Bravo.md",
          new Map([
            ["Novel/A", 2],
            ["Novel/B", 1],
          ]),
        ],
      ]),
    });
    const rankDataB = buildRankData({
      targetToSourceFolders: new Map([
        [
          "Novel/A/Bravo.md",
          new Map([
            ["Novel/A", 2],
            ["Novel/B", 1],
          ]),
        ],
        [
          "Novel/A/Zulu.md",
          new Map([
            ["Novel/A", 1],
            ["Novel/B", 1],
          ]),
        ],
      ]),
    });

    // Use two independent caches so each path actually constructs a list.
    const cacheA = new FolderRankCache(app, index);
    const cacheB = new FolderRankCache(app, index);
    const listA = cacheA.getList("Novel/A/Chapter 1.md", "Novel", rankDataA)!;
    const listB = cacheB.getList("Novel/A/Chapter 2.md", "Novel", rankDataB)!;

    expect(cacheA.stats.builds).toBe(1);
    expect(cacheB.stats.builds).toBe(1);

    expect(Array.from(listA.resolvedScores.entries())).toStrictEqual(
      Array.from(listB.resolvedScores.entries()),
    );
    expect(Array.from(listA.unresolvedScores.entries())).toStrictEqual(
      Array.from(listB.unresolvedScores.entries()),
    );
  });

  it("breaks score ties by lower level (canonical tie-break)", () => {
    const app = createApp(leafFiles("Novel/A/B", 25), {}, {});
    const index = new LinkRankIndex(app);

    // Same score (3) produced by different (level, frequency) pairs:
    // level 0 => 3 / (0 + 1) = 3
    // level 2 => 9 / (2 + 1) = 3
    const makeRankData = () =>
      buildRankData({
        targetToSourceFolders: new Map([
          ["Novel/A/B/Level0.md", new Map([["Novel/A/B", 3]])],
          ["Novel/A/B/Level2.md", new Map([["Novel", 9]])],
        ]),
      });

    const cacheA = new FolderRankCache(app, index);
    const cacheB = new FolderRankCache(app, index);

    const listA = cacheA.getList(
      "Novel/A/B/Chapter 1.md",
      "Novel",
      makeRankData(),
    )!;
    const listB = cacheB.getList(
      "Novel/A/B/Chapter 1.md",
      "Novel",
      makeRankData(),
    )!;

    expect(cacheA.stats.builds).toBe(1);
    expect(cacheB.stats.builds).toBe(1);

    const keysA = Array.from(listA.resolvedScores.keys());
    const keysB = Array.from(listB.resolvedScores.keys());
    expect(keysA[0]).toBe("Novel/A/B/Level0.md");
    expect(keysA).toStrictEqual(keysB);

    const level0Entry = listA.resolvedScores.get("Novel/A/B/Level0.md")!;
    expect(level0Entry.level).toBe(0);
    expect(level0Entry.frequency).toBe(3);
    expect(level0Entry.score).toBe(3);

    const level2Entry = listA.resolvedScores.get("Novel/A/B/Level2.md")!;
    expect(level2Entry.level).toBe(2);
    expect(level2Entry.frequency).toBe(9);
    expect(level2Entry.score).toBe(3);
  });

  it("does not qualify folders below the minimum file threshold", () => {
    const app = createApp(leafFiles("Novel/A", 19));
    const cache = new FolderRankCache(app, new LinkRankIndex(app));
    const list = cache.getList(
      "Novel/A/Chapter 1.md",
      "Novel",
      buildRankData(),
    );
    expect(list).toBeUndefined();
    expect(cache.stats.misses).toBe(1);
  });

  it("qualifies folders at the minimum threshold", () => {
    const app = createApp(leafFiles("Novel/A", 20));
    const cache = new FolderRankCache(app, new LinkRankIndex(app));
    const list = cache.getList(
      "Novel/A/Chapter 1.md",
      "Novel",
      buildRankData(),
    );
    expect(list).toBeDefined();
  });

  it("does not qualify folders above the maximum file threshold", () => {
    const app = createApp(leafFiles("Novel/A", 2001));
    const cache = new FolderRankCache(app, new LinkRankIndex(app));
    const list = cache.getList(
      "Novel/A/Chapter 1.md",
      "Novel",
      buildRankData(),
    );
    expect(list).toBeUndefined();
  });

  it("does not qualify non-leaf folders", () => {
    const app = createApp([...leafFiles("Novel/A", 25), "Novel/A/Sub/Note.md"]);
    const cache = new FolderRankCache(app, new LinkRankIndex(app));
    const list = cache.getList(
      "Novel/A/Chapter 1.md",
      "Novel",
      buildRankData(),
    );
    expect(list).toBeUndefined();
  });

  it("builds a list once and reuses it on repeated calls", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);

    expect(cache.stats.builds).toBe(1);
    expect(cache.stats.hits).toBe(2);
  });

  it("rebuilds after the rank index version changes via staleness", () => {
    const app = createApp(
      leafFiles("Novel/A", 25),
      {
        "Novel/A/Note 0.md": { "Novel/A/Johnny.md": 1 },
      },
      {},
    );
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", first);

    (app.metadataCache as any).resolvedLinks = {
      "Novel/A/Note 0.md": { "Novel/A/Johnny.md": 99 },
    };
    index.markSourceStale("Novel/A/Note 0.md");
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", second);

    expect(cache.stats.builds).toBe(2);
  });

  it("rebuilds after the rank index is invalidated", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", first);

    index.invalidate();
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", second);

    expect(cache.stats.builds).toBe(2);
  });

  it("clears cached lists when the limiting folder changes", () => {
    const app = createApp([
      ...leafFiles("Novel/A", 25),
      ...leafFiles("Drafts/A", 25),
    ]);
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const rankDataNovel = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", rankDataNovel);

    const rankDataDrafts = index.getRankData("Drafts/A/Chapter 1.md", "Drafts");
    const list = cache.getList(
      "Drafts/A/Chapter 1.md",
      "Drafts",
      rankDataDrafts,
    );

    expect(list).toBeDefined();
    expect(cache.stats.cachedLists).toBe(1);
    expect(cache.stats.builds).toBe(2); // Novel built, then cleared, then Drafts built.
  });

  it("does not cache when the limiting folder is empty", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "");
    const list = cache.getList("Novel/A/Chapter 1.md", "", rankData);
    expect(list).toBeUndefined();
  });

  it("does not cache when current folder is outside limiting folder", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Resources/Notes/Chapter 1.md", "Novel");
    const list = cache.getList(
      "Resources/Notes/Chapter 1.md",
      "Novel",
      rankData,
    );
    expect(list).toBeUndefined();
  });

  it("keeps at most MAX_LIST_SIZE entries and ranks only the top TOP_K", () => {
    const targets = new Map<string, Map<string, number>>();
    for (let i = 0; i < 2500; i++) {
      const key = `Novel/A/Target ${i.toString().padStart(4, "0")}.md`;
      targets.set(key, new Map([["Novel/A", 2500 - i]]));
    }

    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = buildRankData({ targetToSourceFolders: targets });

    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData)!;
    expect(list.resolvedScores.size).toBe(500);

    let ranklessCount = 0;
    let i = 0;
    for (const [, entry] of list.resolvedScores) {
      i++;
      if (entry.rank === undefined) {
        ranklessCount++;
        expect(i).toBeGreaterThan(1000);
      }
    }
    // MAX_LIST_SIZE (500) < TOP_K (1000), so every stored entry has a rank.
    expect(ranklessCount).toBe(0);
  });

  it("falls back to live scoring for targets not stored in the cache", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const rankData = buildRankData({
      targetToSourceFolders: new Map([
        [
          "Novel/A/Johnny.md",
          new Map([
            ["Novel/A", 3],
            ["Novel/B", 1],
          ]),
        ],
      ]),
    });

    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData)!;
    expect(list.resolvedScores.has("Novel/A/Johnny.md")).toBe(true);
    expect(list.resolvedScores.has("Missing.md")).toBe(false);
  });

  it("evicts the oldest list when the cache exceeds MAX_CACHED_LISTS", () => {
    const folders: string[] = [];
    for (let i = 0; i < 513; i++) {
      folders.push(`Novel/${i.toString().padStart(3, "0")}`);
    }

    const files = folders.flatMap((f) => leafFiles(f, 25));
    const resolvedLinks: Record<string, Record<string, number>> = {};
    for (const folder of folders) {
      resolvedLinks[`${folder}/Note 0.md`] = {
        [`${folder}/Target.md`]: 1,
      };
    }

    const app = createApp(files, resolvedLinks, {});
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    // Touch every folder once.
    for (const folder of folders) {
      const rankData = index.getRankData(`${folder}/Chapter 1.md`, "Novel");
      cache.getList(`${folder}/Chapter 1.md`, "Novel", rankData);
    }

    expect(cache.stats.cachedLists).toBe(512);
    expect(cache.stats.evictions).toBeGreaterThanOrEqual(1);

    // The first touched folder should have been evicted.
    const firstRankData = index.getRankData(
      `${folders[0]}/Chapter 1.md`,
      "Novel",
    );
    cache.getList(`${folders[0]}/Chapter 1.md`, "Novel", firstRankData);
    expect(cache.stats.builds).toBe(514);
  });

  it("refreshes recency so a recent list survives LRU eviction", () => {
    // Three named folders plus enough other folders to fill the 512-slot cache,
    // plus one extra folder that is only touched after refreshing recency.
    const namedFolders = ["Novel/A", "Novel/B", "Novel/C"];
    const otherFolders: string[] = [];
    for (let i = 0; i < 509; i++) {
      otherFolders.push(`Novel/Other${i.toString().padStart(3, "0")}`);
    }
    const extraFolder = "Novel/Extra";
    const folders = [...namedFolders, ...otherFolders];
    const allFolders = [...folders, extraFolder];

    const files = allFolders.flatMap((f) => leafFiles(f, 25));
    const resolvedLinks: Record<string, Record<string, number>> = {};
    for (const folder of allFolders) {
      resolvedLinks[`${folder}/Note 0.md`] = {
        [`${folder}/Target.md`]: 1,
      };
    }

    const app = createApp(files, resolvedLinks, {});
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const rankDataFor = (folder: string) =>
      index.getRankData(`${folder}/Chapter 1.md`, "Novel");

    // Touch A, B, C and then the remaining folders once each.
    for (const folder of folders) {
      cache.getList(`${folder}/Chapter 1.md`, "Novel", rankDataFor(folder));
    }
    expect(cache.stats.cachedLists).toBe(512);

    // Refresh A's recency: now A is newer than B in the LRU order.
    const listA = cache.getList(
      "Novel/A/Chapter 1.md",
      "Novel",
      rankDataFor("Novel/A"),
    );
    expect(cache.stats.hits).toBe(1);

    // Touch the extra folder to trigger an eviction (this itself is one build).
    cache.getList(
      `${extraFolder}/Chapter 1.md`,
      "Novel",
      rankDataFor(extraFolder),
    );

    expect(cache.stats.evictions).toBeGreaterThanOrEqual(1);

    // A should still be cached; B should have been evicted (older than A).
    const buildsAfterExtra = cache.stats.builds;
    expect(
      cache.getList("Novel/A/Chapter 1.md", "Novel", rankDataFor("Novel/A")),
    ).toBe(listA);
    expect(cache.stats.builds).toBe(buildsAfterExtra); // A was a hit, no rebuild.

    cache.getList("Novel/B/Chapter 1.md", "Novel", rankDataFor("Novel/B"));
    expect(cache.stats.builds).toBe(buildsAfterExtra + 1); // B had to be rebuilt.
  });

  it("does not use resolvedLinks keys for leaf qualification", () => {
    // A folder with no markdown files of its own but many link sources
    // should not be qualified.
    const app = createApp(
      ["Other/Note.md"],
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `Novel/A/External ${i}.md`,
          { "Other/Note.md": 1 },
        ]),
      ),
      {},
    );
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    expect(list).toBeUndefined();
  });

  it("invalidation clears lists and qualifications", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);

    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    const buildsBefore = cache.stats.builds;

    cache.invalidate();

    expect(cache.stats.cachedLists).toBe(0);
    // A subsequent call rebuilds from scratch because qualifications/summary were cleared.
    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    expect(cache.stats.builds).toBe(buildsBefore + 1);
  });

  it("tracks hits, misses, builds and evictions in stats", () => {
    const app = createApp(leafFiles("Novel/A", 25));
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    expect(cache.stats.builds).toBe(1);
    expect(cache.stats.misses).toBe(1);

    cache.getList("Novel/A/Chapter 1.md", "Novel", rankData);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.lastBuildTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("F2 memoization parity", () => {
  it("memoized buildList results match direct calculateFolderProximity results", () => {
    const app = createApp(
      leafFiles("Novel/A", 25),
      {
        "Novel/A/Note 0.md": { "Novel/A/Johnny.md": 1 },
        "Novel/A/Note 1.md": { "Novel/A/Johnny.md": 2 },
        "Novel/B/Note 0.md": { "Novel/A/Johnny.md": 1 },
      },
      {},
    );
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const rankData = index.getRankData("Novel/A/Chapter 1.md", "Novel");

    const list = cache.getList("Novel/A/Chapter 1.md", "Novel", rankData)!;
    for (const [target, entry] of list.resolvedScores) {
      const sourceFolders = rankData.targetToSourceFolders.get(target)!;
      const expected = calculateFolderProximity(
        sourceFolders,
        "Novel/A/Chapter 1.md",
        "Novel",
      );
      expect({
        level: entry.level,
        frequency: entry.frequency,
        score: entry.score,
      }).toStrictEqual(expected);
    }
  });
});

describe("F3 structure epoch", () => {
  it("does not rescan ensureSummary when links are unchanged (no version/structure bump)", () => {
    const files = leafFiles("Novel/A", 25);
    const app = createApp(files, {}, {});
    let scans = 0;
    const realGet = app.vault.getMarkdownFiles;
    app.vault.getMarkdownFiles = () => {
      scans++;
      return realGet();
    };
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", first);
    const scansBefore = scans;
    // unchanged links: no version bump, no structure bump.
    index.markSourceStale("Novel/A/Note 0.md");
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", second);
    expect(scans).toBe(scansBefore);
  });

  it("rescans ensureSummary when bumpStructure is called", () => {
    const files = leafFiles("Novel/A", 25);
    const app = createApp(files, {}, {});
    let scans = 0;
    const realGet = app.vault.getMarkdownFiles;
    app.vault.getMarkdownFiles = () => {
      scans++;
      return realGet();
    };
    const index = new LinkRankIndex(app);
    const cache = new FolderRankCache(app, index);
    const first = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", first);
    const scansAfterFirst = scans;
    // identical link data, no version bump, BUT bump structure
    cache.bumpStructure();
    const second = index.getRankData("Novel/A/Chapter 1.md", "Novel");
    cache.getList("Novel/A/Chapter 1.md", "Novel", second);
    expect(scans).toBeGreaterThan(scansAfterFirst);
  });
});

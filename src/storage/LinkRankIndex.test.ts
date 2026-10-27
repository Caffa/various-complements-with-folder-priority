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

  it("rebuilds when current file path changes", () => {
    const app = createApp({
      "Novel/A/Chapter 1.md": { "Characters/John.md": 1 },
      "Novel/A/Chapter 2.md": { "Characters/Jane.md": 1 },
    });
    const index = new LinkRankIndex(app);

    index.getRankData("Novel/A/Chapter 1.md", "Novel");
    const second = index.getRankData("Novel/A/Chapter 2.md", "Novel");

    expect(second.currentFileTargets.has("Characters/John.md")).toBe(false);
    expect(second.currentFileTargets.has("Characters/Jane.md")).toBe(true);
    expect(index.buildCalls).toBe(2);
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

  it("populates file tier data even when limiting folder is empty", () => {
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
  });
});

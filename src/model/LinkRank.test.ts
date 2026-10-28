import { describe, expect, it, jest } from "@jest/globals";
import {
  computeLinkRank,
  type FolderRankCacheLike,
  type FolderRankList,
  type LinkRankData,
} from "./LinkRank";
import type { InternalLinkWord } from "./Word";

function buildRankData(overrides: Partial<LinkRankData> = {}): LinkRankData {
  return {
    builtForFilePath: "Novel/Ancient China/Chapter 1.md",
    builtForLimitingFolder: "Novel",
    currentFileTargets: new Map(),
    currentFileUnresolvedNames: new Map(),
    targetToSourceFolders: new Map(),
    unresolvedNameToSourceFolders: new Map(),
    ...overrides,
  };
}

function buildWord(
  overrides: Partial<InternalLinkWord> = {},
): InternalLinkWord {
  return {
    value: "John",
    type: "internalLink",
    createdPath: "Characters/John.md",
    ...overrides,
  };
}

const defaultOption = {
  enabled: true,
  currentFilePath: "Novel/Ancient China/Chapter 1.md",
  limitingFolder: "Novel",
} as const;

describe("computeLinkRank", () => {
  it("returns fileTier true when createdPath is a resolved target of current file", () => {
    const word = buildWord({ createdPath: "Characters/John.md" });
    const rankData = buildRankData({
      currentFileTargets: new Map([
        ["Characters/John.md", 1],
        ["Characters/Jane.md", 2],
      ]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(true);
  });

  it("returns fileTier false when createdPath is not a resolved target of current file", () => {
    const word = buildWord({ createdPath: "Characters/John.md" });
    const rankData = buildRankData({
      currentFileTargets: new Map([["Characters/Jane.md", 1]]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(false);
  });

  it("uses aliasMeta.origin as target fallback for alias words", () => {
    const word = {
      value: "Johnny",
      type: "internalLink" as const,
      aliasMeta: { origin: "Characters/John.md" },
    } as unknown as InternalLinkWord;
    const rankData = buildRankData({
      currentFileTargets: new Map([["Characters/John.md", 1]]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(true);
  });

  it("returns false for phantom word when unresolved name does not match", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const rankData = buildRankData({
      currentFileUnresolvedNames: new Map([["other", 1]]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(false);
  });

  it("returns true for phantom word when lowercased value appears in unresolved names", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const rankData = buildRankData({
      currentFileUnresolvedNames: new Map([["phantomname", 1]]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(true);
  });

  it("computes phantom folderProximity under the same gate as resolved words", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const rankData = buildRankData({
      unresolvedNameToSourceFolders: new Map([
        ["phantomname", new Map([["Novel/Ancient China", 3]])],
      ]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.folderProximity).toStrictEqual({
      level: 0,
      frequency: 3,
      score: 3,
    });
  });

  it("omits phantom folderProximity when limitingFolder is empty", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const rankData = buildRankData({
      unresolvedNameToSourceFolders: new Map([
        ["phantomname", new Map([["Novel/Ancient China", 3]])],
      ]),
    });

    const result = computeLinkRank(word, {
      enabled: true,
      currentFilePath: "Novel/Ancient China/Chapter 1.md",
      limitingFolder: "",
      rankData,
    });

    expect(result.fileTier).toBe(false);
    expect(result.folderProximity).toBeUndefined();
  });

  it("omits phantom folderProximity when current file is outside limiting folder", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const rankData = buildRankData({
      unresolvedNameToSourceFolders: new Map([
        ["phantomname", new Map([["Novel/Ancient China", 3]])],
      ]),
    });

    const result = computeLinkRank(word, {
      enabled: true,
      currentFilePath: "Resources/Notes/Chapter 1.md",
      limitingFolder: "Novel",
      rankData,
    });

    expect(result.folderProximity).toStrictEqual({
      level: 999,
      frequency: 0,
      score: 0,
    });
  });

  it("omits folderProximity when limitingFolder is empty", () => {
    const word = buildWord();
    const rankData = buildRankData({
      targetToSourceFolders: new Map([
        ["Characters/John.md", new Map([["Novel/Ancient China", 1]])],
      ]),
    });

    const result = computeLinkRank(word, {
      enabled: true,
      currentFilePath: "Novel/Ancient China/Chapter 1.md",
      limitingFolder: "",
      rankData,
    });

    expect(result.fileTier).toBe(false);
    expect(result.folderProximity).toBeUndefined();
  });

  it("omits folderProximity for non-phantom word with no inverted entry", () => {
    const word = buildWord();
    const rankData = buildRankData({
      targetToSourceFolders: new Map(),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.fileTier).toBe(false);
    expect(result.folderProximity).toBeUndefined();
  });

  it("delegates to calculateFolderProximity with out-of-limit folders filtered", () => {
    const word = buildWord();
    const rankData = buildRankData({
      targetToSourceFolders: new Map([
        [
          "Characters/John.md",
          new Map([
            ["Novel/Ancient China", 3],
            ["Resources/Characters", 99],
          ]),
        ],
      ]),
    });

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData,
    });

    expect(result.folderProximity).toStrictEqual({
      level: 0,
      frequency: 3,
      score: 3,
    });
  });

  it("does not call calculateFolderProximity when disabled", () => {
    const word = buildWord();
    const rankData = buildRankData({
      targetToSourceFolders: new Map([
        ["Characters/John.md", new Map([["Novel/Ancient China", 3]])],
      ]),
    });

    const result = computeLinkRank(word, {
      enabled: false,
      currentFilePath: "Novel/Ancient China/Chapter 1.md",
      limitingFolder: "Novel",
      rankData,
    });

    expect(result.folderProximity).toBeUndefined();
  });
});

describe("computeLinkRank with folderRankCache", () => {
  function buildRankData(overrides: Partial<LinkRankData> = {}): LinkRankData {
    return {
      builtForFilePath: "Novel/Ancient China/Chapter 1.md",
      builtForLimitingFolder: "Novel",
      currentFileTargets: new Map(),
      currentFileUnresolvedNames: new Map(),
      targetToSourceFolders: new Map(),
      unresolvedNameToSourceFolders: new Map(),
      ...overrides,
    };
  }

  function buildWord(
    overrides: Partial<InternalLinkWord> = {},
  ): InternalLinkWord {
    return {
      value: "John",
      type: "internalLink",
      createdPath: "Characters/John.md",
      ...overrides,
    };
  }

  const defaultOption = {
    enabled: true,
    currentFilePath: "Novel/Ancient China/Chapter 1.md",
    limitingFolder: "Novel",
  } as const;

  function createStubList(
    resolved: Map<
      string,
      { level: number; frequency: number; score: number; rank?: number }
    >,
    unresolved: Map<
      string,
      { level: number; frequency: number; score: number; rank?: number }
    >,
  ): FolderRankList {
    return {
      folder: "Novel/Ancient China",
      builtForLimitingFolder: "Novel",
      globalVersion: 1,
      resolvedScores: new Map(
        Array.from(resolved).map(([k, v]) => [k, { ...v }]),
      ),
      unresolvedScores: new Map(
        Array.from(unresolved).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }

  it("uses resolved cache entry and strips rank from folderProximity", () => {
    const word = buildWord({ createdPath: "Characters/John.md" });
    const cache: FolderRankCacheLike = {
      getList: jest
        .fn<FolderRankCacheLike["getList"]>()
        .mockReturnValue(
          createStubList(
            new Map([
              [
                "Characters/John.md",
                { level: 0, frequency: 3, score: 3, rank: 1 },
              ],
            ]),
            new Map(),
          ),
        ),
    };

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData: buildRankData(),
      folderRankCache: cache,
    });

    expect(result).toStrictEqual({
      fileTier: false,
      folderProximity: { level: 0, frequency: 3, score: 3 },
      rank: 1,
    });
  });

  it("uses phantom cache entry and strips rank from folderProximity", () => {
    const word = buildWord({
      value: "PhantomName",
      createdPath: "Novel/Ancient China/Chapter 1.md",
      phantom: true,
    });
    const cache: FolderRankCacheLike = {
      getList: jest
        .fn<FolderRankCacheLike["getList"]>()
        .mockReturnValue(
          createStubList(
            new Map(),
            new Map([
              ["phantomname", { level: 0, frequency: 5, score: 5, rank: 2 }],
            ]),
          ),
        ),
    };

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData: buildRankData(),
      folderRankCache: cache,
    });

    expect(result).toStrictEqual({
      fileTier: false,
      folderProximity: { level: 0, frequency: 5, score: 5 },
      rank: 2,
    });
  });

  it("falls back to live scoring when cache misses the target", () => {
    const word = buildWord({ createdPath: "Characters/John.md" });
    const cache: FolderRankCacheLike = {
      getList: jest
        .fn<FolderRankCacheLike["getList"]>()
        .mockReturnValue(createStubList(new Map(), new Map())),
    };

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData: buildRankData({
        targetToSourceFolders: new Map([
          ["Characters/John.md", new Map([["Novel/Ancient China", 3]])],
        ]),
      }),
      folderRankCache: cache,
    });

    expect(result).toStrictEqual({
      fileTier: false,
      folderProximity: { level: 0, frequency: 3, score: 3 },
      rank: undefined,
    });
  });

  it("does not consult the cache when disabled", () => {
    const word = buildWord();
    const getList = jest.fn<FolderRankCacheLike["getList"]>();
    const cache: FolderRankCacheLike = { getList };

    const result = computeLinkRank(word, {
      enabled: false,
      currentFilePath: "Novel/Ancient China/Chapter 1.md",
      limitingFolder: "Novel",
      rankData: buildRankData({
        targetToSourceFolders: new Map([
          ["Characters/John.md", new Map([["Novel/Ancient China", 3]])],
        ]),
      }),
      folderRankCache: cache,
    });

    expect(getList).not.toHaveBeenCalled();
    expect(result.folderProximity).toBeUndefined();
  });

  it("does not consult the cache when rankData is missing", () => {
    const word = buildWord();
    const getList = jest.fn<FolderRankCacheLike["getList"]>();
    const cache: FolderRankCacheLike = { getList };

    const result = computeLinkRank(word, {
      ...defaultOption,
      rankData: undefined,
      folderRankCache: cache,
    });

    expect(getList).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ fileTier: false });
  });
});

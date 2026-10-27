import { describe, expect, it } from "@jest/globals";
import type { App, TFile } from "obsidian";
import type { AppHelper } from "../app-helper";
import type { InternalLinkWord } from "../model/Word";
import { InternalLinkWordProvider } from "./InternalLinkWordProvider";

function createApp(files: TFile[]): App {
  return {
    vault: {
      getMarkdownFiles: () => files,
    },
  } as unknown as App;
}

function createFile(path: string, basename: string): TFile {
  return { path, basename } as TFile;
}

function createAppHelper(overrides: Partial<AppHelper> = {}): AppHelper {
  return {
    getAliases: () => [],
    getBoolFrontMatter: () => false,
    getTagsProperty: () => [],
    searchPhantomLinks: () => [],
    ...overrides,
  } as unknown as AppHelper;
}

function allWords(provider: InternalLinkWordProvider): InternalLinkWord[] {
  return Object.values(
    provider.wordsByFirstLetter,
  ).flat() as InternalLinkWord[];
}

const baseOption = {
  wordAsInternalLinkAlias: false,
  suppressBasenameWhenAliases: false,
  excludePathPrefixPatterns: [],
  excludePathGlobPatterns: [],
  makeSynonymAboutEmoji: false,
  makeSynonymAboutAccentsDiacritics: false,
  frontMatterKeyForExclusion: "",
  tagsForExclusion: [],
  excludeUnresolvedLinks: false,
};

describe("InternalLinkWordProvider", () => {
  it("emits basename words with merged aliases when wordAsInternalLinkAlias is false", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => ["Johnny", "Jon"],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords(baseOption);

    expect(provider.wordCount).toBe(1);
    expect(provider.lastRefresh?.resolvedWordCount).toBe(1);
    const word = allWords(provider)[0];
    expect(word.value).toBe("John");
    expect(word.createdPath).toBe("Characters/John.md");
    expect(word.aliases).toContain("Johnny");
    expect(word.aliases).toContain("Jon");
    expect(word.aliasMeta).toBeUndefined();
  });

  it("emits separate alias words with aliasMeta.origin in alias mode", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => ["Johnny"],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({ ...baseOption, wordAsInternalLinkAlias: true });

    expect(provider.wordCount).toBe(2);
    const words = allWords(provider);
    const basename = words.find((w) => w.value === "John")!;
    const alias = words.find((w) => w.value === "Johnny")!;
    expect(basename.createdPath).toBe("Characters/John.md");
    expect(alias.aliasMeta?.origin).toBe("Characters/John.md");
  });

  it("suppresses basename word when suppressBasenameWhenAliases is true and aliases exist", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => ["Johnny"],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({
      ...baseOption,
      wordAsInternalLinkAlias: true,
      suppressBasenameWhenAliases: true,
    });

    expect(provider.wordCount).toBe(1);
    expect(allWords(provider)[0].value).toBe("Johnny");
  });

  it("keeps basename word when suppressBasenameWhenAliases is true but there are no aliases", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => [],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({
      ...baseOption,
      wordAsInternalLinkAlias: true,
      suppressBasenameWhenAliases: true,
    });

    expect(provider.wordCount).toBe(1);
    expect(allWords(provider)[0].value).toBe("John");
  });

  it("suppressBasenameWhenAliases has no effect when wordAsInternalLinkAlias is false", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => ["Johnny"],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({
      ...baseOption,
      wordAsInternalLinkAlias: false,
      suppressBasenameWhenAliases: true,
    });

    expect(provider.wordCount).toBe(1);
    expect(allWords(provider)[0].value).toBe("John");
  });

  it("emits phantom words from unresolved links with source path and phantom flag", () => {
    const files = [createFile("Novel/A/Chapter 1.md", "Chapter 1")];
    const appHelper = createAppHelper({
      searchPhantomLinks: () => [
        { path: "Novel/A/Chapter 1.md", link: "PhantomName" },
      ],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords(baseOption);

    const phantom = allWords(provider).find((w) => w.phantom);
    expect(phantom).toBeDefined();
    expect(phantom!.value).toBe("PhantomName");
    expect(phantom!.createdPath).toBe("Novel/A/Chapter 1.md");
    expect(phantom!.phantom).toBe(true);
    expect(provider.lastRefresh?.phantomWordCount).toBe(1);
  });

  it("skips phantom words when excludeUnresolvedLinks is true", () => {
    const files = [createFile("Novel/A/Chapter 1.md", "Chapter 1")];
    const appHelper = createAppHelper({
      searchPhantomLinks: () => [
        { path: "Novel/A/Chapter 1.md", link: "PhantomName" },
      ],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({ ...baseOption, excludeUnresolvedLinks: true });

    expect(allWords(provider).every((w) => !w.phantom)).toBe(true);
    expect(provider.lastRefresh?.phantomWordCount).toBe(0);
  });

  it("excludes files by path prefix patterns", () => {
    const files = [
      createFile("Novel/A/Chapter 1.md", "Chapter 1"),
      createFile("Archive/Old.md", "Old"),
    ];
    const provider = new InternalLinkWordProvider(
      createApp(files),
      createAppHelper(),
    );

    provider.refreshWords({
      ...baseOption,
      excludePathPrefixPatterns: ["Archive/"],
    });

    expect(allWords(provider).map((w) => w.createdPath)).not.toContain(
      "Archive/Old.md",
    );
  });

  it("excludes files by glob patterns", () => {
    const files = [
      createFile("Novel/A/Chapter 1.md", "Chapter 1"),
      createFile("Templates/Template.md", "Template"),
    ];
    const provider = new InternalLinkWordProvider(
      createApp(files),
      createAppHelper(),
    );

    provider.refreshWords({
      ...baseOption,
      excludePathGlobPatterns: ["Templates/*"],
    });

    expect(allWords(provider).map((w) => w.createdPath)).not.toContain(
      "Templates/Template.md",
    );
  });

  it("excludes files by front matter key for exclusion", () => {
    const files = [
      createFile("Novel/A/Chapter 1.md", "Chapter 1"),
      createFile("Drafts/Hide.md", "Hide"),
    ];
    const appHelper = createAppHelper({
      getBoolFrontMatter: (_f, key) =>
        key === "excludeFromComplement" && _f.path === "Drafts/Hide.md",
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({
      ...baseOption,
      frontMatterKeyForExclusion: "excludeFromComplement",
    });

    expect(allWords(provider).map((w) => w.createdPath)).not.toContain(
      "Drafts/Hide.md",
    );
  });

  it("excludes files by tag", () => {
    const files = [
      createFile("Novel/A/Chapter 1.md", "Chapter 1"),
      createFile("Private/Secret.md", "Secret"),
    ];
    const appHelper = createAppHelper({
      getTagsProperty: (f) =>
        f.path === "Private/Secret.md" ? ["exclude"] : [],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords({
      ...baseOption,
      tagsForExclusion: ["exclude"],
    });

    expect(allWords(provider).map((w) => w.createdPath)).not.toContain(
      "Private/Secret.md",
    );
  });

  it("indexes words by first letter and by alias first letters", () => {
    const files = [createFile("Characters/John.md", "John")];
    const appHelper = createAppHelper({
      getAliases: () => ["Zebra"],
    });
    const provider = new InternalLinkWordProvider(createApp(files), appHelper);

    provider.refreshWords(baseOption);

    expect(Object.keys(provider.wordsByFirstLetter).sort()).toStrictEqual([
      "J",
      "Z",
    ]);
    expect(provider.wordsByFirstLetter["J"]).toHaveLength(1);
    expect(provider.wordsByFirstLetter["Z"]).toHaveLength(1);
  });

  it("does not reset lastRefresh in clearWords", () => {
    const files = [createFile("Characters/John.md", "John")];
    const provider = new InternalLinkWordProvider(
      createApp(files),
      createAppHelper(),
    );

    provider.refreshWords(baseOption);
    const stats = provider.lastRefresh;
    provider.clearWords();

    expect(provider.lastRefresh).toBe(stats);
    expect(provider.wordCount).toBe(0);
  });

  it("records refresh timing stats", () => {
    const files = [createFile("Characters/John.md", "John")];
    const provider = new InternalLinkWordProvider(
      createApp(files),
      createAppHelper(),
    );

    provider.refreshWords(baseOption);

    expect(provider.lastRefresh).toBeDefined();
    expect(provider.lastRefresh!.at).toBeGreaterThan(0);
    expect(provider.lastRefresh!.ms).toBeGreaterThanOrEqual(0);
    expect(provider.lastRefresh!.resolvedWordCount).toBe(1);
  });
});

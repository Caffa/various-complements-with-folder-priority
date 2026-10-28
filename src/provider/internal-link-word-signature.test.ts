import { describe, expect, it } from "@jest/globals";
import type { App, TFile } from "obsidian";
import {
  collectFileWordsParts,
  computeFileWordsSignature,
  computeInternalLinkSettingsSignature,
  type CollectFileWordsPartsOption,
  type FileWordsParts,
} from "./internal-link-word-signature";

function createApp(
  overrides: {
    aliases?: string[];
    tags?: string[];
    frontmatter?: Record<string, unknown>;
    unresolvedLinks?: Record<string, Record<string, number>>;
  } = {},
): App {
  const frontmatter: Record<string, unknown> = {
    ...(overrides.frontmatter ?? {}),
  };
  if (overrides.aliases) frontmatter.aliases = overrides.aliases;
  if (overrides.tags) frontmatter.tags = overrides.tags;
  return {
    vault: {},
    metadataCache: {
      getFileCache: () => ({ frontmatter }) as any,
      unresolvedLinks: overrides.unresolvedLinks ?? {},
    },
  } as unknown as App;
}

function createFile(path: string): TFile {
  return { path, basename: path.split("/").pop() ?? path } as TFile;
}

const baseOption: CollectFileWordsPartsOption = {
  excludePathPrefixPatterns: [],
  excludePathGlobPatterns: [],
  frontMatterKeyForExclusion: "",
  tagsForExclusion: [],
};

const baseSettings = {
  suggestInternalLinkWithAlias: false,
  suggestAliasesOnly: false,
  internalLinkIgnoreTriggerPrefixes: "",
  excludeInternalLinkPathPrefixPatterns: "",
  excludeInternalLinkPathGlobPatterns: [],
  matchingWithoutEmoji: true,
  treatAccentDiacriticsAsAlphabeticCharacters: false,
  frontMatterKeyForExclusionInternalLink: "",
  tagsForExclusionInternalLink: [],
  excludeUnresolvedInternalLinks: false,
  enableInternalLinkComplement: true,
} as const;

describe("computeFileWordsSignature", () => {
  function parts(p: Partial<FileWordsParts> = {}): FileWordsParts {
    return {
      path: "Notes/Note A.md",
      basename: "Note A",
      aliases: ["Alias A"],
      excluded: false,
      tags: ["tag-a"],
      unresolvedNames: ["Phantom A"],
      ...p,
    };
  }

  it("differs when an alias is added", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(file, parts({ aliases: [] }));
    const after = computeFileWordsSignature(
      file,
      parts({ aliases: ["New Alias"] }),
    );
    expect(before).not.toBe(after);
  });

  it("differs when an alias is removed", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(
      file,
      parts({ aliases: ["One", "Two"] }),
    );
    const after = computeFileWordsSignature(file, parts({ aliases: ["One"] }));
    expect(before).not.toBe(after);
  });

  it("differs when the basename changes", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(
      file,
      parts({ basename: "Note A" }),
    );
    const after = computeFileWordsSignature(
      file,
      parts({ basename: "Note B" }),
    );
    expect(before).not.toBe(after);
  });

  it("differs when an unresolved name is added", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(
      file,
      parts({ unresolvedNames: [] }),
    );
    const after = computeFileWordsSignature(
      file,
      parts({ unresolvedNames: ["New Phantom"] }),
    );
    expect(before).not.toBe(after);
  });

  it("differs when an unresolved phantom is resolved (shrinks)", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(
      file,
      parts({ unresolvedNames: ["Phantom A", "Phantom B"] }),
    );
    const after = computeFileWordsSignature(
      file,
      parts({ unresolvedNames: ["Phantom A"] }),
    );
    expect(before).not.toBe(after);
  });

  it("differs when a tag is toggled", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(file, parts({ tags: [] }));
    const after = computeFileWordsSignature(
      file,
      parts({ tags: ["added-tag"] }),
    );
    expect(before).not.toBe(after);
  });

  it("differs when the exclusion flag is toggled", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(file, parts({ excluded: false }));
    const after = computeFileWordsSignature(file, parts({ excluded: true }));
    expect(before).not.toBe(after);
  });

  it("is equal for a prose-only edit", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(file, parts());
    const after = computeFileWordsSignature(file, parts());
    expect(before).toBe(after);
  });

  it("is equal when a link between two existing notes is created", () => {
    const file = createFile("Notes/Note A.md");
    // A new resolved link only touches resolvedLinks, which is not part of the
    // word signature.
    const before = computeFileWordsSignature(file, parts());
    const after = computeFileWordsSignature(file, parts());
    expect(before).toBe(after);
  });

  it("differs for a path-only rename with the same basename", () => {
    const file = createFile("Notes/Note A.md");
    const before = computeFileWordsSignature(
      file,
      parts({ path: "Notes/Note A.md" }),
    );
    const after = computeFileWordsSignature(
      file,
      parts({ path: "Archive/Note A.md" }),
    );
    expect(before).not.toBe(after);
  });
});

describe("computeInternalLinkSettingsSignature", () => {
  it("differs for every word-affecting setting", () => {
    const base = computeInternalLinkSettingsSignature(
      baseSettings as unknown as Parameters<
        typeof computeInternalLinkSettingsSignature
      >[0],
    );

    const wordAffecting: Array<keyof typeof baseSettings> = [
      "suggestInternalLinkWithAlias",
      "suggestAliasesOnly",
      "internalLinkIgnoreTriggerPrefixes",
      "excludeInternalLinkPathPrefixPatterns",
      "excludeInternalLinkPathGlobPatterns",
      "matchingWithoutEmoji",
      "treatAccentDiacriticsAsAlphabeticCharacters",
      "frontMatterKeyForExclusionInternalLink",
      "tagsForExclusionInternalLink",
      "excludeUnresolvedInternalLinks",
      "enableInternalLinkComplement",
    ];

    for (const key of wordAffecting) {
      const changed = { ...baseSettings } as any;
      if (Array.isArray(changed[key])) {
        changed[key] = ["changed"];
      } else if (typeof changed[key] === "boolean") {
        changed[key] = !changed[key];
      } else {
        changed[key] = "changed";
      }
      const next = computeInternalLinkSettingsSignature(changed);
      expect(next).not.toBe(base);
    }
  });

  it("is equal for non-word settings", () => {
    const base = computeInternalLinkSettingsSignature(
      baseSettings as unknown as Parameters<
        typeof computeInternalLinkSettingsSignature
      >[0],
    );
    const changed = {
      ...baseSettings,
      delayMilliSeconds: 9999,
      folderPriority: { enabled: true, limitingFolder: "Novel" },
      maxNumberOfSuggestions: 99,
    };
    const next = computeInternalLinkSettingsSignature(
      changed as unknown as Parameters<
        typeof computeInternalLinkSettingsSignature
      >[0],
    );
    expect(next).toBe(base);
  });
});

describe("collectFileWordsParts", () => {
  it("reads aliases, tags, and unresolved names from a single cache read", () => {
    const app = createApp({
      aliases: ["Alias A"],
      tags: ["tag-a", "tag-b"],
      unresolvedLinks: {
        "Notes/Note A.md": { "Phantom A": 1, "Phantom B": 2 },
      },
    });
    const file = createFile("Notes/Note A.md");
    const parts = collectFileWordsParts(
      app,
      undefined as any,
      file,
      baseOption,
    );
    expect(parts.aliases).toEqual(["Alias A"]);
    expect(parts.tags).toEqual(["tag-a", "tag-b"]);
    expect(parts.unresolvedNames).toEqual(["Phantom A", "Phantom B"]);
    expect(parts.excluded).toBe(false);
  });

  it("marks excluded when a tag matches", () => {
    const app = createApp({ tags: ["ignore"] });
    const file = createFile("Notes/Note A.md");
    const parts = collectFileWordsParts(app, undefined as any, file, {
      ...baseOption,
      tagsForExclusion: ["ignore"],
    });
    expect(parts.excluded).toBe(true);
  });

  it("marks excluded when the frontmatter key is set", () => {
    const app = createApp({
      frontmatter: { excludeFromComplement: true },
    });
    const file = createFile("Notes/Note A.md");
    const parts = collectFileWordsParts(app, undefined as any, file, {
      ...baseOption,
      frontMatterKeyForExclusion: "excludeFromComplement",
    });
    expect(parts.excluded).toBe(true);
  });
});

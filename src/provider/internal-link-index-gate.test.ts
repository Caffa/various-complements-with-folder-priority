import { describe, expect, it, jest } from "@jest/globals";
import { InternalLinkWordProvider } from "./InternalLinkWordProvider";
import {
  InternalLinkIndexGate,
  type StructureRefreshOp,
} from "./internal-link-index-gate";

function createGate(
  overrides: {
    signatures?: Record<string, number>;
    settingsSignature?: number;
    ignoredBasenames?: string[];
    patchFiles?: (paths: Set<string>) => void;
  } = {},
) {
  const storedSigs: Record<string, number> = { ...overrides.signatures };
  const refreshFull = jest.fn();
  const patchFiles = overrides.patchFiles;
  const computeFileSignature = jest.fn((path: string) => {
    return storedSigs[path] ?? 0;
  });
  const computeSettingsSignature = jest.fn(
    () => overrides.settingsSignature ?? 1,
  );
  const isIgnoredBasename = jest.fn((path: string) => {
    const basename = path.split("/").pop() ?? "";
    return (overrides.ignoredBasenames ?? []).includes(basename);
  });

  let now = 0;
  const timeouts: Array<() => void> = [];

  const gate = new InternalLinkIndexGate(
    {
      computeFileSignature,
      computeSettingsSignature,
      isIndexEnabled: () => true,
      refreshFull,
      patchFiles,
      isIgnoredBasename,
    },
    {
      idleThresholdMs: 2000,
      maxWaitMs: 10000,
      pollIntervalMs: 2000,
      now: () => now,
      scheduleTimeout: (fn, _ms) => {
        timeouts.push(fn);
        return timeouts.length;
      },
      cancelTimeout: () => {},
    },
  );

  function runTimeouts() {
    while (timeouts.length > 0) {
      const fn = timeouts.shift();
      fn?.();
    }
  }

  function setSignature(path: string, sig: number) {
    storedSigs[path] = sig;
  }

  return {
    gate,
    refreshFull,
    patchFiles,
    computeFileSignature,
    computeSettingsSignature,
    isIgnoredBasename,
    timeouts,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    runTimeouts,
    setSignature,
  };
}

describe("InternalLinkIndexGate", () => {
  it("does not rebuild when the signature is unchanged", () => {
    const c = createGate({ signatures: { "Notes/A.md": 42 } });
    c.gate.populateSignatures(["Notes/A.md"]);
    c.gate.requestSignatureCheck("Notes/A.md");
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).not.toHaveBeenCalled();
    expect(c.gate.stats.sigDiffsChecked).toBe(1);
  });

  it("rebuilds exactly once when many signatures differ", () => {
    const c = createGate({ signatures: {} });
    for (let i = 0; i < 500; i++) {
      c.gate.requestSignatureCheck(`Notes/Note ${i}.md`);
    }
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).toHaveBeenCalledTimes(1);
    expect(c.gate.stats.rebuildsCoalesced).toBe(1);
  });

  it("always treats ignore-prefix files as dirty", () => {
    const c = createGate({
      signatures: { "Notes/2024-01-01.md": 42 },
      ignoredBasenames: ["2024-01-01.md"],
    });
    c.gate.requestSignatureCheck("Notes/2024-01-01.md");
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).toHaveBeenCalledTimes(1);
    expect(c.isIgnoredBasename).toHaveBeenCalledWith("Notes/2024-01-01.md");
  });

  it("rebuilds when the settings signature changes", () => {
    const c = createGate({ signatures: { "Notes/A.md": 42 } });
    c.gate.noteSettingsChanged();
    c.gate.requestSignatureCheck("Notes/A.md");
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).toHaveBeenCalledTimes(1);
  });

  it("routes create/rename/delete as structure events", () => {
    const c = createGate({ signatures: { "Old/A.md": 42 } });
    c.gate.requestStructureRefresh({
      kind: "rename",
      path: "New/A.md",
      oldPath: "Old/A.md",
    } as StructureRefreshOp);
    c.gate.requestStructureRefresh({
      kind: "delete",
      path: "Gone/B.md",
    } as StructureRefreshOp);
    c.gate.requestStructureRefresh({
      kind: "create",
      path: "New/C.md",
    } as StructureRefreshOp);
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).toHaveBeenCalledTimes(1);
  });

  it("removes the old path signature on rename", () => {
    const c = createGate({ signatures: { "Old/A.md": 42 } });
    c.gate.requestStructureRefresh({
      kind: "rename",
      path: "New/A.md",
      oldPath: "Old/A.md",
    });
    expect(c.gate.stats.storedCount).toBe(0);
  });

  it("makes a no-op event after populateSignatures", () => {
    const c = createGate({ signatures: { "Notes/A.md": 42 } });
    c.gate.populateSignatures(["Notes/A.md"]);
    expect(c.gate.stats.storedCount).toBe(1);
    c.gate.requestSignatureCheck("Notes/A.md");
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).not.toHaveBeenCalled();
  });

  it("stop clears pending work", () => {
    const c = createGate({});
    c.gate.requestSignatureCheck("Notes/A.md");
    c.gate.stop();
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).not.toHaveBeenCalled();
    expect(c.gate.stats.pendingCount).toBe(0);
  });

  it("uses patchFiles when supplied and no structure event is present", () => {
    const patchFiles = jest.fn();
    const c = createGate({ signatures: {}, patchFiles });
    c.setSignature("Notes/A.md", 1);
    c.gate.requestSignatureCheck("Notes/A.md");
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).not.toHaveBeenCalled();
    expect(patchFiles).toHaveBeenCalledTimes(1);
    expect(patchFiles).toHaveBeenCalledWith(new Set(["Notes/A.md"]));
  });

  it("prefers refreshFull over patchFiles when a structure event is coalesced", () => {
    const patchFiles = jest.fn();
    const c = createGate({ signatures: {}, patchFiles });
    c.setSignature("Notes/A.md", 1);
    c.gate.requestSignatureCheck("Notes/A.md");
    c.gate.requestStructureRefresh({ kind: "create", path: "Notes/B.md" });
    c.now = 2500;
    c.runTimeouts();
    expect(c.refreshFull).toHaveBeenCalledTimes(1);
    expect(patchFiles).not.toHaveBeenCalled();
  });
});

describe("InternalLinkIndexGate integration with provider shim", () => {
  it("uses the real provider patchFiles on a changed signature", () => {
    const file = { path: "Notes/A.md", basename: "A" } as any;
    const app: any = {
      vault: {
        getMarkdownFiles: () => [file],
        getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
      },
      metadataCache: {
        resolvedLinks: {},
        unresolvedLinks: {},
        getFileCache: () => undefined,
      },
      workspace: { getActiveFile: () => null },
    };
    const appHelper = {
      app,
      getAliases: () => [],
      getBoolFrontMatter: () => false,
      getTagsProperty: () => [],
      searchPhantomLinks: () => [],
      getMarkdownFileByPath: (p: string) => (p === file.path ? file : null),
      getActiveFile: () => null,
    } as any;
    const provider = new InternalLinkWordProvider(app, appHelper);
    provider.refreshWords({
      wordAsInternalLinkAlias: false,
      suppressBasenameWhenAliases: false,
      excludePathPrefixPatterns: [],
      excludePathGlobPatterns: [],
      makeSynonymAboutEmoji: false,
      makeSynonymAboutAccentsDiacritics: false,
      frontMatterKeyForExclusion: "",
      tagsForExclusion: [],
      excludeUnresolvedLinks: false,
    });

    const refreshFull = jest.fn();
    let sig = 1;
    const timeouts: Array<() => void> = [];
    const gate = new InternalLinkIndexGate(
      {
        computeFileSignature: () => sig,
        computeSettingsSignature: () => 1,
        isIndexEnabled: () => true,
        refreshFull,
        patchFiles: (paths) => {
          provider.patchFiles(paths);
          provider.restampFileTier(null);
        },
        isIgnoredBasename: () => false,
      },
      {
        idleThresholdMs: 0,
        maxWaitMs: 0,
        pollIntervalMs: 0,
        now: () => 0,
        scheduleTimeout: (fn) => {
          timeouts.push(fn);
          return timeouts.length;
        },
        cancelTimeout: () => {},
      },
    );
    // Force immediate processing by running timeouts with idle delay.
    gate.populateSignatures(["Notes/A.md"]);
    sig = 2;
    gate.requestSignatureCheck("Notes/A.md");
    // max wait
    const realNow = Date.now;
    // simulate idle by overriding? Our scheduler uses Date.now; set now via opts already 0.
    // Run pending timeouts
    while (timeouts.length > 0) {
      const fn = timeouts.shift();
      fn?.();
    }
    expect(refreshFull).not.toHaveBeenCalled();
    expect(provider.wordCount).toBe(1);
  });
});

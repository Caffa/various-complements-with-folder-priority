import { AppHelper } from "../src/app-helper";
import type { Fixture } from "./fixtures";

export function makeApp(fixture: Fixture) {
  const files = fixture.files;
  const byPath = new Map(files.map((f: any) => [f.path, f]));
  const app: any = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
    },
    metadataCache: {
      resolvedLinks: fixture.resolvedLinks,
      unresolvedLinks: fixture.unresolvedLinks,
      getFileCache: () => undefined,
    },
    workspace: {
      getActiveFile: () => null,
      getLastOpenFiles: () => [],
      getLeaf: () => ({ openFile: async () => {} }),
      activeLeaf: null,
      getActiveViewOfType: () => null,
    },
    fileManager: { generateMarkdownLink: () => "" },
  };
  return { app, appHelper: new AppHelper(app) };
}

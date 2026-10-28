import { InternalLinkWordProvider } from "../../src/provider/InternalLinkWordProvider";
import { suggestWords } from "../../src/provider/suggester";
import { FolderRankCache } from "../../src/storage/FolderRankCache";
import { LinkRankIndex } from "../../src/storage/LinkRankIndex";
import { createFixture, CURRENT_FILE_PATH, LIMITING_FOLDER } from "../fixtures";
import { makeApp } from "../harness";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

export function scenarios(fixture = createFixture()): Scenario[] {
  const { app, appHelper } = makeApp(fixture);
  const chapterPaths = fixture.files
    .filter((f: any) => /Chapter - T\d+\.md$/.test(f.path))
    .map((f: any) => f.path as string);
  const queries = ["hu", "cn", "an", "xu", "wei", "chen", "shi", "lan"];

  return [
    {
      name: "session-sim 300 keystrokes",
      run: () => {
        const idx = new LinkRankIndex(app);
        const cache = new FolderRankCache(app, idx);
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
        const indexedWords: any = {
          currentFile: {},
          currentVault: {},
          customDictionary: {},
          internalLink: provider.wordsByFirstLetter,
          frontMatter: {},
        };
        idx.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);

        const changedPaths = chapterPaths.slice(0, 40);
        let changedIdx = 0;
        let total = 0;
        let stalls = 0;
        const KEYSTROKES = 300;
        for (let i = 0; i < KEYSTROKES; i++) {
          if (i % 8 === 0) {
            idx.markSourceStale(changedPaths[changedIdx % changedPaths.length]);
            changedIdx++;
          }
          const t0 = performance.now();
          const rankData = idx.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);
          const res = suggestWords(
            indexedWords,
            queries[i % queries.length],
            5,
            {
              folderPriority: {
                enabled: true,
                currentFilePath: CURRENT_FILE_PATH,
                limitingFolder: LIMITING_FOLDER,
                rankData,
                folderRankCache: cache,
              },
            } as any,
          );
          void res.length;
          const dt = performance.now() - t0;
          total += dt;
          if (dt > 16.7) stalls++;
        }
        const factor = 1200 / KEYSTROKES;
        // `candidates` column = extrapolated frame stalls per 1200 keystrokes.
        return { ms: total * factor, candidates: Math.round(stalls * factor) };
      },
    },
  ];
}

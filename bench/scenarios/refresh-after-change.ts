import { suggestWords } from "../../src/provider/suggester";
import { FolderRankCache } from "../../src/storage/FolderRankCache";
import { LinkRankIndex } from "../../src/storage/LinkRankIndex";
import { countMatchedCandidates } from "../candidates";
import { createFixture, CURRENT_FILE_PATH, LIMITING_FOLDER } from "../fixtures";
import { makeApp } from "../harness";
import { buildProviderSet } from "../internal-link";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

const QUERY = "cha";

/**
 * The per-save path.
 *
 * Obsidian fires `metadataCache.on("changed")` for the file being edited even
 * when it is only prose: the saved note's link set is identical. The plugin
 * responds with `markSourceStale(currentFilePath)` and then the next suggestion
 * pass does `getRankData(...)` + `suggestWords(...)`.
 *
 * What this measures: the cost of that pass when the link data did NOT change,
 * i.e. the delta-aware path where no global version bump (and therefore no
 * FolderRankCache invalidation) is expected. A red number here means per-save
 * work scaled with vault size again.
 *
 * Simulating the "changed" event: the entry in metadataCache.resolvedLinks for
 * the current file is replaced with an equal-content copy, then
 * markSourceStale() is called — same observable behaviour for the index, same
 * link set.
 */
export function scenarios(fixture = createFixture()): Scenario[] {
  const { app, appHelper } = makeApp(fixture);
  const index = new LinkRankIndex(app);
  const cache = new FolderRankCache(app, index);
  // Warm the global index so markSourceStale() has something to diff against.
  index.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);
  const warmVersion = index.currentVersion;

  const providerSet = buildProviderSet(app, appHelper, [["Char", "Chapter"]]);

  const replaceCurrentFileLinks = () => {
    const links = app.metadataCache.resolvedLinks[CURRENT_FILE_PATH];
    if (links !== undefined) {
      // Equal content, new object identity: exactly what a prose save produces
      // for this file from the index's point of view.
      app.metadataCache.resolvedLinks[CURRENT_FILE_PATH] = { ...links };
    }
  };

  const out: Scenario[] = [];
  for (const variant of providerSet.variants) {
    const indexedWords: any = {
      currentFile: {},
      currentVault: {},
      customDictionary: {},
      internalLink: variant.provider.wordsByFirstLetter,
      frontMatter: {},
    };
    const counts = countMatchedCandidates(
      variant.provider.wordsByFirstLetter,
      QUERY,
    );
    const suffix = variant.label === "" ? "" : `, ${variant.label}`;
    let reported = false;

    out.push({
      name: `refresh-after-change save (fp on${suffix})`,
      run: () => {
        replaceCurrentFileLinks();
        index.markSourceStale(CURRENT_FILE_PATH);
        const t = performance.now();
        const rankData = index.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);
        suggestWords(indexedWords, QUERY, 5, {
          folderPriority: {
            enabled: true,
            currentFilePath: CURRENT_FILE_PATH,
            limitingFolder: LIMITING_FOLDER,
            rankData,
            folderRankCache: cache,
          },
        } as any);
        const ms = performance.now() - t;

        if (!reported) {
          reported = true;
          const bumped = index.currentVersion !== warmVersion;
          console.log(
            `[bench] note: refresh-after-change${suffix || " (baseline)"} ` +
              `global version ${bumped ? "BUMPED (folder cache invalidated)" : "unchanged (delta-aware)"}`,
          );
        }

        return { ms, candidates: counts.matched, pool: counts.pool };
      },
    });
  }

  if (!providerSet.ignoreSupported) {
    console.log(
      "[bench] note: skipping refresh-after-change ignore-prefix variant",
    );
  }

  return out;
}

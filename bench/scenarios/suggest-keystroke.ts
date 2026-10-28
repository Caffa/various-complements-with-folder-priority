import { suggestWords } from "../../src/provider/suggester";
import { FolderRankCache } from "../../src/storage/FolderRankCache";
import { LinkRankIndex } from "../../src/storage/LinkRankIndex";
import { countMatchedCandidates } from "../candidates";
import { createFixture, CURRENT_FILE_PATH, LIMITING_FOLDER } from "../fixtures";
import { makeApp } from "../harness";
import { buildProviderSet, type ProviderVariant } from "../internal-link";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

const BASE_QUERIES = ["hu", "ch", "cha", "char"];
const PREFIX_QUERIES = ["ch", "cha", "char"];

export function scenarios(fixture = createFixture()): Scenario[] {
  const { app, appHelper } = makeApp(fixture);
  const index = new LinkRankIndex(app);
  const cache = new FolderRankCache(app, index);
  const rankData = index.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);

  // Baseline provider plus (if supported) providers that drop basenames starting
  // with "Char"/"Charapter"-style prefixes. Feature-detected: the option is
  // optional in InternalLinkWordProvider, so an older checkout just ignores it
  // and we log + skip rather than report a bogus candidate drop.
  const providerSet = buildProviderSet(app, appHelper, [
    ["Char", "Chapter"],
    ["Chapter"],
  ]);

  const indexedWordsFor = (variant: ProviderVariant) => ({
    currentFile: {},
    currentVault: {},
    customDictionary: {},
    internalLink: variant.provider.wordsByFirstLetter,
    frontMatter: {},
  });

  const folderPriorityOption = (rd: any) => ({
    folderPriority: {
      enabled: true,
      currentFilePath: CURRENT_FILE_PATH,
      limitingFolder: LIMITING_FOLDER,
      rankData: rd,
      folderRankCache: cache,
    },
  });

  const out: Scenario[] = [];

  // Baseline matrix: query x folder-priority on/off. Unchanged from the
  // original suite so old numbers stay comparable.
  for (const q of BASE_QUERIES) {
    const indexedWords = indexedWordsFor(providerSet.variants[0]);
    // True pre-truncation candidate count: judge() over the raw bucket,
    // not res.length (which is always <= 5).
    const counts = countMatchedCandidates(
      providerSet.variants[0].provider.wordsByFirstLetter,
      q,
    );
    for (const enabled of [false, true]) {
      out.push({
        name: `suggest-keystroke ${q} (fp ${enabled ? "on" : "off"})`,
        run: () => {
          const option = enabled ? folderPriorityOption(rankData) : {};
          const t = performance.now();
          suggestWords(indexedWords, q, 5, option as any);
          return {
            ms: performance.now() - t,
            candidates: counts.matched,
            pool: counts.pool,
          };
        },
      });
    }
  }

  // ignorePrefixes matrix (folder priority on): shows the candidate collapse
  // for prefixes that every "Char - ..." / "Chapter - ..." basename shares.
  for (const variant of providerSet.variants.slice(1)) {
    const indexedWords = indexedWordsFor(variant);
    for (const q of PREFIX_QUERIES) {
      const counts = countMatchedCandidates(
        variant.provider.wordsByFirstLetter,
        q,
      );
      out.push({
        name: `suggest-keystroke ${q} (fp on, ${variant.label})`,
        run: () => {
          const t = performance.now();
          suggestWords(
            indexedWords,
            q,
            5,
            folderPriorityOption(rankData) as any,
          );
          return {
            ms: performance.now() - t,
            candidates: counts.matched,
            pool: counts.pool,
          };
        },
      });
    }
  }

  return out;
}

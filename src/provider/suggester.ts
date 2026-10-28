import type { FolderPriorityOption, LinkRank } from "../model/LinkRank";
import { getOrComputeLinkRank } from "../model/LinkRank";
import { type Word, WordTypeMeta } from "../model/Word";
import type {
  HitWord,
  SelectionHistoryStorage,
} from "../storage/SelectionHistoryStorage";
import type { IndexedWords } from "../ui/AutoCompleteSuggest";
import { uniqWith } from "../util/collection-helper";
import {
  capitalizeFirstLetter,
  lowerStartsWith,
  microFuzzy,
  wrapFuzzy,
} from "../util/strings";

export type WordsByFirstLetter = { [firstLetter: string]: Word[] };

export interface Judgement {
  // TODO: want to replace to HitWord
  word: Word;
  // TODO: remove value. use word.hit instead
  value?: string;
  alias: boolean;
}

type JudgementLite = {
  word: Word;
  hit?: string;
  value?: string;
  alias: boolean;
  fuzzy?: boolean;
  startsQuery?: boolean;
  type: Word["type"];
};

function historyKey(lite: JudgementLite): HitWord {
  return {
    ...lite.word,
    hit: lite.hit!,
    value: lite.alias ? lite.word.value : lite.hit!,
  } as HitWord;
}

const NONE = { type: "none" as const };
const STARTS_CONCRETE = wrapFuzzy(lowerStartsWith);

export function suggestionUniqPredicate(a: Word, b: Word) {
  if (a.value !== b.value) {
    return false;
  }

  if (WordTypeMeta.of(a.type).group !== WordTypeMeta.of(b.type).group) {
    return false;
  }

  if (
    a.type === "internalLink" &&
    !a.phantom &&
    a.createdPath !== b.createdPath
  ) {
    return false;
  }

  return true;
}

export function pushWord(
  wordsByFirstLetter: WordsByFirstLetter,
  key: string,
  word: Word,
) {
  if (wordsByFirstLetter[key] === undefined) {
    wordsByFirstLetter[key] = [word];
    return;
  }

  wordsByFirstLetter[key].push(word);
}

// Select the top k items according to comparator, while preserving the order of
// equal items (stable). Uses O(N*k) insertion which is faster than O(N log N)
// for small k (typical maxNum <= 20).
export function selectTopK<T>(
  items: Iterable<T>,
  k: number,
  comparator: (a: T, b: T) => number,
): T[] {
  if (k <= 0) {
    return [];
  }
  const result: { item: T; seq: number }[] = [];
  let seq = 0;
  for (const item of items) {
    const currentSeq = seq++;
    if (result.length < k) {
      let inserted = false;
      for (let i = 0; i < result.length; i++) {
        const cmp = comparator(item, result[i].item);
        const tie = cmp === 0 ? currentSeq - result[i].seq : 0;
        if (cmp < 0 || (cmp === 0 && tie < 0)) {
          result.splice(i, 0, { item, seq: currentSeq });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        result.push({ item, seq: currentSeq });
      }
    } else {
      const worst = result[result.length - 1];
      const cmp = comparator(item, worst.item);
      const tie = cmp === 0 ? currentSeq - worst.seq : 0;
      if (cmp < 0 || (cmp === 0 && tie < 0)) {
        // replace worst
        result.pop();
        let inserted = false;
        for (let i = 0; i < result.length; i++) {
          const c2 = comparator(item, result[i].item);
          const tie2 = c2 === 0 ? currentSeq - result[i].seq : 0;
          if (c2 < 0 || (c2 === 0 && tie2 < 0)) {
            result.splice(i, 0, { item, seq: currentSeq });
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          result.push({ item, seq: currentSeq });
        }
      }
    }
  }
  return result.map((r) => r.item);
}

function compareFolderRankStage(
  aWord: Word,
  bWord: Word,
  linkRankOption: FolderPriorityOption,
  linkRanks: Map<Word, LinkRank>,
): number {
  if (!linkRankOption.enabled) {
    return 0;
  }
  if (aWord.type !== "internalLink" || bWord.type !== "internalLink") {
    return 0;
  }

  const rank = (w: Word): number =>
    getOrComputeLinkRank(w, linkRankOption, linkRanks)?.rank ??
    Number.POSITIVE_INFINITY;
  const aRank = rank(aWord);
  const bRank = rank(bWord);
  if (
    aRank === Number.POSITIVE_INFINITY &&
    bRank === Number.POSITIVE_INFINITY
  ) {
    return 0;
  }
  const d = aRank - bRank;
  return d === 0 ? 0 : d > 0 ? 1 : -1;
}

function materializeWord(lite: JudgementLite, query: string): Word {
  const hit = lite.hit!;
  if (lite.fuzzy === undefined) {
    return { ...lite.word, hit };
  }
  const base =
    !lite.alias && hit !== lite.word.value
      ? { ...lite.word, value: hit }
      : lite.word;
  return { ...base, hit, fuzzy: lite.fuzzy, query };
}

// Public for tests
export function judgeLite(
  word: Word,
  query: string,
  queryStartWithUpper: boolean,
  options?: {
    fuzzy?: {
      minMatchScore: number;
    };
  },
  queryLower?: string,
): JudgementLite {
  const qLower = queryLower ?? query.toLowerCase();
  if (query === "") {
    return {
      word,
      hit: word.value,
      value: word.value,
      alias: false,
      type: word.type,
    };
  }

  const useFuzzy = options?.fuzzy !== undefined;
  const valueLower = word.value.toLowerCase();
  const matched = useFuzzy
    ? microFuzzy(valueLower, qLower)
    : STARTS_CONCRETE(valueLower, qLower);
  if (
    matched.type === "concrete_match" ||
    (matched.type === "fuzzy_match" &&
      matched.score > (options?.fuzzy?.minMatchScore ?? 0))
  ) {
    if (
      queryStartWithUpper &&
      word.type !== "internalLink" &&
      word.type !== "frontMatter"
    ) {
      const c = capitalizeFirstLetter(word.value);
      return {
        word,
        hit: c,
        value: c,
        alias: false,
        fuzzy: matched.type === "fuzzy_match",
        type: word.type,
      };
    } else {
      return {
        word,
        hit: word.value,
        value: word.value,
        alias: false,
        fuzzy: matched.type === "fuzzy_match",
        type: word.type,
      };
    }
  }

  let chosenAlias: string | undefined;
  let aliasFuzzy = false;
  let aliasScore = 0;
  if (word.aliases) {
    for (const a of word.aliases) {
      const aLower = a.toLowerCase();
      const m = useFuzzy
        ? microFuzzy(aLower, qLower)
        : STARTS_CONCRETE(aLower, qLower);
      if (m.type === "concrete_match") {
        chosenAlias = a;
        aliasFuzzy = false;
        break;
      }
      if (chosenAlias === undefined && m.type === "fuzzy_match") {
        chosenAlias = a;
        aliasFuzzy = true;
        aliasScore = m.score;
      }
    }
  }
  if (
    chosenAlias !== undefined &&
    (!aliasFuzzy || aliasScore > (options?.fuzzy?.minMatchScore ?? 0))
  ) {
    return {
      word,
      hit: chosenAlias,
      value: chosenAlias,
      alias: true,
      fuzzy: aliasFuzzy,
      type: word.type,
    };
  }

  return { word, alias: false, type: word.type };
}

export function judge(
  word: Word,
  query: string,
  queryStartWithUpper: boolean,
  options?: {
    fuzzy?: {
      minMatchScore: number;
    };
  },
): Judgement {
  const lite = judgeLite(word, query, queryStartWithUpper, options);
  if (lite.hit === undefined) {
    return { word: lite.word, alias: false };
  }
  return {
    word: materializeWord(lite, query),
    value: lite.hit,
    alias: lite.alias,
  };
}

export function suggestWords(
  indexedWords: IndexedWords,
  query: string,
  maxNum: number,
  option: {
    frontMatter?: string;
    selectionHistoryStorage?: SelectionHistoryStorage;
    fuzzy?: {
      minMatchScore: number;
    };
    providerMinChars?: {
      currentFile: number;
      currentVault: number;
      customDictionary: number;
      internalLink: number;
    };
    globalMinChar?: number;
    folderPriority?: FolderPriorityOption;
    prioritizeAliases?: boolean;
    excludeInternalLink?: boolean;
  } = {},
): Word[] {
  const {
    frontMatter,
    selectionHistoryStorage,
    providerMinChars,
    globalMinChar,
    folderPriority,
    prioritizeAliases,
    excludeInternalLink,
  } = option;
  const queryStartWithUpper =
    query === "" || query.charAt(0).toUpperCase() === query.charAt(0);
  const queryLower = query.toLowerCase();
  const c0 = query.charAt(0);

  // プロバイダー別の最小文字数チェック関数
  const shouldIncludeProvider = (
    providerType: keyof NonNullable<typeof providerMinChars>,
  ): boolean => {
    if (excludeInternalLink && providerType === "internalLink") {
      return false;
    }
    if (!providerMinChars) {
      return true;
    }
    const minChars = providerMinChars[providerType] || globalMinChar || 0;
    return query.length >= minChars;
  };

  const flattenFrontMatterWords = () => {
    if (frontMatter === "alias" || frontMatter === "aliases") {
      return [];
    }
    if (frontMatter && indexedWords.frontMatter?.[frontMatter]) {
      return Object.values(indexedWords.frontMatter?.[frontMatter]).flat();
    }
    return [];
  };

  const words = queryStartWithUpper
    ? frontMatter
      ? flattenFrontMatterWords()
      : [
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[c0.toLowerCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[c0.toLowerCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[c0.toLowerCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[c0.toLowerCase()] ?? [])
            : []),
        ]
    : frontMatter
      ? flattenFrontMatterWords()
      : [
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[c0.toUpperCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[c0.toUpperCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[c0.toUpperCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[c0] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[c0.toUpperCase()] ?? [])
            : []),
        ];

  // Phase 1: cheap exact prefix matches only (no fuzzy, no aliases-as-infix).
  // Phase 2: run the full judge (fuzzy + aliases) only if Phase 1 did not
  // already produce enough candidates. Avoids expensive matching on the common
  // fast path where a simple prefix is enough.
  let filteredJudgement: JudgementLite[] = [];
  let latestUpdated = 0;
  if (query === "") {
    for (const w of words) {
      const lite: JudgementLite = {
        word: w,
        hit: w.value,
        value: w.value,
        alias: false,
        type: w.type,
      };
      filteredJudgement.push(lite);
      if (selectionHistoryStorage) {
        const lu =
          selectionHistoryStorage.getSelectionHistory(historyKey(lite))
            ?.lastUpdated ?? 0;
        if (lu > latestUpdated) {
          latestUpdated = lu;
        }
      }
    }
  } else {
    const exactLites: JudgementLite[] = [];
    const restWords: Word[] = [];
    for (const w of words) {
      const valueLower = w.value.toLowerCase();
      let lite: JudgementLite | undefined;
      if (valueLower.startsWith(queryLower)) {
        if (
          queryStartWithUpper &&
          w.type !== "internalLink" &&
          w.type !== "frontMatter"
        ) {
          const c = capitalizeFirstLetter(w.value);
          lite = {
            word: w,
            hit: c,
            value: c,
            alias: false,
            fuzzy: false,
            type: w.type,
          };
        } else {
          lite = {
            word: w,
            hit: w.value,
            value: w.value,
            alias: false,
            fuzzy: false,
            type: w.type,
          };
        }
      } else {
        let aliasHit: string | undefined;
        for (const a of w.aliases ?? []) {
          if (a.toLowerCase().startsWith(queryLower)) {
            aliasHit = a;
            break;
          }
        }
        if (aliasHit !== undefined) {
          lite = {
            word: w,
            hit: aliasHit,
            value: aliasHit,
            alias: true,
            fuzzy: false,
            type: w.type,
          };
        }
      }
      if (lite) {
        exactLites.push(lite);
        if (selectionHistoryStorage) {
          const lu =
            selectionHistoryStorage.getSelectionHistory(historyKey(lite))
              ?.lastUpdated ?? 0;
          if (lu > latestUpdated) {
            latestUpdated = lu;
          }
        }
      } else {
        restWords.push(w);
      }
    }
    filteredJudgement = exactLites;
    if (exactLites.length < maxNum && restWords.length > 0) {
      const restLites: JudgementLite[] = [];
      for (const w of restWords) {
        const lite = judgeLite(
          w,
          query,
          queryStartWithUpper,
          option,
          queryLower,
        );
        if (lite.hit !== undefined) {
          restLites.push(lite);
          if (selectionHistoryStorage) {
            const lu =
              selectionHistoryStorage.getSelectionHistory(historyKey(lite))
                ?.lastUpdated ?? 0;
            if (lu > latestUpdated) {
              latestUpdated = lu;
            }
          }
        }
      }
      filteredJudgement = [...exactLites, ...restLites];
    }
  }

  const linkRankOption: FolderPriorityOption = {
    enabled: folderPriority?.enabled ?? false,
    currentFilePath: folderPriority?.currentFilePath ?? null,
    limitingFolder: folderPriority?.limitingFolder ?? "",
    rankData: folderPriority?.rankData,
    folderRankCache: folderPriority?.folderRankCache,
  };
  const linkRanks = new Map<Word, LinkRank>();
  // F4: resolve the folder-rank list once per pass and store it on the option so
  // computeLinkRank reads it directly instead of calling getList once per word.
  if (
    linkRankOption.enabled &&
    linkRankOption.limitingFolder !== "" &&
    linkRankOption.currentFilePath !== null &&
    linkRankOption.folderRankCache &&
    linkRankOption.rankData
  ) {
    linkRankOption.cachedList = linkRankOption.folderRankCache.getList(
      linkRankOption.currentFilePath,
      linkRankOption.limitingFolder,
      linkRankOption.rankData,
    );
  }
  const compareLinkTier = (aWord: Word, bWord: Word): number => {
    if (!linkRankOption.enabled) {
      return 0;
    }
    if (aWord.type !== "internalLink" || bWord.type !== "internalLink") {
      return 0;
    }

    const aRank = getOrComputeLinkRank(aWord, linkRankOption, linkRanks);
    const bRank = getOrComputeLinkRank(bWord, linkRankOption, linkRanks);
    if (aRank === undefined || bRank === undefined) {
      return 0;
    }

    if (aRank.fileTier !== bRank.fileTier) {
      return aRank.fileTier ? -1 : 1;
    }

    const aScore = aRank.folderProximity?.score ?? -1;
    const bScore = bRank.folderProximity?.score ?? -1;
    if (aScore !== bScore) {
      return bScore - aScore;
    }

    const aLevel = aRank.folderProximity?.level ?? 999;
    const bLevel = bRank.folderProximity?.level ?? 999;
    if (aLevel !== bLevel) {
      return aLevel - bLevel;
    }

    return 0;
  };

  const candidate = selectTopK(filteredJudgement, maxNum, (a, b) => {
    const aWord = a.word;
    const bWord = b.word;

    if (a.fuzzy !== b.fuzzy) {
      return a.fuzzy ? 1 : -1;
    }

    const notSameWordType = aWord.type !== bWord.type;
    if (frontMatter && notSameWordType) {
      return bWord.type === "frontMatter" ? 1 : -1;
    }

    const linkTierResult = compareLinkTier(aWord, bWord);
    if (linkTierResult !== 0) {
      return linkTierResult;
    }

    // Alias priority only constrains same-target pairs. In multi-candidate
    // sorts this pin can form cycles with selection-history, leaving the
    // ranking order among cycle participants unspecified; no elements are lost.
    if (
      prioritizeAliases &&
      aWord.type === "internalLink" &&
      bWord.type === "internalLink"
    ) {
      const aTarget = aWord.createdPath ?? aWord.aliasMeta?.origin;
      const bTarget = bWord.createdPath ?? bWord.aliasMeta?.origin;
      if (
        aTarget !== undefined &&
        aTarget === bTarget &&
        !!aWord.aliasMeta !== !!bWord.aliasMeta
      ) {
        return aWord.aliasMeta ? -1 : 1;
      }
    }

    if (selectionHistoryStorage) {
      const aHitWord = historyKey(a);
      const bHitWord = historyKey(b);
      const ret = selectionHistoryStorage.compare(
        aHitWord,
        bHitWord,
        latestUpdated,
      );
      if (ret !== 0) {
        return ret;
      }
    }

    // keep in sync with the other chain (folder-rank stage)
    const folderRankResult = compareFolderRankStage(
      aWord,
      bWord,
      linkRankOption,
      linkRanks,
    );
    if (folderRankResult !== 0) {
      return folderRankResult;
    }

    if ((a.hit ?? "").length !== (b.hit ?? "").length) {
      return (a.hit ?? "").length > (b.hit ?? "").length ? 1 : -1;
    }
    if (notSameWordType) {
      return WordTypeMeta.of(bWord.type).priority >
        WordTypeMeta.of(aWord.type).priority
        ? 1
        : -1;
    }
    if (a.alias !== b.alias) {
      return prioritizeAliases === true ? (a.alias ? -1 : 1) : a.alias ? 1 : -1;
    }
    return 0;
  }).map((lite) => materializeWord(lite, query));

  // XXX: There is no guarantee that equals with max, but it is important for performance
  return uniqWith(candidate, suggestionUniqPredicate);
}

// Public for tests
export function judgeLiteByPartialMatch(
  word: Word,
  query: string,
  queryStartWithUpper: boolean,
  options?: {
    fuzzy?: {
      minMatchScore: number;
    };
  },
  queryLower?: string,
): JudgementLite {
  const qLower = queryLower ?? query.toLowerCase();
  if (query === "") {
    return {
      word,
      hit: word.value,
      value: word.value,
      alias: false,
      type: word.type,
    };
  }

  const useFuzzy = options?.fuzzy !== undefined;

  const minMatchScore = options?.fuzzy?.minMatchScore ?? 0;
  const matchStartsWith = (value: string) => {
    const valueLower = value.toLowerCase();
    if (useFuzzy) {
      if (valueLower[0] !== qLower[0]) {
        return NONE;
      }
      const m = microFuzzy(valueLower, qLower);
      if (m.type === "fuzzy_match" && m.score <= minMatchScore) {
        return NONE;
      }
      return m;
    }
    return valueLower.startsWith(qLower)
      ? { type: "concrete_match" as const }
      : NONE;
  };

  const matchIncludes = (value: string) => {
    const valueLower = value.toLowerCase();
    if (useFuzzy) {
      const m = microFuzzy(valueLower, qLower);
      if (m.type === "fuzzy_match" && m.score <= minMatchScore) {
        return NONE;
      }
      return m;
    }
    return valueLower.includes(qLower)
      ? { type: "concrete_match" as const }
      : NONE;
  };

  const startsWithMatched = matchStartsWith(word.value);
  if (startsWithMatched.type !== "none") {
    const fuzzy = startsWithMatched.type === "fuzzy_match";
    if (
      queryStartWithUpper &&
      word.type !== "internalLink" &&
      word.type !== "frontMatter"
    ) {
      const c = capitalizeFirstLetter(word.value);
      return {
        word,
        hit: c,
        value: c,
        alias: false,
        fuzzy,
        type: word.type,
      };
    }
    return {
      word,
      hit: word.value,
      value: word.value,
      alias: false,
      fuzzy,
      type: word.type,
    };
  }

  let chosenAlias: string | undefined;
  let aliasFuzzy = false;
  let aliasScore = 0;
  if (word.aliases) {
    for (const a of word.aliases) {
      const m = matchStartsWith(a);
      if (m.type === "concrete_match") {
        chosenAlias = a;
        aliasFuzzy = false;
        aliasScore = 0;
        break;
      }
      if (chosenAlias === undefined && m.type === "fuzzy_match") {
        chosenAlias = a;
        aliasFuzzy = true;
        aliasScore = m.score;
      }
    }
  }
  if (
    chosenAlias !== undefined &&
    (!aliasFuzzy || aliasScore > minMatchScore)
  ) {
    return {
      word,
      hit: chosenAlias,
      value: chosenAlias,
      alias: true,
      fuzzy: aliasFuzzy,
      type: word.type,
    };
  }

  const includesMatched = matchIncludes(word.value);
  if (includesMatched.type !== "none") {
    const fuzzy = includesMatched.type === "fuzzy_match";
    return {
      word,
      hit: word.value,
      value: word.value,
      alias: false,
      fuzzy,
      type: word.type,
    };
  }

  chosenAlias = undefined;
  aliasFuzzy = false;
  aliasScore = 0;
  if (word.aliases) {
    for (const a of word.aliases) {
      const m = matchIncludes(a);
      if (m.type === "concrete_match") {
        chosenAlias = a;
        aliasFuzzy = false;
        aliasScore = 0;
        break;
      }
      if (chosenAlias === undefined && m.type === "fuzzy_match") {
        chosenAlias = a;
        aliasFuzzy = true;
        aliasScore = m.score;
      }
    }
  }
  if (
    chosenAlias !== undefined &&
    (!aliasFuzzy || aliasScore > minMatchScore)
  ) {
    return {
      word,
      hit: chosenAlias,
      value: chosenAlias,
      alias: true,
      fuzzy: aliasFuzzy,
      type: word.type,
    };
  }

  return { word, alias: false, type: word.type };
}

export function judgeByPartialMatch(
  word: Word,
  query: string,
  queryStartWithUpper: boolean,
  options?: {
    fuzzy?: {
      minMatchScore: number;
    };
  },
): Judgement {
  const lite = judgeLiteByPartialMatch(
    word,
    query,
    queryStartWithUpper,
    options,
  );
  if (lite.hit === undefined) {
    return { word: lite.word, alias: false };
  }
  return {
    word: materializeWord(lite, query),
    value: lite.hit,
    alias: lite.alias,
  };
}

export function suggestWordsByPartialMatch(
  indexedWords: IndexedWords,
  query: string,
  maxNum: number,
  option: {
    frontMatter?: string;
    selectionHistoryStorage?: SelectionHistoryStorage;
    fuzzy?: {
      minMatchScore: number;
    };
    providerMinChars?: {
      currentFile: number;
      currentVault: number;
      customDictionary: number;
      internalLink: number;
    };
    globalMinChar?: number;
    folderPriority?: FolderPriorityOption;
    prioritizeAliases?: boolean;
    excludeInternalLink?: boolean;
  } = {},
): Word[] {
  const {
    frontMatter,
    selectionHistoryStorage,
    providerMinChars,
    globalMinChar,
    folderPriority,
    prioritizeAliases,
    excludeInternalLink,
  } = option;
  const queryStartWithUpper =
    query === "" || query.charAt(0).toUpperCase() === query.charAt(0);
  const queryLower = query.toLowerCase();

  // プロバイダー別の最小文字数チェック関数
  const shouldIncludeProvider = (
    providerType: keyof NonNullable<typeof providerMinChars>,
  ): boolean => {
    if (excludeInternalLink && providerType === "internalLink") {
      return false;
    }
    if (!providerMinChars) {
      return true;
    }
    const minChars = providerMinChars[providerType] || globalMinChar || 0;
    return query.length >= minChars;
  };

  const flatObjectValues = (object: { [firstLetter: string]: Word[] }) =>
    Object.values(object).flat();

  const flattenFrontMatterWords = () => {
    if (frontMatter === "alias" || frontMatter === "aliases") {
      return [];
    }
    if (frontMatter && indexedWords.frontMatter?.[frontMatter]) {
      return Object.values(indexedWords.frontMatter?.[frontMatter]).flat();
    }
    return [];
  };

  const words = frontMatter
    ? flattenFrontMatterWords()
    : [
        ...(shouldIncludeProvider("currentFile")
          ? flatObjectValues(indexedWords.currentFile)
          : []),
        ...(shouldIncludeProvider("currentVault")
          ? flatObjectValues(indexedWords.currentVault)
          : []),
        ...(shouldIncludeProvider("customDictionary")
          ? flatObjectValues(indexedWords.customDictionary)
          : []),
        ...(shouldIncludeProvider("internalLink")
          ? flatObjectValues(indexedWords.internalLink)
          : []),
      ];
  const filteredJudgement: JudgementLite[] = [];
  let latestUpdated = 0;
  for (const x of words) {
    const lite = judgeLiteByPartialMatch(
      x,
      query,
      queryStartWithUpper,
      option,
      queryLower,
    );
    if (lite.hit !== undefined) {
      lite.startsQuery = (lite.hit ?? "").toLowerCase().startsWith(queryLower);
      filteredJudgement.push(lite);
      if (selectionHistoryStorage) {
        const lu =
          selectionHistoryStorage.getSelectionHistory(historyKey(lite))
            ?.lastUpdated ?? 0;
        if (lu > latestUpdated) {
          latestUpdated = lu;
        }
      }
    }
  }

  const linkRankOption: FolderPriorityOption = {
    enabled: folderPriority?.enabled ?? false,
    currentFilePath: folderPriority?.currentFilePath ?? null,
    limitingFolder: folderPriority?.limitingFolder ?? "",
    rankData: folderPriority?.rankData,
    folderRankCache: folderPriority?.folderRankCache,
  };
  const linkRanks = new Map<Word, LinkRank>();
  // F4: resolve the folder-rank list once per pass and store it on the option so
  // computeLinkRank reads it directly instead of calling getList once per word.
  if (
    linkRankOption.enabled &&
    linkRankOption.limitingFolder !== "" &&
    linkRankOption.currentFilePath !== null &&
    linkRankOption.folderRankCache &&
    linkRankOption.rankData
  ) {
    linkRankOption.cachedList = linkRankOption.folderRankCache.getList(
      linkRankOption.currentFilePath,
      linkRankOption.limitingFolder,
      linkRankOption.rankData,
    );
  }
  const compareLinkTier = (aWord: Word, bWord: Word): number => {
    if (!linkRankOption.enabled) {
      return 0;
    }
    if (aWord.type !== "internalLink" || bWord.type !== "internalLink") {
      return 0;
    }

    const aRank = getOrComputeLinkRank(aWord, linkRankOption, linkRanks);
    const bRank = getOrComputeLinkRank(bWord, linkRankOption, linkRanks);
    if (aRank === undefined || bRank === undefined) {
      return 0;
    }

    if (aRank.fileTier !== bRank.fileTier) {
      return aRank.fileTier ? -1 : 1;
    }

    const aScore = aRank.folderProximity?.score ?? -1;
    const bScore = bRank.folderProximity?.score ?? -1;
    if (aScore !== bScore) {
      return bScore - aScore;
    }

    const aLevel = aRank.folderProximity?.level ?? 999;
    const bLevel = bRank.folderProximity?.level ?? 999;
    if (aLevel !== bLevel) {
      return aLevel - bLevel;
    }

    return 0;
  };

  const candidate = selectTopK(filteredJudgement, maxNum, (a, b) => {
    const aWord = a.word;
    const bWord = b.word;

    if (a.fuzzy !== b.fuzzy) {
      return a.fuzzy ? 1 : -1;
    }

    const notSameWordType = aWord.type !== bWord.type;
    if (frontMatter && notSameWordType) {
      return bWord.type === "frontMatter" ? 1 : -1;
    }

    const linkTierResult = compareLinkTier(aWord, bWord);
    if (linkTierResult !== 0) {
      return linkTierResult;
    }

    // Alias priority only constrains same-target pairs. In multi-candidate
    // sorts this pin can form cycles with selection-history, leaving the
    // ranking order among cycle participants unspecified; no elements are lost.
    if (
      prioritizeAliases &&
      aWord.type === "internalLink" &&
      bWord.type === "internalLink"
    ) {
      const aTarget = aWord.createdPath ?? aWord.aliasMeta?.origin;
      const bTarget = bWord.createdPath ?? bWord.aliasMeta?.origin;
      if (
        aTarget !== undefined &&
        aTarget === bTarget &&
        !!aWord.aliasMeta !== !!bWord.aliasMeta
      ) {
        return aWord.aliasMeta ? -1 : 1;
      }
    }

    if (selectionHistoryStorage) {
      const aHitWord = historyKey(a);
      const bHitWord = historyKey(b);
      const ret = selectionHistoryStorage.compare(
        aHitWord,
        bHitWord,
        latestUpdated,
      );
      if (ret !== 0) {
        return ret;
      }
    }

    if (a.startsQuery !== b.startsQuery) {
      return b.startsQuery ? 1 : -1;
    }

    // keep in sync with the other chain (folder-rank stage)
    const folderRankResult = compareFolderRankStage(
      aWord,
      bWord,
      linkRankOption,
      linkRanks,
    );
    if (folderRankResult !== 0) {
      return folderRankResult;
    }

    if ((a.hit ?? "").length !== (b.hit ?? "").length) {
      return (a.hit ?? "").length > (b.hit ?? "").length ? 1 : -1;
    }

    if (notSameWordType) {
      return WordTypeMeta.of(bWord.type).priority >
        WordTypeMeta.of(aWord.type).priority
        ? 1
        : -1;
    }
    if (a.alias !== b.alias) {
      return prioritizeAliases === true ? (a.alias ? -1 : 1) : a.alias ? 1 : -1;
    }
    return 0;
  }).map((lite) => materializeWord(lite, query));

  // XXX: There is no guarantee that equals with max, but it is important for performance
  return uniqWith(candidate, suggestionUniqPredicate);
}

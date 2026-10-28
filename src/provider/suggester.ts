import type { FolderPriorityOption, LinkRank } from "../model/LinkRank";
import { getOrComputeLinkRank } from "../model/LinkRank";
import { type Word, WordTypeMeta } from "../model/Word";
import type {
  HitWord,
  SelectionHistoryStorage,
} from "../storage/SelectionHistoryStorage";
import type { IndexedWords } from "../ui/AutoCompleteSuggest";
import { max, uniqWith } from "../util/collection-helper";
import {
  capitalizeFirstLetter,
  lowerFuzzy,
  lowerFuzzyStarsWith,
  lowerIncludes,
  lowerStartsWith,
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

// Public for tests
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
  if (query === "") {
    return {
      word: {
        ...word,
        hit: word.value,
      },
      value: word.value,
      alias: false,
    };
  }

  const matcher = options?.fuzzy ? lowerFuzzy : wrapFuzzy(lowerStartsWith);

  const matched = matcher(word.value, query);
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
        word: {
          ...word,
          value: c,
          hit: c,
          fuzzy: matched.type === "fuzzy_match",
          query,
        },
        value: c,
        alias: false,
      };
    } else {
      return {
        word: {
          ...word,
          hit: word.value,
          fuzzy: matched.type === "fuzzy_match",
          query,
        },
        value: word.value,
        alias: false,
      };
    }
  }

  const matchedAlias = word.aliases
    ?.map((a) => ({ aliases: a, matched: matcher(a, query) }))
    .sort((a, b) =>
      a.matched.type === "concrete_match" && b.matched.type !== "concrete_match"
        ? -1
        : 0,
    )
    .find((x) => x.matched.type !== "none");
  if (
    matchedAlias &&
    (matchedAlias.matched.type === "concrete_match" ||
      (matchedAlias.matched.type === "fuzzy_match" &&
        matchedAlias.matched.score > (options?.fuzzy?.minMatchScore ?? 0)))
  ) {
    return {
      word: {
        ...word,
        hit: matchedAlias.aliases,
        fuzzy: matchedAlias.matched.type === "fuzzy_match",
        query,
      },
      value: matchedAlias.aliases,
      alias: true,
    };
  }

  return {
    word,
    alias: false,
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
  const queryStartWithUpper = capitalizeFirstLetter(query) === query;

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
            ? (indexedWords.currentFile[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[query.charAt(0).toLowerCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[query.charAt(0).toLowerCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[query.charAt(0).toLowerCase()] ??
              [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[query.charAt(0).toLowerCase()] ?? [])
            : []),
        ]
    : frontMatter
      ? flattenFrontMatterWords()
      : [
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("currentFile")
            ? (indexedWords.currentFile[query.charAt(0).toUpperCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("currentVault")
            ? (indexedWords.currentVault[query.charAt(0).toUpperCase()] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("customDictionary")
            ? (indexedWords.customDictionary[query.charAt(0).toUpperCase()] ??
              [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[query.charAt(0)] ?? [])
            : []),
          ...(shouldIncludeProvider("internalLink")
            ? (indexedWords.internalLink[query.charAt(0).toUpperCase()] ?? [])
            : []),
        ];

  // Phase 1: cheap exact prefix matches only (no fuzzy, no aliases-as-infix).
  // Phase 2: run the full judge (fuzzy + aliases) only if Phase 1 did not
  // already produce enough candidates. Avoids expensive matching on the common
  // fast path where a simple prefix is enough.
  let filteredJudgement: Judgement[];
  if (query === "") {
    filteredJudgement = Array.from(words)
      .map((x) => judge(x, query, queryStartWithUpper, option))
      .filter((x) => x.value !== undefined);
  } else {
    const exactWords: Word[] = [];
    const restWords: Word[] = [];
    for (const w of words) {
      const isExact =
        lowerStartsWith(w.value, query) ||
        (w.aliases ?? []).some((a) => lowerStartsWith(a, query));
      if (isExact) {
        exactWords.push(w);
      } else {
        restWords.push(w);
      }
    }
    const exactJudged = exactWords
      .map((x) => judge(x, query, queryStartWithUpper, { fuzzy: undefined }))
      .filter((x) => x.value !== undefined);
    filteredJudgement = exactJudged;
    if (exactJudged.length < maxNum && restWords.length > 0) {
      const restJudged = restWords
        .map((x) => judge(x, query, queryStartWithUpper, option))
        .filter((x) => x.value !== undefined);
      filteredJudgement = [...exactJudged, ...restJudged];
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

  const latestUpdated = max(
    filteredJudgement.map(
      (x) =>
        selectionHistoryStorage?.getSelectionHistory(x.word as HitWord)
          ?.lastUpdated ?? 0,
    ),
    0,
  );

  const candidate = selectTopK(filteredJudgement, maxNum, (a, b) => {
    const aWord = a.word as HitWord;
    const bWord = b.word as HitWord;

    if (a.word.fuzzy !== b.word.fuzzy) {
      return a.word.fuzzy ? 1 : -1;
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
      const ret = selectionHistoryStorage.compare(aWord, bWord, latestUpdated);
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

    if ((a.value ?? "").length !== (b.value ?? "").length) {
      return (a.value ?? "").length > (b.value ?? "").length ? 1 : -1;
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
  }).map((x) => x.word);

  // XXX: There is no guarantee that equals with max, but it is important for performance
  return uniqWith(candidate, suggestionUniqPredicate);
}

// TODO: refactoring
// Public for tests
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
  if (query === "") {
    return {
      word: { ...word, hit: word.value },
      value: word.value,
      alias: false,
    };
  }

  const startsWithMatcher = options?.fuzzy
    ? lowerFuzzyStarsWith
    : wrapFuzzy(lowerStartsWith);
  const includesMatcher = options?.fuzzy
    ? lowerFuzzy
    : wrapFuzzy(lowerIncludes);

  const startsWithMatched = startsWithMatcher(word.value, query);
  if (
    startsWithMatched.type === "concrete_match" ||
    (startsWithMatched.type === "fuzzy_match" &&
      startsWithMatched.score > (options?.fuzzy?.minMatchScore ?? 0))
  ) {
    if (
      queryStartWithUpper &&
      word.type !== "internalLink" &&
      word.type !== "frontMatter"
    ) {
      const c = capitalizeFirstLetter(word.value);
      return {
        word: {
          ...word,
          value: c,
          hit: c,
          fuzzy: startsWithMatched.type === "fuzzy_match",
          query,
        },
        value: c,
        alias: false,
      };
    } else {
      return {
        word: {
          ...word,
          hit: word.value,
          fuzzy: startsWithMatched.type === "fuzzy_match",
          query,
        },
        value: word.value,
        alias: false,
      };
    }
  }

  const startsWithAliasMatched = word.aliases
    ?.map((a) => ({ aliases: a, matched: startsWithMatcher(a, query) }))
    .sort((a, b) =>
      a.matched.type === "concrete_match" && b.matched.type !== "concrete_match"
        ? -1
        : 0,
    )
    .find((x) => x.matched.type !== "none");
  if (
    startsWithAliasMatched &&
    (startsWithAliasMatched.matched.type === "concrete_match" ||
      (startsWithAliasMatched.matched.type === "fuzzy_match" &&
        startsWithAliasMatched.matched.score >
          (options?.fuzzy?.minMatchScore ?? 0)))
  ) {
    return {
      word: {
        ...word,
        hit: startsWithAliasMatched.aliases,
        fuzzy: startsWithAliasMatched.matched.type === "fuzzy_match",
        query,
      },
      value: startsWithAliasMatched.aliases,
      alias: true,
    };
  }

  const includesMatched = includesMatcher(word.value, query);
  if (
    includesMatched &&
    (includesMatched.type === "concrete_match" ||
      (includesMatched.type === "fuzzy_match" &&
        includesMatched.score > (options?.fuzzy?.minMatchScore ?? 0)))
  ) {
    return {
      word: {
        ...word,
        hit: word.value,
        fuzzy: includesMatched.type === "fuzzy_match",
        query,
      },
      value: word.value,
      alias: false,
    };
  }

  const matchedAliasIncluded = word.aliases
    ?.map((a) => ({ aliases: a, matched: includesMatcher(a, query) }))
    .sort((a, b) =>
      a.matched.type === "concrete_match" && b.matched.type !== "concrete_match"
        ? -1
        : 0,
    )
    .find((x) => x.matched.type !== "none");
  if (
    matchedAliasIncluded &&
    (matchedAliasIncluded.matched.type === "concrete_match" ||
      (matchedAliasIncluded.matched.type === "fuzzy_match" &&
        matchedAliasIncluded.matched.score >
          (options?.fuzzy?.minMatchScore ?? 0)))
  ) {
    return {
      word: {
        ...word,
        hit: matchedAliasIncluded.aliases,
        fuzzy: matchedAliasIncluded.matched.type === "fuzzy_match",
        query,
      },
      value: matchedAliasIncluded.aliases,
      alias: true,
    };
  }

  return { word: word, alias: false };
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
  const queryStartWithUpper = capitalizeFirstLetter(query) === query;

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
  const filteredJudgement = Array.from(words)
    .map((x) => judgeByPartialMatch(x, query, queryStartWithUpper, option))
    .filter((x) => x.value !== undefined);

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

  const latestUpdated = max(
    filteredJudgement.map(
      (x) =>
        selectionHistoryStorage?.getSelectionHistory(x.word as HitWord)
          ?.lastUpdated ?? 0,
    ),
    0,
  );

  const candidate = selectTopK(filteredJudgement, maxNum, (a, b) => {
    const aWord = a.word as HitWord;
    const bWord = b.word as HitWord;

    if (a.word.fuzzy !== b.word.fuzzy) {
      return a.word.fuzzy ? 1 : -1;
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
      const ret = selectionHistoryStorage.compare(aWord, bWord, latestUpdated);
      if (ret !== 0) {
        return ret;
      }
    }

    const as = lowerStartsWith(a.value ?? "", query);
    const bs = lowerStartsWith(b.value ?? "", query);
    if (as !== bs) {
      return bs ? 1 : -1;
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

    if ((a.value ?? "").length !== (b.value ?? "").length) {
      return (a.value ?? "").length > (b.value ?? "").length ? 1 : -1;
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
  }).map((x) => x.word);

  // XXX: There is no guarantee that equals with max, but it is important for performance
  return uniqWith(candidate, suggestionUniqPredicate);
}

import type { App, TFile } from "obsidian";
import { hasSameElement } from "../../src/util/collection-helper";
import type { AppHelper } from "../app-helper";
import type { FolderPriorityOption, LinkRankData } from "../model/LinkRank";
import { computeLinkRank } from "../model/LinkRank";
import type { InternalLinkWord, Word } from "../model/Word";
import { isMatchedGlobPatterns } from "../util/glob";
import { synonymAliases } from "../util/strings";
import { pushWord, type WordsByFirstLetter } from "./suggester";

export type InternalLinkRefreshStats = {
  at: number;
  ms: number;
  resolvedWordCount: number;
  phantomWordCount: number;
};

export class InternalLinkWordProvider {
  private words: Word[] = [];
  wordsByFirstLetter: WordsByFirstLetter = {};
  // Holds arrays of shared word object references keyed by source path.
  // Memory: O(number of distinct source paths) for Map + array shells; the
  // word objects themselves are the same references stored in `words`, so
  // this does not duplicate the word payloads.
  private wordsByPath = new Map<string, InternalLinkWord[]>();
  private fileTierTargets = new Set<string>();
  private lastOption?: {
    wordAsInternalLinkAlias: boolean;
    suppressBasenameWhenAliases: boolean;
    excludePathPrefixPatterns: string[];
    excludePathGlobPatterns: string[];
    makeSynonymAboutEmoji: boolean;
    makeSynonymAboutAccentsDiacritics: boolean;
    frontMatterKeyForExclusion: string;
    tagsForExclusion: string[];
    excludeUnresolvedLinks: boolean;
    ignorePrefixes?: string[];
  };
  lastRefresh?: InternalLinkRefreshStats;

  constructor(
    private app: App,
    private appHelper: AppHelper,
  ) {}

  refreshWords(option: {
    wordAsInternalLinkAlias: boolean;
    suppressBasenameWhenAliases: boolean;
    excludePathPrefixPatterns: string[];
    excludePathGlobPatterns: string[];
    makeSynonymAboutEmoji: boolean;
    makeSynonymAboutAccentsDiacritics: boolean;
    frontMatterKeyForExclusion: string;
    tagsForExclusion: string[];
    excludeUnresolvedLinks: boolean;
    ignorePrefixes?: string[];
  }): void {
    const start = performance.now();
    this.lastOption = {
      wordAsInternalLinkAlias: option.wordAsInternalLinkAlias,
      suppressBasenameWhenAliases: option.suppressBasenameWhenAliases,
      excludePathPrefixPatterns: option.excludePathPrefixPatterns,
      excludePathGlobPatterns: option.excludePathGlobPatterns,
      makeSynonymAboutEmoji: option.makeSynonymAboutEmoji,
      makeSynonymAboutAccentsDiacritics:
        option.makeSynonymAboutAccentsDiacritics,
      frontMatterKeyForExclusion: option.frontMatterKeyForExclusion,
      tagsForExclusion: option.tagsForExclusion,
      excludeUnresolvedLinks: option.excludeUnresolvedLinks,
      ignorePrefixes: option.ignorePrefixes
        ? [...option.ignorePrefixes]
        : undefined,
    };
    this.clearWords();

    const ignoredPrefixPatterns = (option.ignorePrefixes ?? [])
      .map((prefix: any) => prefix.trim().toLowerCase())
      .filter((prefix: any) => prefix.length > 0)
      .map(
        (prefix: any) =>
          new RegExp(`^${escapeRegExp(prefix)}[\\s\\-\\u2014\\u2013:_·]+`),
      );

    const isIgnoredBasename = (value: string): boolean => {
      const lower = value.toLowerCase();
      return ignoredPrefixPatterns.some((pattern: any) => pattern.test(lower));
    };

    const excludedSourcePaths = new Set<string>();
    try {
      const resolvedInternalLinkWords: InternalLinkWord[] = this.app.vault
        .getMarkdownFiles()
        .filter((f) => {
          if (
            option.excludePathPrefixPatterns.some((x) => f.path.startsWith(x))
          ) {
            excludedSourcePaths.add(f.path);
            return false;
          }

          if (isMatchedGlobPatterns(f.path, option.excludePathGlobPatterns)) {
            excludedSourcePaths.add(f.path);
            return false;
          }

          const fmkfc = option.frontMatterKeyForExclusion;
          if (fmkfc && this.appHelper.getBoolFrontMatter(f, fmkfc)) {
            excludedSourcePaths.add(f.path);
            return false;
          }

          if (option.tagsForExclusion.length > 0) {
            const tags = this.appHelper.getTagsProperty(f);
            if (hasSameElement(option.tagsForExclusion, tags)) {
              excludedSourcePaths.add(f.path);
              return false;
            }
          }

          return true;
        })
        .flatMap((x) => {
          const aliases = this.appHelper.getAliases(x);

          if (option.wordAsInternalLinkAlias) {
            const aliasWords = aliases.map((a) => ({
              value: a,
              type: "internalLink" as const,
              createdPath: x.path,
              aliases: synonymAliases(a, {
                emoji: option.makeSynonymAboutEmoji,
                accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
              }),
              description: x.path,
              aliasMeta: {
                origin: x.path,
              },
            }));
            if (option.suppressBasenameWhenAliases && aliases.length > 0) {
              return aliasWords as InternalLinkWord[];
            }
            if (isIgnoredBasename(x.basename)) {
              return aliasWords as InternalLinkWord[];
            }
            return [
              {
                value: x.basename,
                type: "internalLink" as const,
                createdPath: x.path,
                aliases: synonymAliases(x.basename, {
                  emoji: option.makeSynonymAboutEmoji,
                  accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
                }),
                description: x.path,
              },
              ...aliasWords,
            ] as InternalLinkWord[];
          } else {
            if (isIgnoredBasename(x.basename)) {
              return [] as InternalLinkWord[];
            }
            return [
              {
                value: x.basename,
                type: "internalLink" as const,
                createdPath: x.path,
                aliases: [
                  ...synonymAliases(x.basename, {
                    emoji: option.makeSynonymAboutEmoji,
                    accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
                  }),
                  ...aliases,
                  ...aliases.flatMap((al) =>
                    synonymAliases(al, {
                      emoji: option.makeSynonymAboutEmoji,
                      accentsDiacritics:
                        option.makeSynonymAboutAccentsDiacritics,
                    }),
                  ),
                ],
                description: x.path,
              },
            ] as InternalLinkWord[];
          }
        });

      const unresolvedInternalLinkWords: InternalLinkWord[] =
        option.excludeUnresolvedLinks
          ? []
          : this.appHelper
              .searchPhantomLinks()
              .filter(({ path }) => !excludedSourcePaths.has(path))
              .map(({ path, link }) => {
                return {
                  value: link,
                  type: "internalLink" as const,
                  createdPath: path,
                  aliases: synonymAliases(link, {
                    emoji: option.makeSynonymAboutEmoji,
                    accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
                  }),
                  description: `Appeared in -> ${path}`,
                  phantom: true,
                };
              });

      this.words = [
        ...resolvedInternalLinkWords,
        ...unresolvedInternalLinkWords,
      ];

      const grouped = new Map<string, InternalLinkWord[]>();
      for (const word of this.words as InternalLinkWord[]) {
        const bucket = grouped.get(word.createdPath) ?? [];
        bucket.push(word);
        grouped.set(word.createdPath, bucket);
      }
      this.wordsByPath = grouped;

      for (const word of this.words) {
        pushWord(this.wordsByFirstLetter, word.value.charAt(0), word);
        word.aliases?.forEach((a) =>
          pushWord(this.wordsByFirstLetter, a.charAt(0), word),
        );
      }

      this.lastRefresh = {
        at: Date.now(),
        ms: performance.now() - start,
        resolvedWordCount: resolvedInternalLinkWords.length,
        phantomWordCount: unresolvedInternalLinkWords.length,
      };
    } catch (e) {
      // Leave lastRefresh unchanged on failure so status never reports stale
      // counts; clearWords() has already emptied the index.
      throw e;
    }
  }

  createAnnotateIterator(
    currentFilePath: string | null,
    limitingFolder: string,
    rankData: LinkRankData,
    folderRankCache?: any,
    startFrom = 0,
  ): Generator<void> {
    return this.annotateGenerator(
      currentFilePath,
      limitingFolder,
      rankData,
      folderRankCache,
      startFrom,
    );
  }

  private *annotateGenerator(
    currentFilePath: string | null,
    limitingFolder: string,
    rankData: LinkRankData,
    folderRankCache?: any,
    startFrom = 0,
  ): Generator<void> {
    // Option assembly runs ONCE before iteration (could not chunk without
    // restructuring LinkRankIndex.rebuild, which is out of scope).
    const option: FolderPriorityOption = {
      enabled: limitingFolder !== "",
      currentFilePath,
      limitingFolder,
      rankData,
      folderRankCache,
    };
    const cachedList =
      limitingFolder !== "" &&
      currentFilePath !== null &&
      folderRankCache &&
      rankData
        ? folderRankCache.getList(currentFilePath, limitingFolder, rankData)
        : undefined;
    option.cachedList = cachedList;

    const words = this.words;
    const total = words.length;
    let index = Math.max(0, Math.min(startFrom ?? 0, total));
    while (index < total) {
      const word = words[index++];
      if (word.type === "internalLink") {
        const lr = computeLinkRank(word as any, option);
        const ilw = word as any;
        ilw.fileTier = lr.fileTier;
        ilw.folderProximity = lr.folderProximity;
        ilw.linkRank = lr.rank;
        ilw._rankPrecomputed = true;
      }
      yield;
    }
  }

  annotateRankData(
    currentFilePath: string | null,
    limitingFolder: string,
    rankData: LinkRankData,
    folderRankCache?: any,
  ): void {
    // Degenerate loop: keeps existing callers working unchanged.
    for (const _unused of this.createAnnotateIterator(
      currentFilePath,
      limitingFolder,
      rankData,
      folderRankCache,
    )) {
      // consumed fully
    }
  }

  patchFiles(paths: Set<string>): void {
    if (!paths || paths.size === 0) {
      return;
    }

    const option = this.lastOption;
    // Derive ALL new word arrays first (transactional): if any derivation
    // throws, the index remains untouched.
    const derived = new Map<string, InternalLinkWord[]>();
    for (const path of paths) {
      derived.set(path, this.deriveWordsForPath(path, option));
    }

    // Remove the previous words for each path by object identity.
    for (const path of paths) {
      const old = this.wordsByPath.get(path) ?? [];
      this.removeWords(old);
    }

    // Add the newly derived words via the same pushWord path as rebuilds.
    for (const [path, words] of derived) {
      if (words.length === 0) {
        this.wordsByPath.delete(path);
      } else {
        this.wordsByPath.set(path, words);
      }
      this.addWords(words);
    }
  }

  private deriveWordsForPath(path: string, option: any): InternalLinkWord[] {
    if (!option) {
      return [];
    }

    const ignoredPrefixPatterns = (option.ignorePrefixes ?? [])
      .map((prefix: any) => prefix.trim().toLowerCase())
      .filter((prefix: any) => prefix.length > 0)
      .map(
        (prefix: any) =>
          new RegExp(`^${escapeRegExp(prefix)}[\\s\\-\\u2014\\u2013:_·]+`),
      );
    const isIgnoredBasename = (value: string): boolean => {
      const lower = value.toLowerCase();
      return ignoredPrefixPatterns.some((pattern: any) => pattern.test(lower));
    };

    const result: InternalLinkWord[] = [];

    const file: TFile | undefined =
      ((this.appHelper.getMarkdownFileByPath
        ? this.appHelper.getMarkdownFileByPath(path)
        : null) as TFile | undefined) ??
      (this.app.vault.getAbstractFileByPath?.(path) as TFile | undefined) ??
      undefined;

    let excluded = false;
    if (
      option.excludePathPrefixPatterns.some((prefix: any) =>
        path.startsWith(prefix),
      )
    ) {
      excluded = true;
    }
    if (
      !excluded &&
      isMatchedGlobPatterns(path, option.excludePathGlobPatterns)
    ) {
      excluded = true;
    }
    if (!excluded && file) {
      const fmkfc = option.frontMatterKeyForExclusion;
      if (fmkfc && this.appHelper.getBoolFrontMatter(file, fmkfc)) {
        excluded = true;
      }
      if (!excluded && option.tagsForExclusion.length > 0) {
        const tags = this.appHelper.getTagsProperty(file);
        if (hasSameElement(option.tagsForExclusion, tags)) {
          excluded = true;
        }
      }
    }

    if (!excluded && file) {
      const aliases = this.appHelper.getAliases(file);
      const makeSynonym = {
        emoji: option.makeSynonymAboutEmoji,
        accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
      };

      if (option.wordAsInternalLinkAlias) {
        const aliasWords = aliases.map((a) => ({
          value: a,
          type: "internalLink" as const,
          createdPath: path,
          aliases: synonymAliases(a, makeSynonym),
          description: path,
          aliasMeta: { origin: path },
        }));
        if (option.suppressBasenameWhenAliases && aliases.length > 0) {
          if (!isIgnoredBasename(file.basename)) {
            // alias-only branch: aliases may still include basename variants?
          }
          result.push(...aliasWords);
        } else {
          if (isIgnoredBasename(file.basename)) {
            result.push(...aliasWords);
          } else {
            result.push(
              {
                value: file.basename,
                type: "internalLink" as const,
                createdPath: path,
                aliases: synonymAliases(file.basename, makeSynonym),
                description: path,
              },
              ...aliasWords,
            );
          }
        }
      } else {
        if (!isIgnoredBasename(file.basename)) {
          result.push({
            value: file.basename,
            type: "internalLink" as const,
            createdPath: path,
            aliases: [
              ...synonymAliases(file.basename, makeSynonym),
              ...aliases,
              ...aliases.flatMap((al) => synonymAliases(al, makeSynonym)),
            ],
            description: path,
          });
        }
      }
    }

    if (excluded) {
      return [];
    }

    if (!option.excludeUnresolvedLinks) {
      const phantoms = this.appHelper
        .searchPhantomLinks()
        .filter(({ path: sourcePath }) => sourcePath === path)
        .map(({ link }) => ({
          value: link,
          type: "internalLink" as const,
          createdPath: path,
          aliases: synonymAliases(link, {
            emoji: option.makeSynonymAboutEmoji,
            accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
          }),
          description: `Appeared in -> ${path}`,
          phantom: true,
        }));
      result.push(...phantoms);
    }

    return result;
  }

  private removeWords(words: InternalLinkWord[]): void {
    const ids = new Set<InternalLinkWord>(words);
    this.words = this.words.filter((word) => !ids.has(word as any));
    for (const key of Object.keys(this.wordsByFirstLetter)) {
      const filtered = this.wordsByFirstLetter[key].filter(
        (word) => !ids.has(word as any),
      );
      if (filtered.length === 0) {
        delete this.wordsByFirstLetter[key];
      } else {
        this.wordsByFirstLetter[key] = filtered;
      }
    }
  }

  private addWords(words: InternalLinkWord[]): void {
    for (const word of words) {
      this.words.push(word);
    }
    for (const word of words) {
      pushWord(this.wordsByFirstLetter, word.value.charAt(0), word);
      word.aliases?.forEach((alias) =>
        pushWord(this.wordsByFirstLetter, alias.charAt(0), word),
      );
    }
  }

  restampFileTier(activePath: string | null): void {
    if (!activePath) {
      return;
    }
    const resolved =
      (
        this.app.metadataCache.resolvedLinks as
          | Record<string, Record<string, number>>
          | undefined
      )?.[activePath] ?? {};
    const newTargets = new Set(Object.keys(resolved));

    const affected = new Set<string>([...this.fileTierTargets, ...newTargets]);
    for (const path of affected) {
      const words = this.wordsByPath.get(path);
      if (!words) continue;
      const isTarget = newTargets.has(path);
      for (const word of words) {
        (word as any).fileTier = isTarget;
      }
    }
    this.fileTierTargets = newTargets;
  }

  clearWords(): void {
    this.words = [];
    this.wordsByFirstLetter = {};
    this.wordsByPath.clear();
    this.fileTierTargets.clear();
  }

  get wordCount(): number {
    return this.words.length;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

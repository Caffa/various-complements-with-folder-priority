import type { App } from "obsidian";
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
    currentFilePath?: string;
  }): void {
    const start = performance.now();
    this.clearWords();

    const ignoredPrefixPatterns = (option.ignorePrefixes ?? [])
      .map((prefix) => prefix.trim().toLowerCase())
      .filter((prefix) => prefix.length > 0)
      .map(
        (prefix) =>
          new RegExp(`^${escapeRegExp(prefix)}[\\s\\-\\u2014\\u2013:_·]+`),
      );

    const isIgnoredBasename = (value: string): boolean => {
      const lower = value.toLowerCase();
      return ignoredPrefixPatterns.some((pattern) => pattern.test(lower));
    };

    try {
      const resolvedInternalLinkWords: InternalLinkWord[] = this.app.vault
        .getMarkdownFiles()
        .filter((f) => {
          if (
            option.excludePathPrefixPatterns.some((x) => f.path.startsWith(x))
          ) {
            return false;
          }

          if (isMatchedGlobPatterns(f.path, option.excludePathGlobPatterns)) {
            return false;
          }

          const fmkfc = option.frontMatterKeyForExclusion;
          if (fmkfc && this.appHelper.getBoolFrontMatter(f, fmkfc)) {
            return false;
          }

          if (option.tagsForExclusion.length > 0) {
            const tags = this.appHelper.getTagsProperty(f);
            if (hasSameElement(option.tagsForExclusion, tags)) {
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
          : this.appHelper.searchPhantomLinks().map(({ path, link }) => {
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

      // Precompute current-file membership ("fileTier") onto internal-link
      // words at refresh time instead of per-candidate Map lookup during sort.
      // Only set when currentFilePath is provided; otherwise leave undefined so
      // computeLinkRank can fall back to the live rankData.
      if (option.currentFilePath) {
        const currentFileTargets = new Set<string>();
        const currentFileUnresolvedNames = new Set<string>();
        const resolvedLinkMap =
          this.app.metadataCache.resolvedLinks?.[option.currentFilePath] ?? {};
        for (const target of Object.keys(resolvedLinkMap)) {
          currentFileTargets.add(target);
        }
        const unresolvedLinkMap =
          this.app.metadataCache.unresolvedLinks?.[option.currentFilePath] ??
          {};
        for (const name of Object.keys(unresolvedLinkMap)) {
          currentFileUnresolvedNames.add(name.toLowerCase());
        }
        for (const word of this.words) {
          const ilw = word as InternalLinkWord;
          if (ilw.phantom) {
            ilw.fileTier = currentFileUnresolvedNames.has(
              word.value.toLowerCase(),
            );
          } else {
            const target = ilw.createdPath ?? ilw.aliasMeta?.origin;
            ilw.fileTier =
              target !== undefined && currentFileTargets.has(target);
          }
        }
      }

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

  annotateRankData(
    currentFilePath: string | null,
    limitingFolder: string,
    rankData: LinkRankData,
    folderRankCache?: any,
  ): void {
    // Only meaningful when folder priority is enabled (caller guards), but be
    // defensive: an empty limiting folder still benefits from fileTier precompute.
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

    for (const word of this.words) {
      if (word.type !== "internalLink") {
        continue;
      }
      const lr = computeLinkRank(word as any, option);
      const ilw = word as any;
      ilw.fileTier = lr.fileTier;
      ilw.folderProximity = lr.folderProximity;
      ilw.linkRank = lr.rank;
      ilw._rankPrecomputed = true;
    }
  }

  clearWords(): void {
    this.words = [];
    this.wordsByFirstLetter = {};
  }

  get wordCount(): number {
    return this.words.length;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

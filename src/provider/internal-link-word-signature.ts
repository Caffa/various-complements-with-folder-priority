import type { App, TFile } from "obsidian";
import type { AppHelper } from "../app-helper";
import type { Settings } from "../setting/settings";
import { isMatchedGlobPatterns } from "../util/glob";

export const SEPARATOR = "\u0001";
export const LIST_SEPARATOR = "\u0002";

export type FileWordsParts = {
  path: string;
  basename: string;
  aliases: string[];
  excluded: boolean;
  tags: string[];
  unresolvedNames: string[];
};

export type CollectFileWordsPartsOption = {
  excludePathPrefixPatterns: string[];
  excludePathGlobPatterns: string[];
  frontMatterKeyForExclusion: string;
  tagsForExclusion: string[];
};

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sortedJoined(values: string[], separator: string): string {
  return values.slice().sort().join(separator);
}

export function computeFileWordsSignature(
  file: TFile,
  parts: Omit<FileWordsParts, "path" | "basename"> & {
    path?: string;
    basename?: string;
  },
): number {
  const path = parts.path ?? file.path;
  const basename = parts.basename ?? file.basename;
  const payload = [
    path,
    SEPARATOR,
    basename,
    SEPARATOR,
    sortedJoined(parts.aliases, LIST_SEPARATOR),
    SEPARATOR,
    parts.excluded ? "1" : "0",
    SEPARATOR,
    sortedJoined(parts.tags, LIST_SEPARATOR),
    SEPARATOR,
    sortedJoined(parts.unresolvedNames, LIST_SEPARATOR),
  ].join("");
  return fnv1a32(payload);
}

export function computeInternalLinkSettingsSignature(
  settings: Settings,
): number {
  const payload = [
    settings.suggestInternalLinkWithAlias ? "1" : "0",
    SEPARATOR,
    settings.suggestAliasesOnly ? "1" : "0",
    SEPARATOR,
    settings.internalLinkIgnoreTriggerPrefixes,
    SEPARATOR,
    settings.excludeInternalLinkPathPrefixPatterns,
    SEPARATOR,
    sortedJoined(settings.excludeInternalLinkPathGlobPatterns, LIST_SEPARATOR),
    SEPARATOR,
    settings.matchingWithoutEmoji ? "1" : "0",
    SEPARATOR,
    settings.treatAccentDiacriticsAsAlphabeticCharacters ? "1" : "0",
    SEPARATOR,
    settings.frontMatterKeyForExclusionInternalLink,
    SEPARATOR,
    sortedJoined(settings.tagsForExclusionInternalLink, LIST_SEPARATOR),
    SEPARATOR,
    settings.excludeUnresolvedInternalLinks ? "1" : "0",
    SEPARATOR,
    settings.enableInternalLinkComplement ? "1" : "0",
  ].join("");
  return fnv1a32(payload);
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export function collectFileWordsParts(
  app: App,
  appHelper: AppHelper | any,
  file: TFile,
  option: CollectFileWordsPartsOption,
): FileWordsParts {
  // ONE getFileCache call per file; derive aliases/tags directly from the
  // returned frontmatter so repeated helpers do not re-read the cache.
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;

  let aliases = coerceStringArray(frontmatter?.aliases ?? frontmatter?.alias);
  if (aliases.length === 0 && appHelper?.getAliases) {
    aliases = coerceStringArray(appHelper.getAliases(file));
  }

  let tags = coerceStringArray(frontmatter?.tags).map((tag) =>
    tag.startsWith("#") ? tag.slice(1) : tag,
  );
  if (tags.length === 0 && appHelper?.getTagsProperty) {
    tags = coerceStringArray(appHelper.getTagsProperty(file));
  }

  const excludedByFrontmatter =
    option.frontMatterKeyForExclusion.length > 0 &&
    frontmatter != null &&
    Boolean(frontmatter[option.frontMatterKeyForExclusion]);

  const hasExcludedTag =
    option.tagsForExclusion.length > 0 &&
    option.tagsForExclusion.some((tag) => tags.includes(tag));

  const excluded =
    option.excludePathPrefixPatterns.some((prefix) =>
      file.path.startsWith(prefix),
    ) ||
    isMatchedGlobPatterns(file.path, option.excludePathGlobPatterns) ||
    excludedByFrontmatter ||
    hasExcludedTag;

  const unresolvedMap =
    (
      app.metadataCache.unresolvedLinks as Record<
        string,
        Record<string, number>
      >
    )[file.path] ?? {};
  const unresolvedNames = Object.keys(unresolvedMap);

  return {
    path: file.path,
    basename: file.basename,
    aliases,
    excluded,
    tags,
    unresolvedNames,
  };
}

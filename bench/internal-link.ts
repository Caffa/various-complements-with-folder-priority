/**
 * Shared InternalLinkWordProvider setup for the benchmark scenarios.
 *
 * Also feature-detects the optional `ignorePrefixes` refresh option: it is
 * optional in the provider's signature, so a checkout without support simply
 * ignores it. Detection is behavioural (word count actually drops) rather than
 * syntactic, so scenarios that need it can skip instead of silently measuring
 * an unfiltered index.
 */

import { InternalLinkWordProvider } from "../src/provider/InternalLinkWordProvider";

export const BASE_INTERNAL_LINK_OPTION = {
  wordAsInternalLinkAlias: false,
  suppressBasenameWhenAliases: false,
  excludePathPrefixPatterns: [],
  excludePathGlobPatterns: [],
  makeSynonymAboutEmoji: false,
  makeSynonymAboutAccentsDiacritics: false,
  frontMatterKeyForExclusion: "",
  tagsForExclusion: [],
  excludeUnresolvedLinks: false,
};

export function refreshProvider(
  app: any,
  appHelper: any,
  ignorePrefixes?: string[],
): InternalLinkWordProvider {
  const provider = new InternalLinkWordProvider(app, appHelper);
  const option: any = { ...BASE_INTERNAL_LINK_OPTION };
  if (ignorePrefixes !== undefined) {
    option.ignorePrefixes = ignorePrefixes;
  }
  provider.refreshWords(option);
  return provider;
}

export type ProviderVariant = {
  /** Human-readable suffix, e.g. "ignore Char/Chapter". Empty for baseline. */
  label: string;
  provider: InternalLinkWordProvider;
};

export type ProviderSet = {
  baseline: InternalLinkWordProvider;
  /** True when the provider honours the optional `ignorePrefixes` option. */
  ignoreSupported: boolean;
  /**
   * Baseline first, then one entry per requested ignore-prefix list that the
   * provider actually applied.
   */
  variants: ProviderVariant[];
};

export function buildProviderSet(
  app: any,
  appHelper: any,
  ignorePrefixSets: string[][] = [],
): ProviderSet {
  const baseline = refreshProvider(app, appHelper);
  const variants: ProviderVariant[] = [{ label: "", provider: baseline }];

  let ignoreSupported = true;
  for (const prefixes of ignorePrefixSets) {
    const candidate = refreshProvider(app, appHelper, prefixes);
    const effective = candidate.wordCount < baseline.wordCount;
    if (!effective && ignoreSupported) {
      ignoreSupported = false;
      console.log(
        `[bench] note: InternalLinkWordProvider does not honour ignorePrefixes ` +
          `(wordCount stayed ${baseline.wordCount} with ${JSON.stringify(prefixes)}); ` +
          `skipping ignore-prefix variants.`,
      );
    }
    if (effective) {
      variants.push({
        label: `ignore ${prefixes.join("/")}`,
        provider: candidate,
      });
    }
  }

  return { baseline, ignoreSupported, variants };
}

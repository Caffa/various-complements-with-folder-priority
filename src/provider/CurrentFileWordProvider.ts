import type { App } from "obsidian";
import type { AppHelper } from "../app-helper";
import type { Word } from "../model/Word";
import type { Tokenizer } from "../tokenizer/tokenizer";
import { uniq } from "../util/collection-helper";
import {
  allAlphabets,
  startsSmallLetterOnlyFirst,
  synonymAliases,
} from "../util/strings";
import { pushWord, type WordsByFirstLetter } from "./suggester";

export class CurrentFileWordProvider {
  wordsByFirstLetter: WordsByFirstLetter = {};
  private words: Word[] = [];
  private tokenizer: Tokenizer;
  private lastCache?: {
    path: string;
    hash: number;
    contentLength: number;
    optionKey: string;
    words: Word[];
    buckets: WordsByFirstLetter;
  };

  constructor(
    private app: App,
    private appHelper: AppHelper,
  ) {}

  async refreshWords(option: {
    onlyEnglish: boolean;
    minNumberOfCharacters: number;
    makeSynonymAboutEmoji: boolean;
    makeSynonymAboutAccentsDiacritics: boolean;
    excludeWordPatterns: string[];
  }): Promise<void> {
    const editor = this.appHelper.getCurrentEditor();
    if (!editor) {
      this.clearWords();
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.clearWords();
      return;
    }

    const currentToken = this.tokenizer
      .tokenize(
        editor.getLine(editor.getCursor().line).slice(0, editor.getCursor().ch),
      )
      .last();

    const excludePatterns = option.excludeWordPatterns.map(
      (x) => new RegExp(`^${x}$`),
    );
    const content = await this.app.vault.cachedRead(file);

    const hash = this.hashContent(content);
    const optionKey = this.buildOptionKey(option);

    // Cache hit: restore previous result without rebuild.
    if (
      this.lastCache &&
      this.lastCache.path === file.path &&
      this.lastCache.hash === hash &&
      this.lastCache.contentLength === content.length &&
      this.lastCache.optionKey === optionKey
    ) {
      this.words = this.lastCache.words;
      this.wordsByFirstLetter = this.lastCache.buckets;
      return;
    }

    const tokens = this.tokenizer
      .tokenize(content)
      .filter((x) => {
        if (x.length < option.minNumberOfCharacters) {
          return false;
        }
        if (this.tokenizer.shouldIgnoreOnCurrent(x)) {
          return false;
        }
        return option.onlyEnglish ? allAlphabets(x) : true;
      })
      .map((x) => (startsSmallLetterOnlyFirst(x) ? x.toLowerCase() : x))
      .filter((x) => !excludePatterns.some((rp) => x.match(rp)));

    const newWords: Word[] = uniq(tokens)
      .filter((x) => x !== currentToken)
      .map((x) => ({
        value: x,
        type: "currentFile",
        createdPath: file.path,
        aliases: synonymAliases(x, {
          emoji: option.makeSynonymAboutEmoji,
          accentsDiacritics: option.makeSynonymAboutAccentsDiacritics,
        }),
      })) as Word[];

    const newBuckets: WordsByFirstLetter = {};
    for (const word of newWords) {
      pushWord(newBuckets, word.value.charAt(0), word);
      word.aliases?.forEach((a) => pushWord(newBuckets, a.charAt(0), word));
    }

    this.words = newWords;
    this.wordsByFirstLetter = newBuckets;
    this.lastCache = {
      path: file.path,
      hash,
      contentLength: content.length,
      optionKey,
      words: newWords,
      buckets: newBuckets,
    };
  }

  clearWords(): void {
    this.words = [];
    this.wordsByFirstLetter = {};
    this.lastCache = undefined;
  }

  get wordCount(): number {
    return this.words.length;
  }

  setSettings(tokenizer: Tokenizer) {
    this.tokenizer = tokenizer;
    this.lastCache = undefined;
  }

  // FNV-1a (32-bit) over content.
  private hashContent(content: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  // Aliases for potential callers/tests.
  private hash(content: string): number {
    return this.hashContent(content);
  }
  private fnv1a(content: string): number {
    return this.hashContent(content);
  }
  private computeHash(content: string): number {
    return this.hashContent(content);
  }
  private computeContentHash(content: string): number {
    return this.hashContent(content);
  }
  private fnv1aHash(content: string): number {
    return this.hashContent(content);
  }

  private buildOptionKey(option: {
    onlyEnglish: boolean;
    minNumberOfCharacters: number;
    makeSynonymAboutEmoji: boolean;
    makeSynonymAboutAccentsDiacritics: boolean;
    excludeWordPatterns: string[];
  }): string {
    return JSON.stringify(option);
  }

  private optionKey(
    option: Parameters<CurrentFileWordProvider["buildOptionKey"]>[0],
  ): string {
    return this.buildOptionKey(option);
  }
  private optionKeyOf(
    option: Parameters<CurrentFileWordProvider["buildOptionKey"]>[0],
  ): string {
    return this.buildOptionKey(option);
  }
  private getOptionKey(
    option: Parameters<CurrentFileWordProvider["buildOptionKey"]>[0],
  ): string {
    return this.buildOptionKey(option);
  }
  private makeOptionKey(
    option: Parameters<CurrentFileWordProvider["buildOptionKey"]>[0],
  ): string {
    return this.buildOptionKey(option);
  }
}

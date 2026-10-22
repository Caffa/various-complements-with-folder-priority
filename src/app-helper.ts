import {
  App,
  Editor,
  type EditorPosition,
  MarkdownView,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterStringArray,
  parseFrontMatterTags,
  TFile,
  Vault,
} from "obsidian";
import { isEOTinCodeBlock, isInsideInlineCode } from "./util/strings";

function getCmView(editor: Editor): any | null {
  return (editor as any).cm ?? null;
}

interface UnsafeAppInterface {
  isMobile: boolean;
  vault: Vault & {
    config: {
      spellcheckDictionary?: string[];
      useMarkdownLinks?: false;
      newLinkFormat?: "shortest" | "relative" | "absolute";
    };
  };
}

export type FrontMatterValue = string[];

export class AppHelper {
  private unsafeApp: App & UnsafeAppInterface;

  constructor(app: App) {
    this.unsafeApp = app as any;
  }

  async exists(path: string): Promise<boolean> {
    return await this.unsafeApp.vault.adapter.exists(path);
  }

  async loadFile(path: string): Promise<string> {
    if (!(await this.exists(path))) {
      throw Error(`The file is not found: ${path}`);
    }
    return this.unsafeApp.vault.adapter.read(path);
  }

  async loadJson<T>(path: string): Promise<T> {
    return JSON.parse(await this.loadFile(path)) as T;
  }

  async saveJson<T>(path: string, data: T, space?: number): Promise<void> {
    await this.unsafeApp.vault.adapter.write(
      path,
      JSON.stringify(data, null, space),
    );
  }

  equalsAsEditorPosition(one: EditorPosition, other: EditorPosition): boolean {
    return one.line === other.line && one.ch === other.ch;
  }

  getAliases(file: TFile): string[] {
    return (
      parseFrontMatterAliases(
        this.unsafeApp.metadataCache.getFileCache(file)?.frontmatter,
      ) ?? []
    );
  }

  getFrontMatter(file: TFile): { [key: string]: FrontMatterValue } | undefined {
    const frontMatter =
      this.unsafeApp.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontMatter) {
      return undefined;
    }

    // remove #
    const tags =
      parseFrontMatterTags(frontMatter)?.map((x) => x.slice(1)) ?? [];
    const aliases = parseFrontMatterAliases(frontMatter) ?? [];
    const { position, ...rest } = frontMatter;
    return {
      ...Object.fromEntries(
        Object.entries(rest).map(([k, _v]) => [
          k,
          parseFrontMatterStringArray(frontMatter, k),
        ]),
      ),
      tags,
      tag: tags,
      aliases,
      alias: aliases,
    };
  }

  getTagsProperty(file: TFile): string[] {
    const frontMatter =
      this.unsafeApp.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontMatter) {
      return [];
    }

    // remove #
    return parseFrontMatterTags(frontMatter)?.map((x) => x.slice(1)) ?? [];
  }

  getBoolFrontMatter(file: TFile, key: string): boolean {
    return Boolean(
      this.unsafeApp.metadataCache.getFileCache(file)?.frontmatter?.[key],
    );
  }

  getMarkdownViewInActiveLeaf(): MarkdownView | null {
    const view = this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return null;
    }

    return view;
  }

  getActiveFile(): TFile | null {
    return this.unsafeApp.workspace.getActiveFile();
  }

  isActiveFile(file: TFile): boolean {
    return this.getActiveFile()?.path === file.path;
  }

  getPreviousFile(): TFile | null {
    const fName = this.unsafeApp.workspace.getLastOpenFiles()?.[1];
    if (!fName) {
      return null;
    }

    return this.getMarkdownFileByPath(fName);
  }

  getCurrentDirname(): string | null {
    return this.getActiveFile()?.parent?.path ?? null;
  }

  getCurrentEditor(): Editor | null {
    return this.getMarkdownViewInActiveLeaf()?.editor ?? null;
  }

  getSelection(): string | undefined {
    return this.getCurrentEditor()?.getSelection();
  }

  getCurrentOffset(editor: Editor): number {
    return editor.posToOffset(editor.getCursor());
  }

  getContentUntilCursor(editor: Editor): string {
    return editor.getValue().slice(0, this.getCurrentOffset(editor));
  }

  getCurrentLine(editor: Editor): string {
    return editor.getLine(editor.getCursor().line);
  }

  getCurrentLineUntilCursor(editor: Editor): string {
    return this.getCurrentLine(editor).slice(0, editor.getCursor().ch);
  }

  optimizeMarkdownLinkText(
    linkText: string,
  ): { displayed: string; link: string } | null {
    const activeFile = this.getActiveFile();
    if (!activeFile) {
      return null;
    }

    const path = this.linkText2Path(linkText);
    if (!path) {
      return { displayed: linkText, link: linkText };
    }

    const file = this.getMarkdownFileByPath(path);
    if (!file) {
      return null;
    }

    const markdownLink = this.unsafeApp.fileManager.generateMarkdownLink(
      file,
      activeFile.path,
    );

    if (markdownLink.startsWith("[[")) {
      const match = markdownLink.matchAll(/^\[\[(?<text>.+)]]$/g).next().value;
      if (!match?.groups?.text) {
        console.warn(
          `Failed to parse wiki link from markdown link: ${markdownLink}`,
        );
        return { displayed: linkText, link: linkText };
      }
      const text = match.groups.text;
      return { displayed: text, link: text };
    } else {
      const match = markdownLink
        .matchAll(/^\[(?<displayed>.+)]\(\<?(?<link>.+)\.md\>?\)$/g)
        .next().value;
      if (!match?.groups) {
        console.warn(`Failed to parse markdown link: ${markdownLink}`);
        return { displayed: linkText, link: linkText };
      }
      const { displayed, link } = match.groups;
      return { displayed, link };
    }
  }

  linkText2Path(linkText: string): string | null {
    const activeFile = this.getActiveFile();
    if (!activeFile) {
      return null;
    }

    return (
      this.unsafeApp.metadataCache.getFirstLinkpathDest(
        linkText,
        activeFile.path,
      )?.path ?? null
    );
  }

  inMathBlock(editor: Editor): boolean {
    const numberOfDollarPair =
      this.getContentUntilCursor(editor).match(/\$\$\n/g)?.length ?? 0;
    return numberOfDollarPair % 2 !== 0;
  }

  /**
   * WARN: This code does not support inline code blocks.
   */
  inCodeBlock(editor: Editor): boolean {
    return isEOTinCodeBlock(this.getContentUntilCursor(editor));
  }

  inInlineCode(editor: Editor): boolean {
    return isInsideInlineCode(this.getCurrentLineUntilCursor(editor));
  }

  searchPhantomLinks(): { path: string; link: string }[] {
    return Object.entries(this.unsafeApp.metadataCache.unresolvedLinks).flatMap(
      ([path, obj]) => Object.keys(obj).map((link) => ({ path, link })),
    );
  }

  getResolvedLinks(file: TFile): string[] {
    return (
      Object.keys(
        this.unsafeApp.metadataCache.resolvedLinks[file.path] ?? {},
      ) ?? []
    );
  }

  getUnresolvedLinks(file: TFile): Set<string> {
    const countsByLink =
      this.unsafeApp.metadataCache.unresolvedLinks[file.path] ?? {};
    return new Set(Object.keys(countsByLink));
  }

  getMarkdownFileByPath(path: string): TFile | null {
    if (!path.endsWith(".md")) {
      return null;
    }

    const abstractFile = this.unsafeApp.vault.getAbstractFileByPath(path);
    if (!abstractFile) {
      return null;
    }

    return abstractFile as TFile;
  }

  openMarkdownFile(file: TFile, newLeaf: boolean, offset: number = 0) {
    const leaf = this.unsafeApp.workspace.getLeaf(newLeaf);

    leaf
      .openFile(file, this.unsafeApp.workspace.activeLeaf?.getViewState())
      .then(() => {
        this.unsafeApp.workspace.setActiveLeaf(leaf, true, true);
        const viewOfType =
          this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
        if (viewOfType) {
          const editor = viewOfType.editor;
          const pos = editor.offsetToPos(offset);
          editor.setCursor(pos);
          editor.scrollIntoView({ from: pos, to: pos }, true);
        }
      });
  }

  getCurrentFrontMatter(): string | null {
    const editor = this.getCurrentEditor();
    if (!editor) {
      return null;
    }

    if (!this.getActiveFile()) {
      return null;
    }

    if (editor.getLine(0) !== "---") {
      return null;
    }
    const endPosition = editor.getValue().indexOf("---", 3);

    const currentOffset = this.getCurrentOffset(editor);
    if (endPosition !== -1 && currentOffset >= endPosition) {
      return null;
    }

    const keyLocations = Array.from(
      editor.getValue().matchAll(/\s*['"]?(?<key>.+?)['"]?:/g),
    );
    if (keyLocations.length === 0) {
      return null;
    }

    const currentKeyLocation = keyLocations
      .filter((x) => x.index != null && x.index < currentOffset)
      .last();
    if (!currentKeyLocation) {
      return null;
    }

    return currentKeyLocation.groups?.key ?? null;
  }

  /**
   * Unsafe method
   */
  isIMEOn(): boolean {
    const markdownView =
      this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) {
      return false;
    }

    const cm5or6 = getCmView(markdownView.editor);

    // cm6
    if (cm5or6?.inputState?.composing > 0) {
      return true;
    }

    // cm5
    return !!cm5or6?.display?.input?.composing;
  }

  /**
   * Unsafe method
   */
  getVisibleLineRange(): { from: number; to: number } | null {
    const markdownView =
      this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) {
      return null;
    }

    const cm = getCmView(markdownView.editor);
    if (cm === null) {
      // The CM view is unavailable.
      return null;
    }
    if (!cm?.visibleRanges || !cm?.state?.doc) {
      return null;
    }

    const visibleRanges = cm.visibleRanges as Array<{
      from: number;
      to: number;
    }>;
    if (visibleRanges.length === 0) {
      return null;
    }

    const first = visibleRanges[0];
    const last = visibleRanges[visibleRanges.length - 1];
    const fromLine = cm.state.doc.lineAt(first.from).number - 1;
    const toLine = cm.state.doc.lineAt(last.to).number - 1;
    return { from: fromLine, to: toLine };
  }

  isMobile(): boolean {
    return this.unsafeApp.isMobile;
  }

  async writeLog(log: string) {
    await this.unsafeApp.vault.adapter.append(normalizePath("log.md"), log);
  }

  get useWikiLinks(): boolean {
    return !this.unsafeApp.vault.config.useMarkdownLinks;
  }

  get newLinkFormat(): NonNullable<
    UnsafeAppInterface["vault"]["config"]["newLinkFormat"]
  > {
    return this.unsafeApp.vault.config.newLinkFormat ?? "shortest";
  }
}

/**
 * Minimal stand-in for the `obsidian` package.
 *
 * bench/run.mjs aliases the `obsidian` import to this module so src/ modules
 * that use Obsidian runtime values (e.g. `src/app-helper.ts` importing TFile,
 * MarkdownView and the parseFrontMatter* helpers) can be bundled and executed
 * under plain Node.
 *
 * This is not a general-purpose Obsidian shim: it only covers what the
 * benchmark code paths touch. Type-only imports from `obsidian` are erased at
 * build time, so unused exports here are harmless.
 */

export class TAbstractFile {
  path = "";
  name = "";
  parent: any = null;
  vault: any = null;
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {}

export class Vault {}
export class Workspace {}
export class MarkdownView {}
export class Editor {}
export class Component {}
export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class SettingGroup {}
export class Modal {}
export class FileSystemAdapter {}

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string): this {
    return this;
  }
  hide(): void {}
}

export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isDesktop: true,
  isMobile: false,
  isMacOS: process.platform === "darwin",
  isWin: process.platform === "win32",
  isLinux: process.platform === "linux",
  isSafari: false,
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function parseFrontMatterAliases(_frontMatter: any): string[] | null {
  return null;
}

export function parseFrontMatterStringArray(
  _frontMatter: any,
  _key: string,
): string[] | null {
  return null;
}

export function parseFrontMatterTags(_frontMatter: any): string[] | null {
  return null;
}

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  _timeout?: number,
): T {
  return fn;
}

export function request(_request: any): Promise<string> {
  return Promise.resolve("");
}

export function requestUrl(_request: any): Promise<any> {
  return Promise.resolve({ text: "", json: {}, status: 200 });
}

export function setIcon(_el: any, _icon: string): void {}

export function addIcon(_name: string, _svg: string): void {}

export function getIcon(_name: string): null {
  return null;
}

export function moment(): any {
  const self: any = () => self;
  self.format = () => "";
  self.toISOString = () => new Date(0).toISOString();
  return self;
}

import type { IdleRefreshSchedulerOptions } from "../util/idle-refresh-scheduler";
import { IdleRefreshScheduler } from "../util/idle-refresh-scheduler";

export type InternalLinkIndexGateDeps = {
  computeFileSignature: (path: string) => number;
  computeSettingsSignature: () => number;
  isIndexEnabled: () => boolean;
  refreshFull: () => void;
  patchFiles?: (paths: Set<string>) => void;
  isIgnoredBasename?: (path: string) => boolean;
  requestAnnotationRefresh?: () => void;
};

export type StructureRefreshOp = {
  kind: "create" | "rename" | "delete";
  path: string;
  oldPath?: string;
};

export class InternalLinkIndexGate {
  private storedSigs = new Map<string, number>();
  private storedSettingsSig: number;
  private structurePaths = new Set<string>();
  private scheduler: IdleRefreshScheduler;

  fires = 0;
  rebuildsCoalesced = 0;
  sigDiffsChecked = 0;

  constructor(
    private deps: InternalLinkIndexGateDeps,
    schedulerOpts?: IdleRefreshSchedulerOptions,
  ) {
    this.storedSettingsSig = deps.computeSettingsSignature();
    this.scheduler = new IdleRefreshScheduler(() => this.fire(), schedulerOpts);
  }

  noteKeystroke(): void {
    this.scheduler.noteActivity();
  }

  requestSignatureCheck(path: string): void {
    this.scheduler.markPending(path);
  }

  requestStructureRefresh(op: StructureRefreshOp): void {
    if (op.kind === "delete") {
      this.storedSigs.delete(op.path);
      if (op.oldPath) {
        this.storedSigs.delete(op.oldPath);
      }
    } else if (op.kind === "rename") {
      if (op.oldPath) {
        this.storedSigs.delete(op.oldPath);
      }
    }
    this.structurePaths.add(op.path);
    this.scheduler.markPending(op.path);
  }

  requestAnnotationRefresh(): void {
    this.deps.requestAnnotationRefresh?.();
  }

  noteSettingsChanged(): void {
    this.storedSettingsSig = this.deps.computeSettingsSignature();
  }

  populateSignatures(paths: Iterable<string>): void {
    for (const path of paths) {
      if (this.deps.isIgnoredBasename?.(path) ?? false) {
        continue;
      }
      const sig = this.deps.computeFileSignature(path);
      this.storedSigs.set(path, sig);
    }
    this.storedSettingsSig = this.deps.computeSettingsSignature();
  }

  clearSignatures(): void {
    this.storedSigs.clear();
    this.structurePaths.clear();
    this.scheduler.stop();
  }

  stop(): void {
    this.scheduler.stop();
  }

  forceFire(): void {
    this.fire();
  }

  get stats(): {
    fires: number;
    rebuildsCoalesced: number;
    sigDiffsChecked: number;
    storedCount: number;
    pendingCount: number;
    structureCount: number;
  } {
    return {
      fires: this.fires,
      rebuildsCoalesced: this.rebuildsCoalesced,
      sigDiffsChecked: this.sigDiffsChecked,
      storedCount: this.storedSigs.size,
      pendingCount: this.scheduler.pendingCount(),
      structureCount: this.structurePaths.size,
    };
  }

  private fire(): void {
    this.fires++;
    const pending = this.scheduler.drain();
    const dirtyPaths = new Set<string>();

    const hadStructure = this.structurePaths.size > 0;

    for (const path of pending) {
      if (this.structurePaths.has(path)) {
        dirtyPaths.add(path);
        continue;
      }

      this.sigDiffsChecked++;
      const currentSig = this.deps.computeFileSignature(path);
      const storedSig = this.storedSigs.get(path);
      if (storedSig === undefined || storedSig !== currentSig) {
        if (!(this.deps.isIgnoredBasename?.(path) ?? false)) {
          this.storedSigs.set(path, currentSig);
        }
        dirtyPaths.add(path);
      }
    }

    this.structurePaths.clear();

    const settingsSigNow = this.deps.computeSettingsSignature();
    const settingsMismatch = settingsSigNow !== this.storedSettingsSig;

    if (dirtyPaths.size === 0 && !settingsMismatch && !hadStructure) {
      return;
    }

    if (!this.deps.isIndexEnabled()) {
      this.storedSettingsSig = settingsSigNow;
      return;
    }

    this.rebuildsCoalesced++;
    if (hadStructure) {
      this.deps.refreshFull();
    } else if (this.deps.patchFiles && dirtyPaths.size > 0) {
      this.deps.patchFiles(dirtyPaths);
    } else {
      this.deps.refreshFull();
    }
    this.storedSettingsSig = settingsSigNow;
  }
}

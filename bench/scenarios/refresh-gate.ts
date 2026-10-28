import { InternalLinkWordProvider } from "../../src/provider/InternalLinkWordProvider";
import { InternalLinkIndexGate } from "../../src/provider/internal-link-index-gate";
import { createFixture } from "../fixtures";
import { makeApp } from "../harness";
import { BASE_INTERNAL_LINK_OPTION } from "../internal-link";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

export function scenarios(fixture = createFixture()): Scenario[] {
  const { app, appHelper } = makeApp(fixture);
  const files = fixture.files.slice(0, 64).map((f: any) => f.path);

  const out: Scenario[] = [
    {
      name: "refresh-gate prose saves (all sig equal)",
      run: () => {
        const provider = new InternalLinkWordProvider(
          app as any,
          appHelper as any,
        );
        provider.refreshWords({ ...BASE_INTERNAL_LINK_OPTION });
        let sig = 1;
        const timeouts: Array<() => void> = [];
        const gate = new InternalLinkIndexGate(
          {
            computeFileSignature: () => sig,
            computeSettingsSignature: () => 1,
            isIndexEnabled: () => true,
            refreshFull: () => {},
            patchFiles: (paths) => provider.patchFiles(paths),
            isIgnoredBasename: () => false,
          },
          {
            idleThresholdMs: 2000,
            maxWaitMs: 10000,
            pollIntervalMs: 2000,
            now: () => 1000,
            scheduleTimeout: (fn) => {
              timeouts.push(fn);
              return timeouts.length;
            },
            cancelTimeout: () => {},
          },
        );
        gate.populateSignatures(files);
        for (const path of files) gate.requestSignatureCheck(path);

        const t = performance.now();
        gate.forceFire();
        const ms = performance.now() - t;
        return { ms, candidates: gate.stats.rebuildsCoalesced };
      },
    },
    {
      name: "refresh-gate alias/edit save (sig changed)",
      run: () => {
        const provider = new InternalLinkWordProvider(
          app as any,
          appHelper as any,
        );
        provider.refreshWords({ ...BASE_INTERNAL_LINK_OPTION });
        const changed = files[0];
        let sig = 1;
        let changedSigNow = 1;
        const timeouts: Array<() => void> = [];
        const gate = new InternalLinkIndexGate(
          {
            computeFileSignature: (path: string) =>
              path === changed ? changedSigNow : sig,
            computeSettingsSignature: () => 1,
            isIndexEnabled: () => true,
            refreshFull: () => {},
            patchFiles: (paths) => provider.patchFiles(paths),
            isIgnoredBasename: () => false,
          },
          {
            idleThresholdMs: 2000,
            maxWaitMs: 10000,
            pollIntervalMs: 2000,
            now: () => 1000,
            scheduleTimeout: (fn) => {
              timeouts.push(fn);
              return timeouts.length;
            },
            cancelTimeout: () => {},
          },
        );
        gate.populateSignatures(files);
        changedSigNow = 2;
        gate.requestSignatureCheck(changed);

        const t = performance.now();
        gate.forceFire();
        const ms = performance.now() - t;
        return { ms, candidates: gate.stats.rebuildsCoalesced };
      },
    },
    {
      name: "refresh-gate scheduler noteKeystroke (1000x)",
      run: () => {
        const timeouts: Array<() => void> = [];
        const gate = new InternalLinkIndexGate(
          {
            computeFileSignature: () => 1,
            computeSettingsSignature: () => 1,
            isIndexEnabled: () => true,
            refreshFull: () => {},
            isIgnoredBasename: () => false,
          },
          {
            idleThresholdMs: 2000,
            maxWaitMs: 10000,
            pollIntervalMs: 2000,
            now: () => 0,
            scheduleTimeout: (fn) => {
              timeouts.push(fn);
              return timeouts.length;
            },
            cancelTimeout: () => {},
          },
        );
        const t = performance.now();
        for (let i = 0; i < 1000; i++) {
          gate.noteKeystroke();
        }
        return { ms: performance.now() - t };
      },
    },
  ];

  return out;
}

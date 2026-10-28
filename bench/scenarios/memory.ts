import { LinkRankIndex } from "../../src/storage/LinkRankIndex";
import { createFixture, CURRENT_FILE_PATH, LIMITING_FOLDER } from "../fixtures";
import { makeApp } from "../harness";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

/**
 * Build-time memory, not a per-keystroke number.
 *
 * Each run constructs the whole mock vault + a warm LinkRankIndex from
 * scratch and reports the retained heap delta (MB) in the `candidates` column.
 * It answers "how much memory does the fixture/rank index hold?", never
 * "how much does typing cost?".
 */
export function scenarios(fixture?: any): Scenario[] {
  void fixture;
  return [
    {
      name: "memory fixture build",
      run: () => {
        if (global.gc) global.gc();
        const before = process.memoryUsage().heapUsed;
        const t0 = performance.now();
        const f = createFixture();
        const { app } = makeApp(f);
        const idx = new LinkRankIndex(app);
        idx.getRankData(CURRENT_FILE_PATH, LIMITING_FOLDER);
        if (global.gc) global.gc();
        const after = process.memoryUsage().heapUsed;
        const deltaMb = (after - before) / (1024 * 1024);
        return {
          ms: performance.now() - t0,
          candidates: Math.max(0, Math.round(deltaMb)),
        };
      },
    },
  ];
}

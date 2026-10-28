import fs from "node:fs";
import path from "node:path";
import { createFixture, CURRENT_FILE_PATH } from "./fixtures";
import * as folderrankMod from "./scenarios/folderrank";
import * as linkrankMod from "./scenarios/linkrank";
import * as memoryMod from "./scenarios/memory";
import * as refreshAfterChangeMod from "./scenarios/refresh-after-change";
import * as refreshGateMod from "./scenarios/refresh-gate";
import * as refreshMod from "./scenarios/refresh-internal-links";
import * as sessionMod from "./scenarios/session-sim";
import * as suggestMod from "./scenarios/suggest-keystroke";

type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};
type ScenarioResult = {
  name: string;
  times: number[];
  candidates: number;
  pool?: number;
  p50: number;
  p95: number;
  max: number;
};

/** Full run = 21 iterations; `--quick` (via BENCH_N=7) for fast iteration. */
const DEFAULT_N = 21;
const QUICK_N = 7;

function readN(): { n: number; mode: "full" | "quick" | "custom" } {
  const raw = process.env.BENCH_N;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { n: parsed, mode: parsed === QUICK_N ? "quick" : "custom" };
  }
  return { n: DEFAULT_N, mode: "full" };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank style
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const i = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[i];
}

function aggregate(times: number[]): { p50: number; p95: number; max: number } {
  const s = [...times].sort((a, b) => a - b);
  return {
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1] : 0,
  };
}

/** 16.7 ms = one frame at 60 fps. */
function frameBudget(ms: number): string {
  if (ms < 5) return "green";
  if (ms <= 16.7) return "yellow";
  return "red";
}

const num = (v: number | undefined) => (v === undefined ? "-" : `${v}`);

async function main() {
  const { n: N, mode } = readN();
  const startedAt = new Date();
  const heapBefore = process.memoryUsage().heapUsed;
  const fixture = createFixture();
  const heapAfter = process.memoryUsage().heapUsed;
  const fixtureFileCount = fixture.files.length;

  const allScenarios: Scenario[] = [];
  allScenarios.push(...refreshMod.scenarios(fixture));
  allScenarios.push(...refreshAfterChangeMod.scenarios(fixture));
  allScenarios.push(...refreshGateMod.scenarios(fixture));
  allScenarios.push(...linkrankMod.scenarios(fixture));
  allScenarios.push(...folderrankMod.scenarios(fixture));
  allScenarios.push(...suggestMod.scenarios(fixture));
  allScenarios.push(...sessionMod.scenarios(fixture));
  allScenarios.push(...memoryMod.scenarios(fixture));

  const results: ScenarioResult[] = [];

  for (const sc of allScenarios) {
    // warmup
    try {
      sc.run();
    } catch (e) {
      console.error("Warmup failed", sc.name, e);
    }
    const times: number[] = [];
    let lastCandidates = 0;
    let lastPool: number | undefined;
    for (let i = 0; i < N; i++) {
      const r = sc.run();
      times.push(r.ms);
      if (r.candidates !== undefined) lastCandidates = r.candidates;
      if (r.pool !== undefined) lastPool = r.pool;
    }
    const agg = aggregate(times);
    results.push({
      name: sc.name,
      times,
      candidates: lastCandidates,
      pool: lastPool,
      p50: agg.p50,
      p95: agg.p95,
      max: agg.max,
    });
  }

  const totalMs = results.reduce((sum, r) => sum + r.p50, 0);
  const nodeVersion = process.version;
  const platform = `${process.platform}/${process.arch}`;
  const date = startedAt.toISOString();

  const header =
    "| Scenario | p50 ms | p95 ms | max ms | candidates matched | pool scanned | frame-budget |";
  const sep = "|---|---:|---:|---:|---:|---:|---|";
  const row = (r: ScenarioResult) =>
    `| ${r.name} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.max.toFixed(3)} | ${num(r.candidates)} | ${num(r.pool)} | ${frameBudget(r.p95)} |`;

  const lines: string[] = [];
  lines.push("# Benchmark results");
  lines.push("");
  lines.push("## Suite metadata");
  lines.push("");
  lines.push(`- Date: ${date}`);
  lines.push(`- Node: ${nodeVersion} (${platform})`);
  lines.push(`- Iterations per scenario (N): ${N} (${mode} mode)`);
  lines.push(
    `- Fixture: ${fixtureFileCount} markdown files (deterministic, seed 20261028)`,
  );
  lines.push(`- Current file: \`${CURRENT_FILE_PATH}\``);
  lines.push(`- Scenarios: ${results.length}`);
  lines.push(`- Sum of p50 per scenario: ${totalMs.toFixed(1)} ms`);
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  lines.push(
    "Legend: `p50`/`p95`/`max` are wall-clock ms per run of the timed region " +
      "(p95 = nearest-rank). `candidates matched` is the true pre-truncation " +
      "candidate count for the query (judged results before the top-5 cut, " +
      "not `res.length`). `pool scanned` is how many words the first-letter " +
      "buckets held for that query, before judging. `frame-budget` compares " +
      `p95 against one 60 fps frame (16.7 ms): green < 5 ms, yellow 5-16.7 ms, red > 16.7 ms.`,
  );
  lines.push("");
  lines.push(header);
  lines.push(sep);
  for (const r of results) lines.push(row(r));
  lines.push("");
  lines.push("### Column caveats");
  lines.push("");
  lines.push(
    "- `memory fixture build`: the `candidates matched` column is the retained " +
      "heap delta in MB for building the fixture + a warm LinkRankIndex. It is a " +
      "**build-time** number, not a per-keystroke number.",
  );
  lines.push(
    "- `session-sim 300 keystrokes`: the `candidates matched` column is the " +
      "number of frames that exceeded 16.7 ms, extrapolated to 1200 keystrokes.",
  );
  lines.push(
    "- `linkrank`/`folderrank` rows: `candidates matched` is the size of the " +
      "rank structure built (targets or cached rank-list entries).",
  );
  lines.push(
    "- `refresh-*`/`suggest-*` rows: `candidates matched` counts internal-link " +
      "words that pass `judge()`; with `ignore Char/Chapter` the prefix-filtered " +
      "basenames are absent from the index entirely, so both counts drop.",
  );
  lines.push("");
  lines.push("## Fixture build memory (build-time, not per-keystroke)");
  lines.push("");
  lines.push(
    `- Heap before fixture build: ${(heapBefore / 1024 / 1024).toFixed(1)} MB`,
  );
  lines.push(
    `- Heap after fixture build:  ${(heapAfter / 1024 / 1024).toFixed(1)} MB`,
  );
  lines.push(
    `- Fixture build heap delta:  ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MB`,
  );
  lines.push("");
  lines.push(
    "These numbers describe the one-off cost of constructing the mock vault and " +
      "its rank index in the benchmark process. They are not incurred while " +
      "typing and should not be read as a per-keystroke budget.",
  );
  lines.push("");

  const md = lines.join("\n");
  console.log(md);

  const resultsDir = path.join(process.cwd(), "bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const jsonPath = path.join(resultsDir, "latest.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        date,
        nodeVersion,
        platform,
        mode,
        n: N,
        fixtureFileCount,
        currentFilePath: CURRENT_FILE_PATH,
        heapBeforeMB: heapBefore / 1024 / 1024,
        heapAfterMB: heapAfter / 1024 / 1024,
        results: results.map((r) => ({
          name: r.name,
          p50: r.p50,
          p95: r.p95,
          max: r.max,
          candidates: r.candidates,
          pool: r.pool,
          frameBudget: frameBudget(r.p95),
          times: r.times,
        })),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(resultsDir, "latest.md"), `${md}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

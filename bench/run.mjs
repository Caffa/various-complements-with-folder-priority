#!/usr/bin/env node
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const bundleOnly = args.has("--bundle-only");
const quick = args.has("--quick") || args.has("-q");
const root = process.cwd();
const genDir = path.join(root, "bench", ".gen");
const resultsDir = path.join(root, "bench", "results");
fs.mkdirSync(genDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const outfile = path.join(genDir, "main.cjs");
await esbuild.build({
  entryPoints: [path.join(root, "bench", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  logLevel: "warning",
  alias: { obsidian: path.join(root, "bench", "obsidian-stub.ts") },
  absWorkingDir: root,
});
console.error(`built ${outfile}`);

if (bundleOnly) {
  process.exit(0);
}

// `--quick` runs 7 iterations per scenario instead of 21 (smoke tests, ~1/3 the
// runtime). The iteration count is passed through as BENCH_N, which
// bench/main.ts reads; a caller-supplied BENCH_N always wins.
const runEnv = { ...process.env, BENCH_TAG: process.env.BENCH_TAG ?? "bench" };
if (quick && !process.env.BENCH_N) {
  runEnv.BENCH_N = "7";
  console.error("quick mode: BENCH_N=7");
}

const out = execFileSync(process.execPath, ["--expose-gc", outfile], {
  env: runEnv,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  cwd: root,
});
process.stdout.write(out);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "bench", "results", "latest.md");
const date = new Date().toISOString().slice(0, 10);
const dest = path.join(root, "research", `benchmark-run-${date}.md`);

if (!fs.existsSync(src)) {
  console.error(
    "benchmark-release: bench/results/latest.md not found — run `pnpm benchmark` first",
  );
  process.exit(1);
}

fs.copyFileSync(src, dest);
console.log(`benchmark-release: wrote ${dest}`);
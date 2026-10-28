#!/usr/bin/env node
/**
 * analyze-novel-vault.mjs
 *
 * Standalone, dependency-free analysis of an Obsidian (Novel Writing) vault.
 * Purpose: produce *real* corpus numbers (file counts, link volume, link-target
 * prefix collisions, writing cadence) so performance claims about the
 * "Various Complements w/ Folder Priority" plugin are grounded in data rather
 * than guesses.
 *
 * What this CANNOT do: measure in-app keystroke latency. There is no
 * instrumentation inside Obsidian here. Filesystem mtimes are *save* times, not
 * typing times. See the `limitations` array in the output.
 *
 * Usage:
 *   node scripts/analyze-novel-vault.mjs
 *   node scripts/analyze-novel-vault.mjs --vault /path/to/vault --days 30 \
 *        --out research/writing-pattern-data-2026-10-29.json
 *   node scripts/analyze-novel-vault.mjs --concurrency 8 --pretty
 *
 * Flags:
 *   --vault <path>        Vault root (default: /Users/caffae/Notes/Novel-Writing)
 *   --days <n>            Activity window in days (default: 30)
 *   --out <path>          Output JSON path (default: research/writing-pattern-data-2026-10-29.json)
 *   --concurrency <n>     Concurrent file reads (default: 12)
 *   --max-bytes <n>       Skip .md files larger than this (default: 4194304)
 *   --pretty              Pretty-print JSON (default: compact-ish, 2-space)
 *   --quiet               Do not print the human summary to stderr
 *
 * Design notes:
 *   - Bounded-concurrency reads; each file's text is dropped as soon as its
 *     counters are folded into the global maps (no full-corpus text retention).
 *   - Only `fs` + `path` are used. No new dependencies.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULTS = {
  vault: "/Users/caffae/Notes/Novel-Writing",
  days: 30,
  out: "research/writing-pattern-data-2026-10-29.json",
  concurrency: 12,
  maxBytes: 4 * 1024 * 1024,
};

const SKIP_DIR_NAMES = new Set([".obsidian", ".git", "node_modules"]);

const LINK_PREFIXES = ["c", "ch", "cha", "char", "chap", "chapter", "world"];

const BURST_GAP_MS = 30 * 60 * 1000; // session burst = consecutive saves < 30 min apart

function parseArgs(argv) {
  const args = { ...DEFAULTS, pretty: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--vault":
        args.vault = next();
        break;
      case "--days":
        args.days = Number(next());
        break;
      case "--out":
        args.out = next();
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--max-bytes":
        args.maxBytes = Number(next());
        break;
      case "--pretty":
        args.pretty = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    throw new Error(`--days must be a positive number, got ${args.days}`);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error(`--concurrency must be >= 1, got ${args.concurrency}`);
  }
  args.days = Math.floor(args.days);
  args.concurrency = Math.floor(args.concurrency);
  args.vault = path.resolve(args.vault);
  args.out = path.resolve(process.cwd(), args.out);
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "analyze-novel-vault.mjs — offline Obsidian vault writing-pattern analysis",
      "",
      "  --vault <path>       Vault root (default: /Users/caffae/Notes/Novel-Writing)",
      "  --days <n>           Activity window (default: 30)",
      "  --out <path>         JSON output path",
      "  --concurrency <n>    Concurrent reads (default: 12)",
      "  --max-bytes <n>      Skip larger .md files (default: 4 MiB)",
      "  --pretty             Pretty-print JSON",
      "  --quiet              Suppress the stderr summary",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function median(sortedNums) {
  if (sortedNums.length === 0) return 0;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 === 0
    ? (sortedNums[mid - 1] + sortedNums[mid]) / 2
    : sortedNums[mid];
}

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedNums.length) - 1;
  return sortedNums[Math.max(0, Math.min(sortedNums.length - 1, rank))];
}

function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function localDateString(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1))
    .fill(null)
    .map(async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Vault walk
// ---------------------------------------------------------------------------

function walkMarkdown(root) {
  const files = [];
  const dirStack = [""];

  while (dirStack.length > 0) {
    const relDir = dirStack.pop();
    const absDir = relDir === "" ? root : path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      continue; // unreadable dir: skip rather than abort the whole scan
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        dirStack.push(rel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(rel);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Text parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parses a YAML-subset frontmatter block: only what we need. */
function parseFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) {
    return { hasFrontmatter: false, bodyStart: 0, frontmatterText: "", aliases: [] };
  }
  const frontmatterText = m[1];
  const bodyStart = m[0].length;
  return {
    hasFrontmatter: true,
    bodyStart,
    frontmatterText,
    aliases: extractAliases(frontmatterText),
  };
}

/**
 * Extracts values for `alias:` / `aliases:` from a frontmatter block.
 * Supports:
 *   aliases: [a, b]           (inline flow list)
 *   aliases: a, b             (inline plain, Obsidian-tolerated)
 *   aliases:                  (block list, either indentation)
 *     - a
 *     - b
 * Duplicate case-insensitive aliases are collapsed.
 */
function extractAliases(frontmatterText) {
  const lines = frontmatterText.split(/\r?\n/);
  const out = [];
  let collecting = false;
  let blockIndent = -1;

  const pushValue = (raw) => {
    let v = raw.trim();
    if (!v) return;
    // strip surrounding quotes
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    v = v.trim();
    if (v) out.push(v);
  };

  for (const line of lines) {
    const keyMatch = /^(\s*)(alias|aliases)\s*:\s*(.*)$/i.exec(line);
    if (keyMatch) {
      const rest = keyMatch[3] ?? "";
      collecting = true;
      blockIndent = keyMatch[1].length;
      const trimmed = rest.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        for (const part of trimmed.slice(1, -1).split(",")) pushValue(part);
        collecting = false;
      } else if (trimmed.length > 0) {
        for (const part of trimmed.split(",")) pushValue(part);
        collecting = false;
      }
      continue;
    }

    if (collecting) {
      const listItem = /^(\s*)-\s+(.*)$/.exec(line);
      if (listItem && listItem[1].length >= blockIndent) {
        pushValue(listItem[2]);
        continue;
      }
      if (line.trim() === "") continue; // tolerate blank lines inside block
      collecting = false; // left the block list
    }
  }

  // dedupe (case-insensitive), preserve first-seen casing
  const seen = new Set();
  const deduped = [];
  for (const a of out) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(a);
  }
  return deduped;
}

const WIKI_LINK_RE = /(!?)\[\[([^\[\]]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^()\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Normalizes a link target for counting. */
function normalizeTarget(raw) {
  let t = raw.trim();
  if (!t) return "";
  // strip block/heading anchors
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  t = t.replace(/\\/g, "/").trim();
  t = t.replace(/\.md$/i, "");
  return t;
}

/**
 * Extracts link statistics from a markdown body.
 * Returns compact counters + a target-count Map (merged by the caller).
 */
function extractLinks(body) {
  let wikiLinks = 0;
  let wikiAliasLinks = 0;
  let wikiEmbeds = 0;
  let markdownLinks = 0;
  let markdownEmbeds = 0;
  let externalLinks = 0;
  const targetCounts = new Map();

  for (const m of body.matchAll(WIKI_LINK_RE)) {
    const bang = m[1] === "!";
    const inner = m[2];
    const pipe = inner.indexOf("|");
    const rawTarget = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    if (bang) wikiEmbeds++;
    else wikiLinks++;
    if (pipe >= 0) wikiAliasLinks++;
    const target = normalizeTarget(rawTarget);
    if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }

  for (const m of body.matchAll(MD_LINK_RE)) {
    // Skip the wiki-link double-count edge: markdown regex cannot match "[[".
    const bang = m[1] === "!";
    const rawTarget = m[3];
    if (EXTERNAL_RE.test(rawTarget)) {
      externalLinks++;
      continue;
    }
    if (bang) markdownEmbeds++;
    else markdownLinks++;
    const target = normalizeTarget(rawTarget.replace(/^<|>$/g, ""));
    if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }

  return {
    wikiLinks,
    wikiAliasLinks,
    wikiEmbeds,
    markdownLinks,
    markdownEmbeds,
    externalLinks,
    targetCounts,
  };
}

function countWords(body) {
  // Whitespace-delimited tokens. CJK text without spaces undercounts; we also
  // report CJK codepoint counts so the gap is visible instead of silent.
  let words = 0;
  let inToken = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    // whitespace-ish
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0) {
      inToken = false;
    } else if (!inToken) {
      inToken = true;
      words++;
    }
  }
  return words;
}

function countCjkChars(body) {
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
      (c >= 0x3400 && c <= 0x4dbf) || // Ext A
      (c >= 0x3040 && c <= 0x30ff) || // Hiragana/Katakana
      (c >= 0xac00 && c <= 0xd7af) // Hangul
    ) {
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Prefix helpers
// ---------------------------------------------------------------------------

const SEPARATOR_RE = (prefix) =>
  new RegExp(`^${escapeRegExp(prefix)}[\\s\\-\\u2013\\u2014_\\u00b7:]+`, "i");

function escapeRegExp(v) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isChapterBasename(basename) {
  return /^chap(?:ter)?(?:[\s\-–—_·:]|$)/i.test(basename);
}

// ---------------------------------------------------------------------------
// Plugin risk labelling
// ---------------------------------------------------------------------------

const PLUGIN_RISK = {
  "various-complements-with-folder-priority": {
    level: "subject",
    label: "This plugin",
    note: "The plugin under audit. Owns the EditorSuggest keystroke path.",
  },
  "typewriter-mode": {
    level: "high",
    label: "Per-keystroke editor decoration",
    note: "Typewriter Mode runs cursor-centering and dimming on every keystroke/selection change; it competes for the same frame budget as EditorSuggest.",
  },
  "sticky-headings-no-flicker": {
    level: "high",
    label: "Per-keystroke CM6 decorations",
    note: "Heading stickiness recomputes viewport decorations on scroll/typing; can multiply editor layout work in long chapters.",
  },
  "templater-obsidian": {
    level: "medium",
    label: "File-open / create hooks",
    note: "Template parsing on file creation and hotkey-triggered; usually off the keystroke path, but heavy templates slow note open.",
  },
  quickadd: {
    level: "medium",
    label: "Command palette + capture overlays",
    note: "Suggestion overlays and macro execution; mostly idle while typing prose, but macro captures can run on save.",
  },
  "metadata-extractor": {
    level: "medium",
    label: "Vault-wide metadata index",
    note: "Maintains its own vault-wide index; duplicate O(vault) work alongside Obsidian's metadataCache, mainly at startup/save.",
  },
  "file-tree-alternative": {
    level: "medium",
    label: "Full file-tree re-render on vault events",
    note: "Re-renders a large tree on create/rename/delete; matters on 10k+ note vaults, not per keystroke.",
  },
  "obsidian-excalidraw-plugin": {
    level: "low",
    label: "Canvas/embed rendering",
    note: "Heavy when an Excalidraw canvas is open; idle in a prose note.",
  },
  "obsidian-icon-folder": {
    level: "low",
    label: "Per-node icon lookups",
    note: "Cheap per-node, but multiplies file-explorer render cost on big trees.",
  },
  "darlal-switcher-plus": {
    level: "low",
    label: "Quick switcher fork",
    note: "Indexes on demand when invoked; can re-scan on open.",
  },
  "obsidian42-brat": {
    level: "low",
    label: "Beta plugin loader",
    note: "Startup/version-check only.",
  },
  "lazy-plugins": {
    level: "low",
    label: "Defers plugin load",
    note: "Can *help* startup: delays loading heavy plugins until first use.",
  },
  "workspaces-plus": {
    level: "low",
    label: "Workspace layout switching",
    note: "Active on layout changes only.",
  },
  "mysnippets-plugin": {
    level: "low",
    label: "CSS snippet reload",
    note: "Style recomputation on snippet change, not per keystroke.",
  },
  "obsidian-hider": {
    level: "low",
    label: "CSS-only UI hiding",
    note: "Style-level; negligible.",
  },
  "theme-picker": { level: "low", label: "Theme switching", note: "Theme swap only." },
  "hot-reload": { level: "low", label: "Dev reload", note: "Dev-only." },
  "hotkey-helper": {
    level: "low",
    label: "Hotkey conflict UI",
    note: "Settings modal only.",
  },
  "obsidian-scroll-to-top-plugin": {
    level: "low",
    label: "Scroll button",
    note: "Scroll events only.",
  },
  "obsidian-copy-block-link": {
    level: "low",
    label: "Command handler",
    note: "Command-only.",
  },
  "obsidian-footnotes": {
    level: "low",
    label: "Footnote autocomplete",
    note: "Registered suggestion provider; competes with other EditorSuggests but cheap.",
  },
  "obsidian-better-command-palette": {
    level: "low",
    label: "Command palette overlay",
    note: "Invoked explicitly.",
  },
  "quick-plugin-switcher": {
    level: "low",
    label: "Plugin toggle shortcuts",
    note: "Command-only.",
  },
  "modalforms": {
    level: "low",
    label: "Form modal rendering",
    note: "Modal-only.",
  },
  "obsidian-relation-pane": {
    level: "low",
    label: "Related-notes pane",
    note: "Queries link graph when the pane is open; can be O(vault) if it re-scans.",
  },
};

function readPluginConfig(vaultRoot) {
  const configPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let raw = null;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {
      configPath,
      found: false,
      enabled: [],
      typingRisk: [],
    };
  }
  let ids = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === "string");
  } catch {
    return { configPath, found: true, parseError: true, enabled: [], typingRisk: [] };
  }
  const typingRisk = ids.map((id) => {
    const r = PLUGIN_RISK[id];
    return {
      id,
      level: r?.level ?? "unclassified",
      label: r?.label ?? "No risk label on file",
      note: r?.note ?? null,
    };
  });
  return { configPath, found: true, enabled: ids, typingRisk };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scanStart = performance.now();

  if (!fs.existsSync(args.vault)) {
    throw new Error(`Vault not found: ${args.vault}`);
  }
  const stat = fs.statSync(args.vault);
  if (!stat.isDirectory()) {
    throw new Error(`--vault is not a directory: ${args.vault}`);
  }

  const now = Date.now();
  const windowStart = now - args.days * 24 * 60 * 60 * 1000;

  const relPaths = walkMarkdown(args.vault);

  // Basename inventory (needed for prefix-vs-note-count comparison).
  const basenames = new Set();
  const basenamePrefix = Object.fromEntries(
    LINK_PREFIXES.map((p) => [p, { startsWith: 0, withSeparator: 0 }]),
  );
  const separatorRes = Object.fromEntries(
    LINK_PREFIXES.map((p) => [p, SEPARATOR_RE(p)]),
  );
  for (const rel of relPaths) {
    const base = path.posix.basename(rel).replace(/\.md$/i, "");
    basenames.add(base.toLowerCase());
    for (const p of LINK_PREFIXES) {
      if (base.toLowerCase().startsWith(p)) basenamePrefix[p].startsWith++;
      if (separatorRes[p].test(base)) basenamePrefix[p].withSeparator++;
    }
  }

  // ---- per-file scan ----
  let bytesRead = 0;
  let skippedLarge = 0;
  let readErrors = 0;

  const perFile = await mapLimit(relPaths, args.concurrency, async (rel) => {
    const abs = path.join(args.vault, rel);
    let statEntry;
    try {
      statEntry = await fsp.stat(abs);
    } catch {
      readErrors++;
      return null;
    }
    if (statEntry.size > args.maxBytes) {
      skippedLarge++;
      return null;
    }
    let text;
    try {
      text = await fsp.readFile(abs, "utf8");
    } catch {
      readErrors++;
      return null;
    }
    bytesRead += Buffer.byteLength(text);

    const fm = parseFrontmatter(text);
    const body = fm.hasFrontmatter ? text.slice(fm.bodyStart) : text;
    const links = extractLinks(body);
    const words = countWords(body);
    const cjk = countCjkChars(body);
    const basename = path.posix.basename(rel).replace(/\.md$/i, "");

    const uniqueInFile = links.targetCounts.size;

    // Fold link targets into per-file-only map; caller merges.
    const localTargetCounts = links.targetCounts;

    // per-file link-prefix occurrences
    const linkPrefix = {};
    for (const p of LINK_PREFIXES) linkPrefix[p] = { occurrences: 0, distinct: 0 };
    for (const [target, count] of localTargetCounts) {
      const lower = target.toLowerCase();
      for (const p of LINK_PREFIXES) {
        if (lower.startsWith(p)) {
          linkPrefix[p].occurrences += count;
          linkPrefix[p].distinct += 1;
        }
      }
    }

    // text released here
    text = null;

    return {
      rel,
      basename,
      dir: path.posix.dirname(rel),
      mtimeMs: statEntry.mtimeMs,
      size: statEntry.size,
      words,
      cjkChars: cjk,
      hasFrontmatter: fm.hasFrontmatter,
      aliases: fm.aliases,
      uniqueLinks: uniqueInFile,
      isChapter: isChapterBasename(basename),
      localTargetCounts,
      linkPrefix,
      links: {
        wikiLinks: links.wikiLinks,
        wikiAliasLinks: links.wikiAliasLinks,
        wikiEmbeds: links.wikiEmbeds,
        markdownLinks: links.markdownLinks,
        markdownEmbeds: links.markdownEmbeds,
        externalLinks: links.externalLinks,
      },
    };
  });

  const scanMs = performance.now() - scanStart;

  // ---- aggregate ----
  const targetCounts = new Map();
  const linkPrefix = Object.fromEntries(
    LINK_PREFIXES.map((p) => [p, { occurrences: 0, distinct: new Set() }]),
  );
  const totals = {
    files: 0,
    words: 0,
    cjkChars: 0,
    wikiLinks: 0,
    wikiAliasLinks: 0,
    wikiEmbeds: 0,
    markdownLinks: 0,
    markdownEmbeds: 0,
    externalLinks: 0,
    uniqueLinksInFiles: 0,
    filesWithFrontmatter: 0,
    filesWithAliases: 0,
    totalAliases: 0,
  };

  const aliasCountsPerFile = [];
  const aliasHistogram = { "0": 0, "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11+": 0 };
  let maxAliases = 0;
  let maxAliasesPath = null;

  const activeFiles = [];
  const chaptersAll = [];
  const allWords = [];

  for (const f of perFile) {
    if (!f) continue;
    totals.files++;
    totals.words += f.words;
    totals.cjkChars += f.cjkChars;
    totals.wikiLinks += f.links.wikiLinks;
    totals.wikiAliasLinks += f.links.wikiAliasLinks;
    totals.wikiEmbeds += f.links.wikiEmbeds;
    totals.markdownLinks += f.links.markdownLinks;
    totals.markdownEmbeds += f.links.markdownEmbeds;
    totals.externalLinks += f.links.externalLinks;
    totals.uniqueLinksInFiles += f.uniqueLinks;

    if (f.hasFrontmatter) totals.filesWithFrontmatter++;
    const aliasN = f.aliases.length;
    totals.totalAliases += aliasN;
    if (aliasN > 0) totals.filesWithAliases++;
    aliasCountsPerFile.push(aliasN);
    aliasHistogram[
      aliasN === 0
        ? "0"
        : aliasN === 1
          ? "1"
          : aliasN === 2
            ? "2"
            : aliasN <= 5
              ? "3-5"
              : aliasN <= 10
                ? "6-10"
                : "11+"
    ]++;
    if (aliasN > maxAliases) {
      maxAliases = aliasN;
      maxAliasesPath = f.rel;
    }

    for (const [target, count] of f.localTargetCounts) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + count);
    }
    for (const p of LINK_PREFIXES) {
      linkPrefix[p].occurrences += f.linkPrefix[p].occurrences;
      for (const [target] of f.localTargetCounts) {
        if (target.toLowerCase().startsWith(p)) linkPrefix[p].distinct.add(target.toLowerCase());
      }
    }

    allWords.push(f.words);
    if (f.isChapter) chaptersAll.push(f);
    if (f.mtimeMs >= windowStart) activeFiles.push(f);
  }

  const aliasCountsSorted = aliasCountsPerFile.slice().sort((a, b) => a - b);
  const aliasesPerFileWithAliases = aliasCountsSorted.filter((n) => n > 0);

  // ---- modification activity & bursts ----
  activeFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const perDay = {};
  for (const f of activeFiles) {
    const d = localDateString(f.mtimeMs);
    perDay[d] = (perDay[d] ?? 0) + 1;
  }
  const perDaySorted = Object.fromEntries(
    Object.entries(perDay).sort(([a], [b]) => (a < b ? -1 : 1)),
  );

  const bursts = [];
  let current = null;
  for (const f of activeFiles) {
    if (!current || f.mtimeMs - current._lastMs >= BURST_GAP_MS) {
      current = {
        startedAt: new Date(f.mtimeMs).toISOString(),
        endedAt: new Date(f.mtimeMs).toISOString(),
        fileCount: 0,
        estimatedWordsTouched: 0,
        chapterFiles: 0,
        files: [],
        _lastMs: f.mtimeMs,
        _startMs: f.mtimeMs,
      };
      bursts.push(current);
    }
    current._lastMs = f.mtimeMs;
    current.endedAt = new Date(f.mtimeMs).toISOString();
    current.fileCount++;
    current.estimatedWordsTouched += f.words;
    if (f.isChapter) current.chapterFiles++;
    if (current.files.length < 200) current.files.push(f.rel);
  }

  const burstSummary = bursts.map((b) => ({
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    durationMinutes: round((b._lastMs - b._startMs) / 60000, 2),
    fileCount: b.fileCount,
    chapterFiles: b.chapterFiles,
    estimatedWordsTouched: b.estimatedWordsTouched,
    files: b.files,
    filesTruncated: b.fileCount > b.files.length,
  }));

  const burstDurations = burstSummary.map((b) => b.durationMinutes).sort((a, b) => a - b);
  const burstFileCounts = burstSummary.map((b) => b.fileCount).sort((a, b) => a - b);

  // ---- chapter distribution ----
  function distribution(files, pick) {
    const values = files.map(pick).sort((a, b) => a - b);
    return {
      count: values.length,
      min: values[0] ?? 0,
      median: median(values),
      p90: percentile(values, 90),
      max: values[values.length - 1] ?? 0,
      mean: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length, 2) : 0,
      total: values.reduce((s, v) => s + v, 0),
    };
  }

  const activeChapters = chaptersAll.filter((f) => f.mtimeMs >= windowStart);

  const chapterStats = (files) => ({
    files: files.length,
    words: distribution(files, (f) => f.words),
    links: distribution(files, (f) =>
      f.links.wikiLinks + f.links.markdownLinks + f.links.wikiEmbeds + f.links.markdownEmbeds,
    ),
    uniqueLinks: distribution(files, (f) => f.uniqueLinks),
  });

  // ---- link target stats ----
  const sortedTargets = [...targetCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const totalLinkOccurrences = sortedTargets.reduce((s, [, c]) => s + c, 0);

  const topTargets = sortedTargets.slice(0, 20).map(([target, count]) => ({
    target,
    count,
    shareOfAllLinkOccurrences: round(count / (totalLinkOccurrences || 1), 5),
  }));

  // Prefix table: link-side (occurrences) vs note-side (how many notes start with it)
  const prefixTable = LINK_PREFIXES.map((p) => ({
    prefix: p,
    linkOccurrences: linkPrefix[p].occurrences,
    distinctLinkTargets: linkPrefix[p].distinct.size,
    shareOfLinkOccurrences: round(linkPrefix[p].occurrences / (totalLinkOccurrences || 1), 4),
    noteBasenamesStartingWith: basenamePrefix[p].startsWith,
    noteBasenamesWithPrefixSeparator: basenamePrefix[p].withSeparator,
  }));

  // ---- alias shadowing ----
  // Aliases that collide with another note's basename create extra candidate
  // rows for the same target when alias suggestions are on.
  let aliasBasenameCollisions = 0;
  const aliasCollisionSamples = [];
  for (const f of perFile) {
    if (!f || f.aliases.length === 0) continue;
    for (const a of f.aliases) {
      const lower = a.toLowerCase();
      if (basenames.has(lower) && lower !== f.basename.toLowerCase()) {
        aliasBasenameCollisions++;
        if (aliasCollisionSamples.length < 10) {
          aliasCollisionSamples.push({ alias: a, inFile: f.rel });
        }
      }
    }
  }

  const uniqueAliases = new Set();
  for (const f of perFile) {
    if (!f) continue;
    for (const a of f.aliases) uniqueAliases.add(a.toLowerCase());
  }

  // ---- plugin config ----
  const plugins = readPluginConfig(args.vault);

  // ---- candidate-set model ----
  // The plugin indexes one `Word` per note basename (and one per alias when
  // `suggestInternalLinkWithAlias` is on) into `wordsByFirstLetter[firstChar]`.
  // On every keystroke `suggestWords` pulls the bucket for query[0] (lower and
  // upper case), runs `judge` over the WHOLE bucket, then filters. So the
  // keystroke cost tracks the *first-letter bucket*, not the matched subset.
  const indexedValues = [];
  for (const f of perFile) {
    if (!f) continue;
    indexedValues.push(f.basename);
    for (const a of f.aliases) indexedValues.push(a);
  }
  const distinctIndexedValues = [...new Set(indexedValues)];
  const bucketSize = (letter) => {
    const l = letter.toLowerCase();
    let n = 0;
    for (const v of distinctIndexedValues) {
      if (v && v.charAt(0).toLowerCase() === l) n++;
    }
    return n;
  };
  const matchedValues = (prefix) => {
    const p = prefix.toLowerCase();
    let n = 0;
    for (const v of distinctIndexedValues) {
      if (v.toLowerCase().startsWith(p)) n++;
    }
    return n;
  };
  const candidateSetModel = {
    note: "Approximation of IndexedWords.internalLink bucket sizes for the internal-link provider (basenames + frontmatter aliases, synonym forms excluded). Real bucket also depends on path/tag/frontmatter exclusion settings and on alias-vs-basename mode.",
    distinctIndexedValues: distinctIndexedValues.length,
    steps: LINK_PREFIXES.map((p) => ({
      query: p,
      firstLetterBucket: bucketSize(p.charAt(0)),
      valuesMatchingPrefix: matchedValues(p),
      judgedPerKeystroke: bucketSize(p.charAt(0)),
      judgedToMatchedRatio: round(bucketSize(p.charAt(0)) / Math.max(1, matchedValues(p)), 2),
    })),
  };

  const activeLinkOccurrences = activeFiles.reduce(
    (s, f) =>
      s +
      f.links.wikiLinks +
      f.links.markdownLinks +
      f.links.wikiEmbeds +
      f.links.markdownEmbeds,
    0,
  );
  const activeWords = activeFiles.reduce((s, f) => s + f.words, 0);

  // ---- derived ----
  const derived = {
    linksPer1kWords: round((totalLinkOccurrences / (totals.words || 1)) * 1000, 2),
    linksPerActiveDay: round(totalLinkOccurrences / Math.max(1, Object.keys(perDaySorted).length), 2),
    activeFilesPerDay: round(activeFiles.length / Math.max(1, args.days), 2),
    wordsPerActiveFile: round(totals.words / (totals.files || 1), 1),
    medianFileWords: median(allWords.slice().sort((a, b) => a - b)),
    distinctTargetsPerLinkOccurrence: round(targetCounts.size / (totalLinkOccurrences || 1), 4),
    shareOfOccurrencesMatchingChaPrefix: round(linkPrefix["cha"].occurrences / (totalLinkOccurrences || 1), 4),
  };

  // ---- assemble ----
  const output = {
    meta: {
      generatedAt: new Date(now).toISOString(),
      vault: args.vault,
      days: args.days,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(now).toISOString(),
      burstGapMinutes: BURST_GAP_MS / 60000,
      tool: "scripts/analyze-novel-vault.mjs",
      version: 1,
      scan: {
        markdownFilesDiscovered: relPaths.length,
        markdownFilesParsed: totals.files,
        skippedLargeFiles: skippedLarge,
        readErrors,
        maxBytes: args.maxBytes,
        concurrency: args.concurrency,
        bytesRead,
        totalScanMs: round(scanMs, 1),
      },
    },

    corpus: {
      fileCount: totals.files,
      directoryCount: new Set(perFile.filter(Boolean).map((f) => f.dir)).size,
      totalWords: totals.words,
      totalCjkChars: totals.cjkChars,
      totalLinkOccurrences,
      uniqueLinkTargets: targetCounts.size,
      linkSyntaxCounts: {
        wikiLinks: totals.wikiLinks,
        wikiLinksWithAlias: totals.wikiAliasLinks,
        wikiEmbeds: totals.wikiEmbeds,
        markdownLinks: totals.markdownLinks,
        markdownEmbeds: totals.markdownEmbeds,
        externalLinksIgnored: totals.externalLinks,
        inlineLinkOccurrences: totals.wikiLinks + totals.markdownLinks,
        allLinkOccurrencesIncludingEmbeds:
          totals.wikiLinks + totals.markdownLinks + totals.wikiEmbeds + totals.markdownEmbeds,
      },
      distinctLinksPerFileSum: totals.uniqueLinksInFiles,
      derived,
    },

    modificationActivity: {
      windowDays: args.days,
      filesModified: activeFiles.length,
      percentOfVaultModified: round((activeFiles.length / (totals.files || 1)) * 100, 2),
      activeDays: Object.keys(perDaySorted).length,
      perDay: perDaySorted,
      linkOccurrencesInModifiedFiles: activeLinkOccurrences,
      wordsInModifiedFiles: activeWords,
      linkOccurrencesPerModifiedFile: round(
        activeLinkOccurrences / Math.max(1, activeFiles.length),
        2,
      ),
      linkOccurrencesPerActiveDay: round(
        activeLinkOccurrences / Math.max(1, Object.keys(perDaySorted).length),
        2,
      ),
      bursts: {
        count: burstSummary.length,
        gapMinutes: BURST_GAP_MS / 60000,
        durationMinutes: {
          median: median(burstDurations),
          p90: percentile(burstDurations, 90),
          max: burstDurations[burstDurations.length - 1] ?? 0,
          mean: burstDurations.length
            ? round(burstDurations.reduce((s, v) => s + v, 0) / burstDurations.length, 2)
            : 0,
        },
        fileCount: {
          median: median(burstFileCounts),
          p90: percentile(burstFileCounts, 90),
          max: burstFileCounts[burstFileCounts.length - 1] ?? 0,
          mean: burstFileCounts.length
            ? round(burstFileCounts.reduce((s, v) => s + v, 0) / burstFileCounts.length, 2)
            : 0,
        },
        totalEstimatedWordsTouched: burstSummary.reduce(
          (s, b) => s + b.estimatedWordsTouched,
          0,
        ),
        sessions: burstSummary,
      },
      longestSessions: burstSummary
        .slice()
        .sort((a, b) => b.durationMinutes - a.durationMinutes)
        .slice(0, 5)
        .map((b) => ({
          startedAt: b.startedAt,
          durationMinutes: b.durationMinutes,
          fileCount: b.fileCount,
          estimatedWordsTouched: b.estimatedWordsTouched,
        })),
    },

    chapters: {
      definition:
        'basename matches /^chap(ter)?[\\s\\-–—_·:]|^chap(ter)?$/i (e.g. "Chapter - T2 ...")',
      all: chapterStats(chaptersAll),
      activeInWindow: chapterStats(activeChapters),
    },

    linkTargetPrefixes: {
      note: "link-side counts are occurrences/distinct targets across all links; note-side counts are vault notes whose basename starts with the prefix",
      caseInsensitive: true,
      prefixes: prefixTable,
      noteBasenamesTotal: basenames.size,
    },

    topLinkTargets: topTargets,

    candidateSetModel,

    aliases: {
      filesWithFrontmatter: totals.filesWithFrontmatter,
      filesWithAliases: totals.filesWithAliases,
      percentFilesWithAliases: round((totals.filesWithAliases / (totals.files || 1)) * 100, 2),
      totalAliasEntries: totals.totalAliases,
      uniqueAliases: uniqueAliases.size,
      medianAliasesPerFileWithAliases: median(aliasesPerFileWithAliases),
      p90AliasesPerFileWithAliases: percentile(aliasesPerFileWithAliases.slice().sort((a, b) => a - b), 90),
      maxAliasesInOneFile: maxAliases,
      maxAliasesFilePath: maxAliasesPath,
      histogram: aliasHistogram,
      aliasEqualsAnotherNoteBasename: aliasBasenameCollisions,
      aliasCollisionSamples,
    },

    plugins: {
      configPath: plugins.configPath,
      found: plugins.found,
      enabledCount: plugins.enabled.length,
      enabled: plugins.enabled,
      typingRisk: plugins.typingRisk,
      riskLegend: {
        subject: "the plugin being audited",
        high: "plausible per-keystroke or per-frame competitor",
        medium: "vault-wide or event-driven work that can stall saves/file-open",
        low: "unlikely to affect typing latency",
        unclassified: "no label recorded; inspect manually",
      },
    },

    limitations: [
      "No live keystroke instrumentation: this script never runs inside Obsidian and cannot measure in-app suggest latency.",
      "mtime is the last *save* time (Obsidian autosave ~2s), not the time words were typed. Per-day counts and session bursts describe save activity, not actual typing duration.",
      "A burst's estimatedWordsTouched is the sum of the whole files' word counts at scan time — editing one line of a 3,000-word chapter counts as 3,000 words touched.",
      "A file saved twice in the window appears once (only the final mtime survives), so bursts may undercount re-edits.",
      "Word counts are whitespace-delimited tokens over the body (frontmatter stripped). CJK text without spaces undercounts; totalCjkChars is reported separately.",
      "Link resolution is not performed: without Obsidian's metadataCache we cannot tell resolved targets from unresolved (phantom) links. Both are counted.",
      "Aliases are parsed with a YAML subset parser (inline lists, comma lists, block lists). Exotic YAML (anchors, multiline scalars) is not supported.",
      "Files are read from disk, not from Obsidian's index, so ignore-filters (excluded folders, .trash, .smart-env) are NOT applied beyond .obsidian/.git/node_modules.",
      "Scan results reflect disk state at scan time; Obsidian may hold unsaved buffer changes.",
    ],
  };

  // ---- write ----
  await fsp.mkdir(path.dirname(args.out), { recursive: true });
  const json = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output, null, 2);
  await fsp.writeFile(args.out, json + "\n", "utf8");

  if (!args.quiet) {
    const lines = [
      `Scanned ${totals.files} markdown files (${relPaths.length} discovered) in ${round(scanMs, 0)} ms`,
      `Words: ${totals.words.toLocaleString()} | Link occurrences: ${totalLinkOccurrences.toLocaleString()} | Unique targets: ${targetCounts.size.toLocaleString()}`,
      `Active (last ${args.days}d): ${activeFiles.length} files over ${Object.keys(perDaySorted).length} days, ${burstSummary.length} sessions`,
      `Notes by prefix: ${prefixTable
        .map((p) => `${p.prefix}=${p.noteBasenamesWithPrefixSeparator}/${p.noteBasenamesStartingWith}`)
        .join(" ")}`,
      `Wrote ${args.out}`,
    ];
    process.stderr.write(lines.join("\n") + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(`analyze-novel-vault: ${e.stack || e.message}\n`);
  process.exit(1);
});

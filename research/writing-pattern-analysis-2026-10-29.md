# Writing-Pattern Analysis — Novel Vault (2026-10-29)

Offline corpus analysis of `/Users/caffae/Notes/Novel-Writing`, produced to ground the
typing-latency discussion in real numbers instead of guesses.

**Artifacts**

| File | What it is |
|---|---|
| `scripts/analyze-novel-vault.mjs` | Standalone Node script (no new deps) that produced the data |
| `research/writing-pattern-data-2026-10-29.json` | Raw output (~128 KB) — every number below is traceable to it |
| `research/writing-pattern-analysis-2026-10-29.md` | This document |
| `research/typing-speed-audit-2026-10-29.md` | Companion source audit of the hot paths |

**How to reproduce**

```bash
node scripts/analyze-novel-vault.mjs \
  --vault /Users/caffae/Notes/Novel-Writing \
  --days 30 \
  --out research/writing-pattern-data-2026-10-29.json
```

Scan took **2.8–3.2 s** wall clock (concurrency 12, 190 MB of markdown).

**Confidence tags used below**

- **[M]** measured by this script on this vault
- **[B]** measured by the repo's Node bench harness (`bench/`, stubs, *not* Obsidian)
- **[I]** inferred / extrapolated — reasoning, not measurement
- **[?]** unknown, cannot be determined from disk

---

## 1. Executive summary

The vault is not a "large Obsidian vault" in the abstract sense. It is a vault where
**one prefix owns almost everything, and that prefix is also the one the writer types
most.**

Actual numbers [M]:

| Metric | Value |
|---|---|
| Markdown notes parsed | **14,433** (14,434 discovered; 1 skipped > 4 MB) |
| Directories | 1,525 |
| Words (body, frontmatter stripped) | **28,916,918** |
| Link occurrences | **593,570** |
| Distinct link targets | **15,486** |
| Wiki links with `\|alias` display text | **565,968** (95.9 % of 590,392 wiki links) |
| Links per 1,000 words | **20.53** |
| Notes whose basename starts with `c` (case-insensitive) | **10,628** — **73.6 % of the vault** |
| Notes whose basename matches `^char[\s\-–—_·:]+` (`Char - …`) | **4,892** |
| Notes matching `^chapter[\s\-–—_·:]+` (`Chapter - …`) | **5,572** |
| Link occurrences whose target starts with `cha` | **542,951** — **91.47 % of all links** |
| Distinct link targets starting with `char` | **5,160** |
| Distinct link targets starting with `cha` | **9,904** |

**Main lag hypothesis.** The internal-link suggestion index keys candidates by **first
letter only**. In this vault the `c` bucket holds **11,177 indexed values** (basenames +
frontmatter aliases) [M]. Every keystroke in exact-match mode pulls that bucket, runs
the matcher over *all* of it, then sorts the survivors to return a handful. Because the
matcher runs before any narrowing, typing more characters does **not** reduce work:
at query `cha` the plugin still judges **11,177** values to surface **10,520** matches,
and at query `char` it still judges **11,177** to surface **4,936** [M].

The plugin is therefore not paying for "the word you are typing". It is paying for
**"every note in the vault that starts with the same letter"** — and in this vault that
is three quarters of the vault.

---

## 2. Vault scale and writing cadence

### 2.1 Where the words live [M]

| Group | Notes | Words | Share of words |
|---|---:|---:|---:|
| Chapter notes (`Chapter - …`) | 5,588 | 25,121,407 | **86.9 %** |
| Everything else | 8,845 | 3,795,464 | 13.1 % |
| **Total** | **14,433** | **28,916,871** | 100 % |

Median note length is **212 words**, mean is **2,003.5** — a long tail of tiny notes plus
a heavy core of long chapters. The writing that matters happens in files that are *large*:

| Chapter stats | median | p90 | max |
|---|---:|---:|---:|
| Words per chapter | **3,416** | **9,500** | **42,975** |
| Links per chapter | **68** | **232** | **1,028** |
| Distinct link targets per chapter | **11** | **29** | **105** |

A p90 chapter is ~9,500 words of continuous text in a single editor buffer. Any
per-keystroke or per-save operation that is O(file) will be felt there first.

### 2.2 Cadence last 30 days [M]

- **573 files** modified (3.97 % of the vault) across **31 calendar days** — ≈ **19.1 files/day**
- **193** save sessions (consecutive saves < 30 min apart)
- Session duration: median **0 min** (single-save sessions dominate), mean **20.2 min**,
  p90 **61.8 min**, max **333.5 min** (5 h 33 m)
- Files per session: median **1**, mean **2.96**, p90 **7**, max **35**
- Words in touched files: **2,264,176** — *not* words written; see the caveat below

Busiest days: 2026-10-06 (**47** files), 2026-10-10 (**45**), 2026-10-08 (**43**),
2026-10-09 (37), 2026-10-11 (37). Longest sessions:

| Started | Duration | Files | Words in touched files |
|---|---:|---:|---:|
| 2026-10-10T15:12Z | 333.5 min | 35 | 159,871 |
| 2026-10-09T17:42Z | 276.1 min | 20 | 101,610 |
| 2026-09-30T09:15Z | 151.8 min | 16 | 59,461 |
| 2026-10-07T07:23Z | 145.2 min | 17 | 76,961 |
| 2026-10-05T18:57Z | 141.5 min | 13 | 66,314 |

**Caveat that matters for latency work.** mtime is *save* time, and Obsidian autosaves
roughly every ~2 s after the last edit. A 5.5-hour session is 5.5 hours of *saves*, i.e.
potentially thousands of save events. Under this plugin each save triggers the current-file
re-tokenisation path (see audit §2.1), so the number of *save events per session* is the
relevant load, not the number of files. Files-per-session (median 1) says the writer works
in one chapter at a time — which means the O(file) per-save work is charged against the
single largest file open.

`estimatedWordsTouched` is deliberately pessimistic: editing one line of a 3,000-word
chapter counts as 3,000 words. It measures *exposure*, not production.

---

## 3. Link-writing frequency

This is a **link-dense** vault, and the density is the whole story.

### 3.1 Aggregate [M]

| Metric | Value |
|---|---:|
| Link occurrences | 593,570 |
| Links per 1,000 words | **20.53** |
| Links per word | **0.0205** (≈ one link every 49 words) |
| Distinct targets | 15,486 |
| Occurrences per distinct target | **38.3** |
| Within chapter notes only | 545,872 links / 25.1 M words = **21.7 per 1k words** |
| Link occurrences inside the 574 modified files | 55,830 → **97.3 per modified file** |
| Link occurrences per active day (modified files only) | **1,801** |

For comparison, a typical prose note navigates maybe one link every few hundred words. At
one link per ~49 words, the suggestion popup is plausibly open for a large fraction of
typing time. Link syntax is also almost entirely wiki-style:

| Syntax | Count |
|---|---:|
| `[[…]]` | 590,392 |
| `[[target\|display]]` | 565,968 (95.9 % of wiki links) |
| `![[…]]` embeds | 2,581 |
| `[text](path.md)` | 130 |
| `![…](…)` embeds | 474 |
| External URLs (ignored) | 6,342 |

**95.9 % of wiki links carry explicit display text.** That is a strong behavioural signal:
the writer types a short name ("Daemon") and expects the link to keep its long note name
("Char - Daemon Targaryen"). Any fix that only matches against `basename` and not
against aliases/hit-forms would break this vault's actual workflow.

### 3.2 Per-chapter distribution [M]

| Percentile | Links | Distinct targets | Words |
|---|---:|---:|---:|
| min | 0 | 0 | 0 |
| median | 68 | 11 | 3,416 |
| p90 | 232 | 29 | 9,500 |
| max | 1,028 | 105 | 42,975 |

A single chapter can contain **1,028** link occurrences. At 5 suggestions each, that is a
lot of popup lifetime — and 1,028 edits that each risk a 2–6 ms synchronous block.

### 3.3 Activity-window chapters (the ones actually being edited) [M]

| | median | p90 | max |
|---|---:|---:|---:|
| Words | 4,469 | 9,740 | 38,461 |
| Links | 110 | 260 | 499 |
| Distinct targets | 14 | 26 | 54 |

425 of the 5,588 chapters were touched in the window. The active ones are **longer than
average** (median 4,469 vs 3,416 words), which means per-save O(file) work is being paid
on the worst-case files.

---

## 4. The `cha`/`char` collision

Three different populations are all fighting over the same shelf:

1. **`Char - …` (character notes)**: 4,892 notes, 4,897 basenames start with `char`
2. **`Chapter - …` (chapter notes)**: 5,572 notes, 5,583 basenames start with `chapter`
3. **`cha` as a link-target prefix**: 9,904 distinct targets, **542,951 link occurrences**

```
prefix      link occurrences   distinct targets   notes (^prefix+separator)   notes (startsWith)
c                  543,038               9,983                          0              10,628
ch                 542,954               9,907                          0              10,504
cha                542,951               9,904                          1              10,499
char               535,421               5,160                      4,892               4,897
chap                 7,528               4,742                         16               5,600
chapter              7,500               4,717                      5,572               5,583
world               36,222               1,077                      1,065               1,067
```

**Read the `c` / `ch` / `cha` rows carefully.** They are nearly identical because they are
the *same* population seen through three prefixes: `Char - …` matches all three. `cha`
covers 91.47 % of every link in the vault. `char` covers 90.20 % on its own.

Note also that `Char - …` and `Chapter - …` **both** branch at `cha`. So `cha` is the
unique pivot where the candidate set is maximal — and it is exactly the prefix a writer
types on the way to either `Char` or `Chapter`.

**Link frequency vs note count diverge sharply for `chap`.** `chapter` has 5,572 notes
but only **7,500** link occurrences (1.3 % of links), while `char` has 4,892 notes and
**535,421** link occurrences. Notes are equally numerous; usage is 71× apart. The
`Char - …` namespace is where the linking actually happens.

### 4.1 Where the links point [M] — top 20

| # | Target | Occurrences | Share |
|---:|---|---:|---:|
| 1 | `Char - Ashwann Glaxin` | 20,385 | 3.43 % |
| 2 | `Char - Li Huanxin` | 13,256 | 2.23 % |
| 3 | `Char - Sirin Orion Black` | 9,953 | 1.68 % |
| 4 | `Char - James Potter` | 9,763 | 1.65 % |
| 5 | `Char - Yang Huaixian` | 8,159 | 1.38 % |
| 6 | `Char - Daemon Targaryen` | 8,131 | 1.37 % |
| 7 | `Char - Harles` | 7,987 | 1.35 % |
| 8 | `Char - Li Xianglang` | 6,839 | 1.15 % |
| 9 | `Char - Xi An` | 6,583 | 1.11 % |
| 10 | `Char - Yang Guangzhi` | 6,459 | 1.09 % |
| 11 | `Char - Si Lian` | 5,362 | 0.90 % |
| 12 | `World Series - Groups` | 5,207 | 0.88 % |
| 13 | `Char - Regulus Black` | 5,129 | 0.86 % |
| 14 | `Char - Tu En` | 5,060 | 0.85 % |
| 15 | `Char - Annabella Wisteria` | 4,864 | 0.82 % |
| 16 | `Char - Inoue Yuki` | 4,711 | 0.79 % |
| 17 | `Char - Tao Shiyun` | 4,293 | 0.72 % |
| 18 | `Char - Namikaze Minato` | 4,134 | 0.70 % |
| 19 | `Char - Hatake Kakashi` | 3,981 | 0.67 % |
| 20 | `Char - Yang Huaijun` | 3,682 | 0.62 % |

19 of the top 20 are `Char - …`; the 20th-place entry alone has 3,682 uses. Popularity is
real but **flat**: the top target is only 3.4 % of all links, so no small "hot set" can be
pre-ranked to avoid scanning the bucket. This is the opposite of a power-law where a
100-item cache would work; you need the whole `c` bucket or none of it.

---

## 5. Which prefixes produce huge candidate sets

The plugin indexes internal-link candidates into `wordsByFirstLetter[firstChar]`
(`src/provider/InternalLinkWordProvider.ts:168-173`) and on each keystroke pulls the
bucket for `query[0]` in both cases (`src/provider/suggester.ts:240-298`), then runs
`judge` over **every** entry before filtering (`src/provider/suggester.ts:300-302`).

So cost ∝ **bucket size**, not match count. Measured bucket sizes for this vault [M]
(basenames + frontmatter aliases, synonym/emoji forms excluded):

| Query | First-letter bucket judged | Values matching prefix | Judged ÷ matched |
|---|---:|---:|---:|
| `c` | **11,177** | 11,177 | 1.00 |
| `ch` | **11,177** | 10,721 | 1.04 |
| `cha` | **11,177** | 10,520 | 1.06 |
| `char` | **11,177** | 4,936 | 2.26 |
| `chap` | **11,177** | 5,530 | 2.02 |
| `chapter` | **11,177** | 5,514 | 2.03 |
| `world` | **1,288** | 1,022 | 1.26 |

Two consequences:

1. **Typing more characters does not make it cheaper.** `ch`, `cha`, `char`, `chap`,
   `chapter` all judge the same 11,177 entries. The only thing that changes is how many
   survive to the sort. The `char` step does cut the sort input in half (4,936 vs 10,520),
   which is why it is worth ~12 % less in the bench — but the *judge* pass is unchanged.
2. **`world` is 8.7× cheaper than `c`** (1,288 vs 11,177). Any latency report that says
   "typing feels fine" must specify *which prefix* — the experience is not uniform across
   the alphabet. Prefixes `d`–`b` will feel completely different from `c`.

`distinctIndexedValues` total = **25,442** (14,433 basenames + ~11,009 distinct aliases).
The `c` bucket is **43.9 %** of the entire internal-link index and **73.6 %** of notes.

### 5.1 Alias fan-out: real but small [M]

| Metric | Value |
|---|---:|
| Files with frontmatter | 12,169 |
| Files with aliases | 7,470 (**51.8 %**) |
| Total alias entries | 11,640 |
| Distinct aliases | 11,379 |
| Median aliases per aliased file | 1 |
| p90 | 2 |
| Max | 25 (`World Building/Char - Charlie Tate.md`) |
| Histogram | 0 → 6,963 · 1 → 3,981 · 2 → 2,974 · 3–5 → 506 · 6–10 → 8 · 11+ → 1 |
| Aliases colliding with another note's basename | **7** |

Aliases do **not** multiply the `c` bucket much — they add ~549 values (11,177 − 10,628).
The extra rows do inflate the index and each alias is pushed into its own first-letter
bucket (`InternalLinkWordProvider.ts:170-172`), so a long alias list creates duplicate
`Word` references under several buckets. But alias explosion is *not* the cause here.
The cause is plain basename volume.

**Important interaction:** `suggestInternalLinkWithAlias` defaults to `false`
(`src/setting/settings.ts:237`). Aliases are then stored as *match forms* on the basename
`Word`, not as separate candidates. That keeps the bucket at 11,177 rather than ~22k — but
it also means every failed value match falls through to the alias loop in `judge`
(`src/provider/suggester.ts:151-158`), which allocates an array per candidate. With
`prioritizeAliases: true` (default, `settings.ts:238`) the sort comparator also pays an
extra branch per comparison.

---

## 6. What this means for Obsidian

### 6.1 The budget

- 60 Hz → **16.7 ms** per frame. 120 Hz → **8.3 ms**.
- The plugin's suggestion work is **synchronous** on the main thread, inside
  `debounceGetSuggestions` (`src/ui/AutoCompleteSuggest.ts:578-732`). While it runs, the
  editor cannot paint a new cursor position. This is not "background indexing"; it is
  inline work on the keystroke.
- Obsidian autosaves roughly **every ~2 s** after the last edit, and this plugin hooks
  `vault.on("modify")` → `debouncedRefreshCurrentFileTokens` (300 ms,
  `AutoCompleteSuggest.ts:227-245`), which re-tokenises the **entire active file**.

### 6.2 Bench numbers, quoted exactly

From `bench/results/latest.md` (N = 21 iterations per scenario), as read on 2026-10-28
before the bench directory was regenerated. **These run in Node against stubs — they are
not in-app measurements.**

| Scenario | p50 ms | p95 ms | max ms | candidates | frame-budget |
|---|---:|---:|---:|---:|---|
| refresh-internal-links cold | 2.875 | 5.988 | 12.548 | 14400 | yellow |
| refresh-internal-links warm | 1.962 | 4.247 | 6.491 | 14400 | green |
| linkrank cold (Novel) | 30.161 | 32.847 | 43.718 | 12768 | red |
| linkrank warm hit (Novel) | 0.000 | 0.001 | 0.012 | 12768 | green |
| linkrank markSourceStale+get (Novel) | 0.012 | 0.032 | 0.037 | 12768 | green |
| linkrank rebuild full (Novel) | 30.049 | 32.340 | 35.603 | 12768 | red |
| folderrank cold first folder | 27.487 | 36.457 | 59.653 | 869 | red |
| folderrank second folder same version | 0.001 | 0.004 | 0.056 | 869 | green |
| folderrank warm hit | 0.001 | 0.004 | 0.013 | 869 | green |
| folderrank structure bump | 10.921 | 11.664 | 11.904 | 869 | yellow |
| suggest-keystroke hu (fp off) | 0.003 | 0.017 | 0.022 | 0 | green |
| suggest-keystroke ch (fp off) | 2.652 | 3.314 | 4.358 | 5 | green |
| suggest-keystroke ch (fp on) | 5.547 | 7.391 | 7.723 | 5 | yellow |
| suggest-keystroke cha (fp off) | 2.550 | 3.798 | 3.913 | 5 | green |
| suggest-keystroke cha (fp on) | 5.406 | 5.895 | 6.257 | 5 | yellow |
| suggest-keystroke char (fp off) | 2.246 | 2.839 | 3.196 | 5 | green |
| suggest-keystroke char (fp on) | 3.564 | 3.964 | 4.139 | 5 | green |
| session-sim 300 keystrokes | 399.290 | 457.141 | 469.047 | 4 | red |
| memory heap delta | 134.569 | 138.382 | 140.871 | 20 | red |

Reading those numbers honestly:

- **Per-keystroke cost at `ch`/`cha`/`char` is 2.2–2.6 ms** with folder priority off, and
  **3.6–5.5 ms** with it on. On a 60 Hz frame that is 13–33 % of the budget; on 120 Hz it
  is 27–66 %. That alone rarely drops a frame. Combined with CM6 edit handling, live
  preview rendering of a 9,500-word chapter, and any other per-keystroke plugin, it
  plausibly does.
- **Folder priority roughly doubles the comparator cost** at `cha`: 2.550 → 5.406 (2.12×).
  That is the sort comparator paying `getOrComputeLinkRank` + folder-rank lookups.
- **The simulated 300-keystroke session** costs 399 ms p50 / 457 ms p95 — **~1.33 ms per
  keystroke average**, i.e. "cheap keystrokes, expensive burst". The session-sim runs at
  `red` because total time, not per-frame, is what it measures.
- **`linkrank cold` = 30 ms and `folderrank cold first folder` = 27 ms.** Whichever
  keystroke lands first after an invalidation eats ~30–57 ms. That is 2–3 dropped frames
  and is the most user-visible single stall in the bench. It happens on
  `metadataCache.on("resolved")` → `invalidate()` (`AutoCompleteSuggest.ts:289-300`) and
  on every settings change (`updateSettings`, line 503-505).
- **`folderrank structure bump` = 10.9 ms.** `FolderRankCache.ensureSummary()` calls
  `app.vault.getMarkdownFiles()` and walks every note's ancestor chain
  (`FolderRankCache.ts:148-190`). `bumpStructure()` fires on create/rename/delete — so the
  *next keystroke* after creating a note pays this.

**Two caveats that matter for interpreting these numbers:**

1. The bench `suggest-keystroke` scenarios call `suggestWords` **without** the `fuzzy`
   option, i.e. they measure the `lowerStartsWith` path. The app defaults to
   `fuzzyMatch: true` (`src/setting/settings.ts:160`), which selects `lowerFuzzy` /
   `microFuzzy` (`src/provider/suggester.ts:112`) — a full character scan per candidate
   plus two `toLowerCase()` allocations, instead of a prefix test. **The default
   configuration is therefore very likely more expensive than the number in the table, and
   that path is not measured at all.** This is the single biggest measurement gap. [I]
2. The bench fixture is synthetic (`bench/fixtures.ts`): it generates `Char - …` and
   `Chapter - …` basenames per world/story, so its `c` bucket is the same *order of
   magnitude* as this vault's 11,177 distinct values, but not the same shape. Generated
   names repeat across stories (the same `Chapter - T1` basename appears in many story
   folders), so the fixture pays for many duplicate-value judgements where the vault pays
   for distinct names of varying length. That makes the 2.2–2.6 ms figure a reasonable
   *order-of-magnitude* anchor for the non-fuzzy path here — **not** a prediction, and not
   something to scale linearly. The fixture and `bench/results/latest.md` were also being
   regenerated concurrently while this document was written, so the corpus behind that
   table may already differ. [I]


### 6.3 What the vault says about the plugin's design assumptions

- A first-letter bucket is a fine index for `"the"`-style vocabularies and a terrible one
  for `"Char - …"`-style namespaces. 43.9 % of the internal-link index sits behind one letter.
- The plugin's own `internalLinkIgnoreTriggerPrefixes` setting (added in commit
  `d2e9d7a`, default `""`, `src/setting/settings.ts:240`) already attacks exactly this:
  it drops basenames matching `^prefix[\s\-–—_·:]+` at **refresh** time
  (`InternalLinkWordProvider.ts:41-52`, `:102`, `:119`). Configured with
  `char, chapter, world` it would remove **10,450** of the 11,177 `c`-bucket values [M]
  — but with `suggestInternalLinkWithAlias: false` those notes vanish from suggestions
  entirely, not just their `Char - ` form. Given 95.9 % of links carry display aliases,
  that trade-off is worth testing but is *not* an obvious win.
- The hot path has no prefix narrowing at all, so bucket size is a cliff, not a slope.
  This is the single highest-leverage structural fact in the analysis.

---

## 7. Other plausible lag causes, ranked

Ranked by (confidence we understand it) × (magnitude on *this* vault). Deliberately
excludes "Obsidian is slow" hand-waving.

| # | Cause | Evidence | Est. magnitude | Confidence |
|---:|---|---|---|---|
| 1 | **Full `c` bucket judged per keystroke** (11,177 values, no narrowing) | bucket size [M]; bench 2.2–5.5 ms at ~4–5 k [B] | 2.5–6 ms/keystroke, more with fuzzy | **High** |
| 2 | **Sorting 10,520 survivors to return 5** with a 9-branch comparator | `suggester.ts:369-448`; `cha` → 10,520 matched [M] | 1.5–4 ms/keystroke | **High** |
| 3 | **Cold LinkRank rebuild (30 ms) + cold FolderRank build (27 ms)** on first keystroke after `resolved`/settings change | bench `linkrank cold (Novel)` 30.161 p50, `folderrank cold first folder` 27.487 p50 [B] | 30–57 ms hitch, occasionally | **High** |
| 4 | **`getMarkdownFiles()` summary rebuild after create/rename/delete** lands on the next keystroke | `FolderRankCache.ts:148-190`; bench `folderrank structure bump` 10.921 p50 [B] | ~11 ms hitch per structure event | **High** |
| 5 | **Per-save full-chapter re-tokenisation** (`modify` → 300 ms debounce → tokenize whole active file, char-by-char `.match()`) | `AutoCompleteSuggest.ts:227-245` → `:871`; `DefaultTokenizer.ts:37-69` (`content[i].match(...)` at :45); chapters median 4,469 words active [M] | 5–40 ms per save on p90/max chapters; frequent | **Medium-High** |
| 6 | **Internal-link index rebuilt on every save** (1 s debounce): `getMarkdownFiles()` + per-file metadataCache lookups + alias arrays for 14.4 k notes | `AutoCompleteSuggest.ts:237-286`; `InternalLinkWordProvider.ts:55-145`; bench `refresh-internal-links warm` 1.962 p50 / 4.247 p95 [B] | 2–6 ms/save, bursty | **Medium-High** |
| 7 | **Partial-match completion mode scans the entire index** — `Object.values(bucket).flat()` over every provider | `suggester.ts:643-671` | order-of-magnitude worse than exact mode; 25 k+ values | **Medium** (only if that mode is used) |
| 8 | **`fuzzyMatch: true` default** turns each candidate into a lowercase + full char scan | `settings.ts:160`; `suggester.ts:112`, `strings.ts:208-240` | additive on top of #1, unmeasured | **Medium** |
| 9 | **Other per-keystroke plugins**: `typewriter-mode`, `sticky-headings-no-flicker` (both enabled) | `.obsidian/community-plugins.json`; risk labels in JSON | can easily exceed the plugin's own cost | **Medium** |
| 10 | **Editor-level cost of very long files** — 42,975-word max chapter, p90 9,500 | chapter distribution [M] | CM6 live-preview work scales with viewport, but source-map/scroll work does not | **Low-Medium** |
| 11 | **Startup `currentVault` refresh reads every file** (`adapter.stat` + `adapter.read` per note, sequential awaits) | `CurrentVaultWordProvider.ts:50-79` | ~3 s of I/O minimum (my concurrent scan of the same 190 MB took 2.8 s at concurrency 12; sequential is worse) — first-load jank, not typing | **High confidence, wrong symptom** (startup, not keystroke) |
| 12 | **`uniqWith` is O(n²)** via `filter`+`findIndex` | `collection-helper.ts:28-32` | negligible here (n ≤ ~15 after slice) | Low |

### Plugin inventory [M] — 25 enabled

High typing risk:
- `typewriter-mode` — per-keystroke cursor centring/dimming on the same frame budget
- `sticky-headings-no-flicker` — per-keystroke CM6 decoration recomputation

Medium (vault-wide or event-driven):
- `metadata-extractor` — second vault-wide metadata index alongside Obsidian's
- `templater-obsidian` — template parse on create/open
- `quickadd` — capture macros on save
- `file-tree-alternative` — full tree re-render on vault events

Low: 18 others (icons, hider, footnotes, hotkey-helper, BRAT, lazy-plugins, …).
`lazy-plugins` may actually *help* startup. Full table with per-plugin notes is in the
JSON under `plugins.typingRisk`.

---

## 8. What to test in Obsidian (checklist)

Ordered so that each step either confirms/refutes the hypothesis or eliminates a
confounder. **None of this is a code change.** Run in a **duplicate vault** if you can —
several steps toggle settings globally.

### A. Bisect the plugin set first (cheapest elimination)
1. Open the vault in **Safe Mode** (Settings → Community plugins → *Turn on Safe mode*).
   Type 200 words in the largest active chapter. Note subjective smoothness.
2. Re-enable **only** `various-complements-with-folder-priority`. Repeat.
   - Still sluggish → the plugin is implicated.
   - Smooth now → the cost is a plugin *interaction* (see #9 in §7), not the plugin alone.
3. Re-enable in halves (`typewriter-mode` + `sticky-headings-no-flicker` first, since they
   are the highest-risk per-keystroke neighbours).
4. Record: safe mode / plugin-only / all plugins. Three data points, one variable.

### B. Get a real in-app profile (the thing this analysis cannot do)
5. Open DevTools (`Cmd+Opt+I`) → **Performance** → record 20 s while typing continuously
   in the chapter with the most links.
6. Look for long **`Function Call` / `Event Dispatch`** tasks > 16.7 ms whose stack
   contains `suggestWords`, `judge`, `getRankData`, `buildList`, or `refreshWords`.
   - Stack frames naming `suggestWords` → confirm §7 #1/#2.
   - Frames naming `rebuild`/`buildList` → confirm §7 #3/#4 (cold cache, not steady state).
   - Frames naming `refreshCurrentFileTokens`/`tokenize` → confirm §7 #5.
7. Repeat with the **Performance Monitor** open (CPU % + frame rate) to correlate.

### C. Isolate prefix cost inside the plugin
8. In a scratch note, type `world`, then `char`, then `cha`, then `ch`, then `c`
   — 20 times each, in the same note, with `showLogAboutPerformanceInConsole` enabled
   so `[onTrigger]` / `Get suggestions` timings appear in the console.
9. Compare the logged ms for `world` vs `cha`. The vault analysis predicts a **~8.7×**
   ratio in bucket size. If the ratio is much smaller, the cost is dominated by something
   other than the bucket scan (e.g. fixed comparator overhead).

### D. Prove the bucket theory with `internalLinkIgnoreTriggerPrefixes`
10. Settings → Internal link → set **Ignore trigger prefixes** to `char,chapter,world`.
11. Reload Obsidian (the index is rebuilt on refresh, not instantly).
12. Re-run step 8. The `c` bucket should collapse from 11,177 to a few hundred.
    **Prediction: a large, obvious drop for `cha`/`char`.**
13. **Check the workflow cost**: does typing `Daemon` still produce
    `[[Char - Daemon Targaryen|Daemon]]`? With `suggestInternalLinkWithAlias` off, those
    notes may drop out of suggestions entirely. If so, try
    `suggestInternalLinkWithAlias: on` + ignore prefixes, which keeps alias-only matches.
    Judge whether the alias-only list is usable.
14. Revert if the UX loss outweighs the speed.

### E. Config-only stress tests (each isolates one variable)
15. **Larger min trigger length**: set `minNumberOfCharactersTriggered` = 3 (or 4). The
    trigger gate in `onTrigger` (`AutoCompleteSuggest.ts:1234-1243`) then suppresses the
    popup for 1–2 char prefixes. If the vault feels much better, the cost is concentrated
    in short prefixes — confirming the bucket theory.
16. **Cap suggestions**: set `maxNumberOfSuggestions` = 3. This shrinks the sort output
    only, *not* the judge pass — so a large improvement here means the **sort** (#2)
    dominates; no change means the **judge** (#1) dominates. This is a clean A/B.
17. **Toggle folder priority off** and repeat. Bench says ~2.1× at `cha`; if in-app the
    delta is bigger than that, the folder-rank cache is thrashing (check for repeated
    `rebuild`/`buildList` frames in the profile).
18. **Toggle `fuzzyMatch` off** (`fuzzyMatch: false`). Bench only measured the non-fuzzy
    path, so this tells you how much the default fuzzy scan costs on this vault.
19. **Toggle `excludeInternalLinksInCode`** — off by default for good reason:
    `onTrigger` calls `inCodeBlock()` → `editor.getValue()` over the whole document
    (`app-helper.ts:239-241`, `:158-160`) when it is on. Enabling it on a 9,500-word
    chapter should visibly hurt; that would confirm the O(document) scan is real.

### F. Structural events (cache invalidation)
20. Create a new note, then immediately type 10 characters. Bench predicts a ~11 ms hitch
    (`folderrank structure bump`). Subjectively: a visible stutter on the first keystroke
    after note creation.
21. Change any plugin setting, then type immediately. Bench predicts ~30 ms
    (`linkrank cold`) + ~27 ms (`folderrank cold first folder`). This should be the most
    reproducible stall in the whole plugin — try it 5 times and time it.
22. Open Obsidian fresh and type immediately (before the vault has settled). Same 30+27 ms
    path, plus the startup current-vault read.

### G. Record what you find
23. For each test, note: build (`manifest.json` version), active chapter word count,
    prefix typed, and the logged ms. Without the prefix and the chapter size, the numbers
    are not comparable — §5 shows the same plugin is 8.7× more expensive at `c` than
    at `w`.

---

## 9. Uncertainty, stated plainly

Things this analysis does **not** establish:

1. **No in-app latency was measured.** Every millisecond figure tagged [B] comes from a
   Node harness with stubbed Obsidian APIs, a synthesized 14,000-file fixture, and a warm
   V8. Real Obsidian has a different allocator profile, real CM6 rendering, and other
   plugins on the same thread. The JSON contains no in-app timings because none were
   collected.
2. **The 2.2–5.5 ms keystroke numbers were measured on a *synthetic* corpus**
   (`bench/fixtures.ts`), not on this vault. Its `c` bucket is the same order of magnitude
   as this vault's 11,177 distinct values, so those timings are a usable order-of-magnitude
   anchor — but the generated names have different lengths and repeat across story folders,
   so the judge/sort mix differs. Do not scale them linearly by note count.
3. **The bench measured the non-fuzzy path**, while the app defaults to `fuzzyMatch: true`.
   The real default-config cost is unknown and is very likely higher.
4. **`mtime` is save time.** Obsidian autosaves ~2 s after the last edit, so a "session" in
   §2.2 is a run of *saves*, and `estimatedWordsTouched` counts full file sizes, not edits.
   Nothing here reveals how many keystrokes occurred, or typing speed.
5. **Link resolution is not performed.** Without `metadataCache` we cannot separate
   resolved targets from unresolved/phantom links; both are counted. ~15,486 distinct
   targets include any phantom names.
6. **Ignore-filters are not applied.** The scan skipped only `.obsidian`, `.git`,
   `node_modules` as specified. It therefore includes `.trash` (1,248 notes),
   `.smart-env`, `Attachments` (341), and template folders — none of which the plugin
   necessarily indexes. **Vault totals are therefore an upper bound on what the plugin
   actually sees**; the `c`-bucket count (11,177) is built from the same superset.
7. **Alias parsing is a YAML subset.** Inline lists, comma lists, and block lists are
   handled; anchors, multi-line scalars, and exotic YAML are not. 11,640 alias entries is
   a floor, not a ceiling.
8. **The plugin's runtime exclusions are unknown.** `excludeInternalLinkPathPrefixPatterns`,
   glob exclusions, tag exclusions, and the brand-new `internalLinkIgnoreTriggerPrefixes`
   all shrink the real index. If the user has already configured exclusions, real bucket
   sizes are smaller than modelled here. **[?]** — read the live `data.json`.
9. **Word totals drift.** The vault is being edited while scans run: repeated runs gave
   28,916,808 → 28,916,858 → 28,916,871 words. Treat 28.92 M as ±0.001 %. Bucket counts
   (11,177) are more stable but not frozen.
10. **Bench `latest.md` is in flux.** It was read at ~15:49 on 2026-10-28; the `bench/`
    directory was subsequently regenerated by concurrent work and `bench/results/latest.md`
    was briefly absent. Re-run `node bench/run.mjs` before quoting those numbers in any
    external document.

Cross-reference: `research/typing-speed-audit-2026-10-29.md` walks the same claims down to
file:line in `src/`, and ranks candidate fixes by impact/effort against these scenarios.

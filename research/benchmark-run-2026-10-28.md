# Benchmark results

## Suite metadata

- Date: 2026-10-28T08:41:46.017Z
- Node: v25.6.1 (darwin/arm64)
- Iterations per scenario (N): 21 (full mode)
- Fixture: 14000 markdown files (deterministic, seed 20261028)
- Current file: `Novel/Ancient China/Story 1/Chapter - T1.md`
- Scenarios: 31
- Sum of p50 per scenario: 1013.2 ms

## Scenarios

Legend: `p50`/`p95`/`max` are wall-clock ms per run of the timed region (p95 = nearest-rank). `candidates matched` is the true pre-truncation candidate count for the query (judged results before the top-5 cut, not `res.length`). `pool scanned` is how many words the first-letter buckets held for that query, before judging. `frame-budget` compares p95 against one 60 fps frame (16.7 ms): green < 5 ms, yellow 5-16.7 ms, red > 16.7 ms.

| Scenario | p50 ms | p95 ms | max ms | candidates matched | pool scanned | frame-budget |
|---|---:|---:|---:|---:|---:|---|
| refresh-internal-links cold | 2.533 | 4.838 | 6.149 | 14400 | - | green |
| refresh-internal-links warm | 2.397 | 4.408 | 4.556 | 14400 | - | green |
| refresh-internal-links warm (ignore Char/Chapter) | 1.405 | 2.523 | 3.213 | 1400 | - | green |
| refresh-after-change save (fp on) | 35.491 | 37.892 | 38.018 | 13000 | 13000 | red |
| refresh-after-change save (fp on, ignore Char/Chapter) | 0.009 | 0.022 | 0.028 | 0 | 0 | green |
| linkrank cold (Novel) | 30.298 | 34.310 | 48.725 | 12768 | - | red |
| linkrank warm hit (Novel) | 0.000 | 0.002 | 0.008 | 12768 | - | green |
| linkrank markSourceStale+get (Novel) | 0.009 | 0.012 | 0.014 | 12768 | - | green |
| linkrank rebuild full (Novel) | 29.926 | 31.778 | 33.977 | 12768 | - | red |
| linkrank cold () | 0.002 | 0.003 | 0.004 | 0 | - | green |
| linkrank warm hit () | 0.000 | 0.001 | 0.001 | 0 | - | green |
| folderrank cold first folder | 23.253 | 24.437 | 26.107 | 869 | - | red |
| folderrank second folder same version | 0.001 | 0.002 | 0.009 | 869 | - | green |
| folderrank warm hit | 0.001 | 0.002 | 0.011 | 869 | - | green |
| folderrank structure bump | 10.790 | 11.797 | 12.492 | 869 | - | yellow |
| suggest-keystroke hu (fp off) | 0.002 | 0.003 | 0.004 | 0 | 0 | green |
| suggest-keystroke hu (fp on) | 0.003 | 0.004 | 0.022 | 0 | 0 | green |
| suggest-keystroke ch (fp off) | 2.592 | 3.303 | 3.454 | 13000 | 13000 | green |
| suggest-keystroke ch (fp on) | 35.386 | 36.845 | 36.864 | 13000 | 13000 | red |
| suggest-keystroke cha (fp off) | 1.955 | 2.732 | 2.968 | 13000 | 13000 | green |
| suggest-keystroke cha (fp on) | 35.419 | 36.867 | 52.279 | 13000 | 13000 | red |
| suggest-keystroke char (fp off) | 1.540 | 2.409 | 2.457 | 4000 | 13000 | green |
| suggest-keystroke char (fp on) | 20.111 | 21.029 | 21.743 | 4000 | 13000 | red |
| suggest-keystroke ch (fp on, ignore Char/Chapter) | 0.003 | 0.018 | 0.022 | 0 | 0 | green |
| suggest-keystroke cha (fp on, ignore Char/Chapter) | 0.002 | 0.003 | 0.003 | 0 | 0 | green |
| suggest-keystroke char (fp on, ignore Char/Chapter) | 0.002 | 0.003 | 0.031 | 0 | 0 | green |
| suggest-keystroke ch (fp on, ignore Chapter) | 20.018 | 20.782 | 20.855 | 4000 | 4000 | red |
| suggest-keystroke cha (fp on, ignore Chapter) | 19.963 | 21.062 | 21.195 | 4000 | 4000 | red |
| suggest-keystroke char (fp on, ignore Chapter) | 19.983 | 20.652 | 20.921 | 4000 | 4000 | red |
| session-sim 300 keystrokes | 586.666 | 652.078 | 682.286 | 4 | - | red |
| memory fixture build | 133.452 | 139.482 | 140.119 | 21 | - | red |

### Column caveats

- `memory fixture build`: the `candidates matched` column is the retained heap delta in MB for building the fixture + a warm LinkRankIndex. It is a **build-time** number, not a per-keystroke number.
- `session-sim 300 keystrokes`: the `candidates matched` column is the number of frames that exceeded 16.7 ms, extrapolated to 1200 keystrokes.
- `linkrank`/`folderrank` rows: `candidates matched` is the size of the rank structure built (targets or cached rank-list entries).
- `refresh-*`/`suggest-*` rows: `candidates matched` counts internal-link words that pass `judge()`; with `ignore Char/Chapter` the prefix-filtered basenames are absent from the index entirely, so both counts drop.

## Fixture build memory (build-time, not per-keystroke)

- Heap before fixture build: 4.1 MB
- Heap after fixture build:  34.3 MB
- Fixture build heap delta:  30.2 MB

These numbers describe the one-off cost of constructing the mock vault and its rank index in the benchmark process. They are not incurred while typing and should not be read as a per-keystroke budget.


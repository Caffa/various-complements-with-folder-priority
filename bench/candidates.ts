/**
 * Candidate-count helpers shared by the suggestion scenarios.
 *
 * `suggestWords(...)` truncates its result to `maxNum` (5 in the benchmarks),
 * so `res.length` can never describe how much work a keystroke actually did.
 * These helpers reproduce the *pre-truncation* funnel:
 *
 *   pool    = distinct words pulled from the first-letter buckets that
 *             suggestWords would scan for this query
 *   matched = pool entries that `judge()` accepts (i.e. would survive into the
 *             ranked list before the top-N cut)
 *
 * Both counts are computed outside the timed region: they are a property of
 * (provider, query) and never change between iterations.
 */

import type { Word } from "../src/model/Word";
import { judge, type WordsByFirstLetter } from "../src/provider/suggester";

/** Mirror of suggestWords' bucket lookup, de-duplicated by word identity. */
export function distinctPoolWords(
  words: WordsByFirstLetter,
  query: string,
): Word[] {
  const head = query.charAt(0);
  const keys = Array.from(
    new Set([head, head.toLowerCase(), head.toUpperCase()]),
  );
  const seen = new Set<Word>();
  const pool: Word[] = [];
  for (const key of keys) {
    for (const word of words[key] ?? []) {
      if (seen.has(word)) continue;
      seen.add(word);
      pool.push(word);
    }
  }
  return pool;
}

/** Same uppercase-first-letter rule suggestWords uses. */
function queryStartsWithUpper(query: string): boolean {
  return query.charAt(0).toUpperCase() + query.slice(1) === query;
}

export function countMatchedCandidates(
  words: WordsByFirstLetter,
  query: string,
): { pool: number; matched: number } {
  const pool = distinctPoolWords(words, query);
  const startsWithUpper = queryStartsWithUpper(query);
  let matched = 0;
  for (const word of pool) {
    if (judge(word, query, startsWithUpper).value !== undefined) matched++;
  }
  return { pool: pool.length, matched };
}

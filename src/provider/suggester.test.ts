import { describe, expect, test } from "@jest/globals";
import type { Word } from "../../src/model/Word";
import type { LinkRankData } from "../model/LinkRank";
import { SelectionHistoryStorage } from "../storage/SelectionHistoryStorage";
import type { IndexedWords } from "../ui/AutoCompleteSuggest";
import type { Judgement } from "./suggester";
import {
  judge,
  judgeByPartialMatch,
  pushWord,
  suggestWords,
  suggestWordsByPartialMatch,
  type WordsByFirstLetter,
} from "./suggester";

describe("pushWord", () => {
  const createWordsByFirstLetter = (): WordsByFirstLetter => ({
    a: [
      { value: "aaa", type: "currentFile", createdPath: "" },
      { value: "aa", type: "currentFile", createdPath: "" },
    ],
  });

  test("add", () => {
    const wordsByFirstLetter = createWordsByFirstLetter();
    pushWord(wordsByFirstLetter, "u", {
      value: "uuu",
      type: "currentFile",
      createdPath: "",
    });
    expect(wordsByFirstLetter).toStrictEqual({
      a: [
        { value: "aaa", type: "currentFile", createdPath: "" },
        { value: "aa", type: "currentFile", createdPath: "" },
      ],
      u: [{ value: "uuu", type: "currentFile", createdPath: "" }],
    });
  });

  test("push", () => {
    const wordsByFirstLetter = createWordsByFirstLetter();
    pushWord(wordsByFirstLetter, "a", {
      value: "a",
      type: "currentFile",
      createdPath: "",
    });
    expect(wordsByFirstLetter).toStrictEqual({
      a: [
        { value: "aaa", type: "currentFile", createdPath: "" },
        { value: "aa", type: "currentFile", createdPath: "" },
        { value: "a", type: "currentFile", createdPath: "" },
      ],
    });
  });
});

describe.each<{
  word: Word;
  query: string;
  queryStartWithUpper: boolean;
  fuzzy: number | false;
  expected: Judgement;
}>`
  word                                                                   | query   | queryStartWithUpper | fuzzy    | expected
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"bc"} | ${false}            | ${false} | ${{ word: { value: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"bd"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bd", type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"cb"} | ${false}            | ${0}     | ${{ word: { value: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", aliases: ["abc"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"bc"} | ${false}            | ${false} | ${{ word: { value: "abcde", aliases: ["abc"], type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"ac"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ac", aliases: ["abc"], type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"cb"} | ${false}            | ${0}     | ${{ word: { value: "abcde", aliases: ["abc"], type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", type: "internalLink", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"bd"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bd", type: "internalLink", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"Ab"} | ${true}             | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "Ab", type: "internalLink", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Ab"} | ${true}             | ${false} | ${{ value: "Abcde", word: { value: "Abcde", hit: "Abcde", query: "Ab", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Bd"} | ${true}             | ${0}     | ${{ value: "Abcde", word: { value: "Abcde", hit: "Abcde", query: "Bd", type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Bc"} | ${true}             | ${false} | ${{ word: { value: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Ab"} | ${true}             | ${false} | ${{ value: "abc", word: { value: "ce", hit: "abc", query: "Ab", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: true }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bc"} | ${true}             | ${false} | ${{ word: { value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bb"} | ${true}             | ${0}     | ${{ value: "abab", word: { value: "ce", hit: "abab", query: "Bb", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: true }, alias: true }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bb"} | ${true}             | ${1}     | ${{ word: { value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"ce"} | ${false}            | ${false} | ${{ value: "ce", word: { value: "ce", hit: "ce", query: "ce", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"ce"} | ${false}            | ${0}     | ${{ value: "ce", word: { value: "ce", hit: "ce", query: "ce", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${true}             | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
`("judge", ({ word, query, queryStartWithUpper, fuzzy, expected }) => {
  test(`judge(${JSON.stringify(
    word,
  )}, ${query}, ${queryStartWithUpper}, ${fuzzy}) = ${JSON.stringify(
    expected,
  )}`, () => {
    expect(
      judge(word, query, queryStartWithUpper, {
        fuzzy: fuzzy === false ? undefined : { minMatchScore: fuzzy },
      }),
    ).toStrictEqual(expected);
  });
});

describe.each<{
  word: Word;
  query: string;
  queryStartWithUpper: boolean;
  fuzzy: number | false;
  expected: Judgement;
}>`
  word                                                                   | query   | queryStartWithUpper | fuzzy    | expected
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"bc"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bc", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"bd"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bd", type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"cb"} | ${false}            | ${0}     | ${{ word: { value: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", aliases: ["abc"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"bc"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bc", aliases: ["abc"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"ac"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ac", aliases: ["abc"], type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", aliases: ["abc"], type: "customDictionary" }}      | ${"cb"} | ${false}            | ${0}     | ${{ word: { value: "abcde", aliases: ["abc"], type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"ab"} | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "ab", type: "internalLink", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"bd"} | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "bd", type: "internalLink", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "internalLink" }}                            | ${"Ab"} | ${true}             | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "Ab", type: "internalLink", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Ab"} | ${true}             | ${false} | ${{ value: "Abcde", word: { value: "Abcde", hit: "Abcde", query: "Ab", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Bd"} | ${true}             | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "Bd", type: "customDictionary", fuzzy: true }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${"Bc"} | ${true}             | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", query: "Bc", type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Ab"} | ${true}             | ${false} | ${{ value: "abc", word: { value: "ce", hit: "abc", query: "Ab", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: true }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bc"} | ${true}             | ${false} | ${{ value: "abc", word: { value: "ce", hit: "abc", query: "Bc", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: true }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bb"} | ${true}             | ${0}     | ${{ value: "abab", word: { value: "ce", hit: "abab", query: "Bb", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: true }, alias: true }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"Bb"} | ${true}             | ${1}     | ${{ word: { value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"ce"} | ${false}            | ${false} | ${{ value: "ce", word: { value: "ce", hit: "ce", query: "ce", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "ce", aliases: ["abc", "abab"], type: "customDictionary" }} | ${"ce"} | ${false}            | ${0}     | ${{ value: "ce", word: { value: "ce", hit: "ce", query: "ce", aliases: ["abc", "abab"], type: "customDictionary", fuzzy: false }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${true}             | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${false}            | ${false} | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
  ${{ value: "abcde", type: "customDictionary" }}                        | ${""}   | ${false}            | ${0}     | ${{ value: "abcde", word: { value: "abcde", hit: "abcde", type: "customDictionary" }, alias: false }}
`(
  "judgeByPartialMatch",
  ({ word, query, queryStartWithUpper, fuzzy, expected }) => {
    test(`judgeByPartialMatch(${JSON.stringify(
      word,
    )}, ${query}, ${queryStartWithUpper}, ${fuzzy}) = ${JSON.stringify(
      expected,
    )}`, () => {
      expect(
        judgeByPartialMatch(word, query, queryStartWithUpper, {
          fuzzy: fuzzy === false ? undefined : { minMatchScore: fuzzy },
        }),
      ).toStrictEqual(expected);
    });
  },
);

describe("suggestWords", () => {
  const createIndexedWords = (): IndexedWords => ({
    currentFile: {
      a: [
        { value: "ai", type: "currentFile", createdPath: "" },
        { value: "aiUEO", type: "currentFile", createdPath: "" },
        { value: "Arc", type: "currentFile", createdPath: "" },
      ],
    },
    currentVault: {},
    customDictionary: {
      a: [
        {
          value: "uwaa",
          aliases: ["aaa"],
          type: "customDictionary",
          createdPath: "",
        },
        { value: "aiUEO", type: "customDictionary", createdPath: "" },
      ],
      A: [{ value: "AWS", type: "customDictionary", createdPath: "" }],
      u: [
        {
          value: "uwaa",
          aliases: ["aaa"],
          type: "customDictionary",
          createdPath: "",
        },
        {
          value: "uaaaaaaaaaaaaa",
          type: "customDictionary",
          createdPath: "",
        },
      ],
      U: [
        {
          value: "UFO",
          aliases: ["Unidentified flying object"],

          createdPath: "",
          type: "customDictionary",
        },
      ],
    },
    internalLink: {
      a: [
        { value: "aiUEO", type: "internalLink", createdPath: "" },
        {
          value: "あいうえお",
          type: "internalLink",
          aliases: ["aiueo"],
          createdPath: "",
        },
      ],
      A: [
        { value: "AWS", type: "internalLink", createdPath: "" },
        { value: "AI", type: "internalLink", createdPath: "a/AI.md" },
        { value: "AI", type: "internalLink", createdPath: "b/AI.md" },
      ],
      あ: [
        {
          value: "あいうえお",
          type: "internalLink",
          aliases: ["aiueo"],
          createdPath: "",
        },
      ],
    },
    frontMatter: {}, // TODO: Add value
  });

  test("Query: a (excludeInternalLink)", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWords(indexedWords, "a", 10, {
      excludeInternalLink: true,
    });
    // No internalLink candidates are collected...
    expect(actual.every((x) => x.type !== "internalLink")).toBe(true);
    // ...but other providers still produce candidates.
    expect(actual.length).toBeGreaterThan(0);
  });

  test("Query: a", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "a", 10)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        type: "currentFile",
        hit: "ai",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "internalLink",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "customDictionary",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        aliases: ["aaa"],
        hit: "aaa",
        query: "a",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Arc",
        type: "currentFile",
        hit: "Arc",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "a",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: ai", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "ai", 10)).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        hit: "ai",
        query: "ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: aiu", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "aiu", 10)).toStrictEqual([
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "aiu",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "aiu",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "aiu",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: ua (fuzzy: true)", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "ua", 10, { fuzzy: { minMatchScore: 0 } }),
    ).toStrictEqual([
      {
        value: "uaaaaaaaaaaaaa",
        hit: "uaaaaaaaaaaaaa",
        query: "ua",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        aliases: ["aaa"],
        hit: "uwaa",
        query: "ua",
        type: "customDictionary",
        createdPath: "",
        fuzzy: true,
      },
    ]);
  });

  test("Query: ua (fuzzy: false)", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "ua", 10)).toStrictEqual([
      {
        value: "uaaaaaaaaaaaaa",
        hit: "uaaaaaaaaaaaaa",
        query: "ua",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: A", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "A", 10)).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "A",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "A",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        hit: "Ai",
        query: "A",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        hit: "AWS",
        query: "A",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        hit: "AWS",
        query: "A",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        type: "customDictionary",
        aliases: ["aaa"],
        hit: "aaa",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Arc",
        type: "currentFile",
        hit: "Arc",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "A",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "A",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        hit: "AiUEO",
        query: "A",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: Ai", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "Ai", 10)).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "Ai",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "Ai",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        hit: "Ai",
        query: "Ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "Ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        hit: "aiueo",
        query: "Ai",
        type: "internalLink",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        hit: "AiUEO",
        query: "Ai",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: AI", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "AI", 10)).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "AI",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "AI",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        hit: "Ai",
        query: "AI",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "AI",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        hit: "aiueo",
        query: "AI",
        type: "internalLink",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        hit: "AiUEO",
        query: "AI",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: AIU", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "AIU", 10)).toStrictEqual([
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "AIU",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        hit: "aiueo",
        query: "AIU",
        type: "internalLink",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        hit: "AiUEO",
        query: "AIU",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: u", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "u", 10)).toStrictEqual([
      {
        value: "UFO",
        hit: "UFO",
        query: "u",
        type: "customDictionary",
        aliases: ["Unidentified flying object"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        hit: "uwaa",
        query: "u",
        type: "customDictionary",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uaaaaaaaaaaaaa",
        hit: "uaaaaaaaaaaaaa",
        query: "u",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: U", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "U", 10)).toStrictEqual([
      {
        value: "UFO",
        hit: "UFO",
        query: "U",
        type: "customDictionary",
        aliases: ["Unidentified flying object"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Uwaa",
        hit: "Uwaa",
        query: "U",
        type: "customDictionary",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Uaaaaaaaaaaaaa",
        hit: "Uaaaaaaaaaaaaa",
        query: "U",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("max: 3", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWords(indexedWords, "a", 3)).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "a",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "a",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        hit: "ai",
        query: "a",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      // {
      //   value: "AWS",
      //   hit: "AWS",
      //   query: "a",
      //   type: "internalLink",
      //   createdPath: "",
      // },
      // --- hidden ---
      // { value: "uwaa", type: "customDictionary", aliases: ["aaa"] },
      // { value: "aiUEO", type: "internalLink" },
      // { value: "あいうえお", type: "internalLink", aliases: ["aiueo"] },
      // { value: "aiUEO", type: "customDictionary" },
      // { value: "aiUEO", type: "currentFile" },
    ]);
  });

  const indexedWords2: IndexedWords = {
    frontMatter: {
      tags: {
        a: [
          {
            key: "tags",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "tags",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
      alias: {
        a: [
          {
            key: "alias",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "alias",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
      aliases: {
        a: [
          {
            key: "aliases",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "aliases",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
    },
    internalLink: {
      a: [
        { value: "a", type: "internalLink", createdPath: "", fuzzy: false },
        { value: "a", type: "internalLink", createdPath: "", fuzzy: false },
      ],
    },
    customDictionary: {
      a: [
        { value: "a", type: "customDictionary", createdPath: "", fuzzy: false },
        { value: "a", type: "customDictionary", createdPath: "", fuzzy: false },
      ],
    },
    currentFile: {
      a: [
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
      ],
    },
    currentVault: {
      a: [
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
      ],
    },
  };

  test("word type priority order in front matter tags", () => {
    expect(
      suggestWords(indexedWords2, "a", 10, { frontMatter: "tags" }),
    ).toStrictEqual([
      {
        key: "tags",
        value: "a",
        hit: "a",
        query: "a",
        type: "frontMatter",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("word type priority order not in front matter", () => {
    expect(suggestWords(indexedWords2, "a", 10)).toStrictEqual([
      {
        value: "a",
        hit: "a",
        query: "a",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "a",
        hit: "a",
        query: "a",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("empty in front matter alias", () => {
    expect(
      suggestWords(indexedWords2, "a", 10, { frontMatter: "alias" }),
    ).toStrictEqual([]);
  });

  test("empty in front matter aliases", () => {
    expect(
      suggestWords(indexedWords2, "a", 10, { frontMatter: "aliases" }),
    ).toStrictEqual([]);
  });

  const indexedWords3: IndexedWords = {
    frontMatter: {},
    internalLink: {},
    customDictionary: {},
    currentFile: {
      a: [
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
      ],
    },
    currentVault: {
      a: [
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
      ],
    },
  };

  test("word type priority order (currentFile & currentVault)", () => {
    expect(suggestWords(indexedWords3, "a", 10)).toStrictEqual([
      {
        value: "a",
        hit: "a",
        query: "a",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: exclude currentFile when query is too short", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "a", 10, {
        providerMinChars: {
          currentFile: 2,
          currentVault: 0,
          customDictionary: 0,
          internalLink: 0,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "internalLink",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "customDictionary",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        aliases: ["aaa"],
        hit: "aaa",
        query: "a",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "a",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: include currentFile when query meets requirement", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "ai", 10, {
        providerMinChars: {
          currentFile: 2,
          currentVault: 0,
          customDictionary: 0,
          internalLink: 0,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        hit: "ai",
        query: "ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: exclude internalLink with 3 chars requirement", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "ai", 10, {
        providerMinChars: {
          currentFile: 0,
          currentVault: 0,
          customDictionary: 0,
          internalLink: 3,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "ai",
        hit: "ai",
        query: "ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: allow provider setting smaller than global setting", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "ai", 10, {
        providerMinChars: {
          currentFile: 2,
          currentVault: 5,
          customDictionary: 5,
          internalLink: 2,
        },
        globalMinChar: 3,
      }),
    ).toStrictEqual([
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        hit: "AI",
        query: "ai",
        type: "internalLink",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        hit: "ai",
        query: "ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        hit: "aiueo",
        query: "ai",
        type: "internalLink",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "ai",
        type: "currentFile",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: include internalLink when query meets 3 chars requirement", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWords(indexedWords, "aiu", 10, {
        providerMinChars: {
          currentFile: 0,
          currentVault: 0,
          customDictionary: 0,
          internalLink: 3,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "aiu",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        aliases: ["aiueo"],
        hit: "aiueo",
        query: "aiu",
        type: "internalLink",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        hit: "aiUEO",
        query: "aiu",
        type: "customDictionary",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });
});

describe("suggestWordsByPartialMatch", () => {
  const createIndexedWords = (): IndexedWords => ({
    currentFile: {
      a: [
        { value: "ai", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "aiUEO", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "Arc", type: "currentFile", createdPath: "", fuzzy: false },
      ],
    },
    currentVault: {},
    customDictionary: {
      a: [
        {
          value: "uwaa",
          aliases: ["aaa"],
          type: "customDictionary",
          createdPath: "",
          fuzzy: false,
        },
        {
          value: "aiUEO",
          type: "customDictionary",
          createdPath: "",
          fuzzy: false,
        },
      ],
      A: [
        {
          value: "AWS",
          type: "customDictionary",
          createdPath: "",
          fuzzy: false,
        },
      ],
      u: [
        {
          value: "uwaa",
          aliases: ["aaa"],
          type: "customDictionary",
          createdPath: "",
          fuzzy: false,
        },
      ],
      U: [
        {
          value: "UFO",
          aliases: ["Unidentified flying object"],
          createdPath: "",
          fuzzy: false,
          type: "customDictionary",
        },
      ],
    },
    internalLink: {
      a: [
        { value: "aiUEO", type: "internalLink", createdPath: "", fuzzy: false },
        {
          value: "あいうえお",
          type: "internalLink",
          aliases: ["aiueo"],
          createdPath: "",
          fuzzy: false,
        },
      ],
      A: [
        { value: "AWS", type: "internalLink", createdPath: "", fuzzy: false },
        {
          value: "AI",
          type: "internalLink",
          createdPath: "a/AI.md",
          fuzzy: false,
        },
        {
          value: "AI",
          type: "internalLink",
          createdPath: "b/AI.md",
          fuzzy: false,
        },
      ],
      あ: [
        {
          value: "あいうえお",
          type: "internalLink",
          aliases: ["aiueo"],
          createdPath: "",
          fuzzy: false,
        },
      ],
    },
    frontMatter: {}, // TODO: Add value
  });

  test("Query: a", () => {
    const indexedWords = createIndexedWords();
    // It is as specified that max doesn't match the expected length
    expect(suggestWordsByPartialMatch(indexedWords, "a", 12)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        type: "currentFile",
        hit: "ai",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "internalLink",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "customDictionary",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        type: "customDictionary",
        hit: "aaa",
        query: "a",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Arc",
        type: "currentFile",
        hit: "Arc",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "a",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      // ??? currentFile
    ]);
  });

  test("Query: ai", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "ai", 10)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "ai",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "ai",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        type: "currentFile",
        hit: "ai",
        query: "ai",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "ai",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "ai",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "ai",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: aiu", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "aiu", 10)).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "aiu",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "aiu",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "aiu",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: ueo (fuzzy: true)", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWordsByPartialMatch(indexedWords, "ueo", 10, {
        fuzzy: { minMatchScore: 0 },
      }),
    ).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "ueo",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "ueo",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "ueo",
        createdPath: "",
        fuzzy: false,
      },
      {
        aliases: ["Unidentified flying object"],
        createdPath: "",
        fuzzy: true,
        hit: "Unidentified flying object",
        query: "ueo",
        type: "customDictionary",
        value: "UFO",
      },
    ]);
  });

  test("Query: ueo (fuzzy: false)", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "ueo", 10)).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "ueo",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "ueo",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "ueo",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: A", () => {
    const indexedWords = createIndexedWords();
    // It is as specified that max doesn't match the expected length
    expect(suggestWordsByPartialMatch(indexedWords, "A", 12)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "A",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "A",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        type: "currentFile",
        hit: "Ai",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "internalLink",
        hit: "AWS",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "customDictionary",
        hit: "AWS",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        type: "customDictionary",
        hit: "aaa",
        query: "A",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Arc",
        type: "currentFile",
        hit: "Arc",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "A",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        type: "customDictionary",
        hit: "AiUEO",
        query: "A",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: Ai", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "Ai", 10)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "Ai",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "Ai",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        type: "currentFile",
        hit: "Ai",
        query: "Ai",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "Ai",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "Ai",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        type: "customDictionary",
        hit: "AiUEO",
        query: "Ai",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: AI", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "AI", 10)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "AI",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "AI",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "Ai",
        type: "currentFile",
        hit: "Ai",
        query: "AI",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "AI",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "AI",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        type: "customDictionary",
        hit: "AiUEO",
        query: "AI",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: AIU", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "AIU", 10)).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "AIU",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "AIU",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AiUEO",
        type: "customDictionary",
        hit: "AiUEO",
        query: "AIU",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: u", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "u", 10)).toStrictEqual([
      {
        value: "UFO",
        type: "customDictionary",
        hit: "UFO",
        query: "u",
        aliases: ["Unidentified flying object"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "uwaa",
        type: "customDictionary",
        hit: "uwaa",
        query: "u",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "u",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "u",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "u",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("Query: U", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "U", 10)).toStrictEqual([
      {
        value: "UFO",
        type: "customDictionary",
        hit: "UFO",
        query: "U",
        aliases: ["Unidentified flying object"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Uwaa",
        type: "customDictionary",
        hit: "Uwaa",
        query: "U",
        aliases: ["aaa"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "U",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "U",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "U",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("max: 3", () => {
    const indexedWords = createIndexedWords();
    expect(suggestWordsByPartialMatch(indexedWords, "a", 3)).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        type: "currentFile",
        hit: "ai",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      // { value: "AWS", type: "internalLink", hit: "AWS", createdPath: "", },
    ]);
  });

  const indexedWords2: IndexedWords = {
    frontMatter: {
      tags: {
        a: [
          {
            key: "tags",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "tags",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
      alias: {
        a: [
          {
            key: "alias",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "alias",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
      aliases: {
        a: [
          {
            key: "aliases",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
          {
            key: "aliases",
            value: "a",
            type: "frontMatter",
            createdPath: "",
            fuzzy: false,
          },
        ],
      },
    },
    internalLink: {
      a: [
        { value: "a", type: "internalLink", createdPath: "", fuzzy: false },
        { value: "a", type: "internalLink", createdPath: "", fuzzy: false },
      ],
    },
    customDictionary: {
      a: [
        { value: "a", type: "customDictionary", createdPath: "", fuzzy: false },
        { value: "a", type: "customDictionary", createdPath: "", fuzzy: false },
      ],
    },
    currentFile: {
      a: [
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
      ],
    },
    currentVault: {
      a: [
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
      ],
    },
  };

  test("word type priority order in front matter tags", () => {
    expect(
      suggestWordsByPartialMatch(indexedWords2, "a", 10, {
        frontMatter: "tags",
      }),
    ).toStrictEqual([
      {
        key: "tags",
        value: "a",
        type: "frontMatter",
        hit: "a",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("word type priority order not in front matter", () => {
    expect(suggestWordsByPartialMatch(indexedWords2, "a", 10)).toStrictEqual([
      {
        value: "a",
        type: "internalLink",
        hit: "a",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "a",
        type: "customDictionary",
        hit: "a",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("empty in front matter alias", () => {
    expect(
      suggestWordsByPartialMatch(indexedWords2, "a", 10, {
        frontMatter: "alias",
      }),
    ).toStrictEqual([]);
  });

  test("empty in front matter aliases", () => {
    expect(
      suggestWordsByPartialMatch(indexedWords2, "a", 10, {
        frontMatter: "alias",
      }),
    ).toStrictEqual([]);
  });

  const indexedWords3: IndexedWords = {
    frontMatter: {},
    internalLink: {},
    customDictionary: {},
    currentFile: {
      a: [
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
        { value: "a", type: "currentFile", createdPath: "", fuzzy: false },
      ],
    },
    currentVault: {
      a: [
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
        { value: "a", type: "currentVault", createdPath: "", fuzzy: false },
      ],
    },
  };

  test("word type priority order (currentFile & currentVault)", () => {
    expect(suggestWordsByPartialMatch(indexedWords3, "a", 10)).toStrictEqual([
      {
        value: "a",
        type: "currentFile",
        hit: "a",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: exclude customDictionary when query is too short", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWordsByPartialMatch(indexedWords, "a", 10, {
        providerMinChars: {
          currentFile: 0,
          currentVault: 0,
          customDictionary: 5,
          internalLink: 0,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "a/AI.md",
        fuzzy: false,
      },
      {
        value: "AI",
        type: "internalLink",
        hit: "AI",
        query: "a",
        createdPath: "b/AI.md",
        fuzzy: false,
      },
      {
        value: "ai",
        type: "currentFile",
        hit: "ai",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "AWS",
        type: "internalLink",
        hit: "AWS",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "Arc",
        type: "currentFile",
        hit: "Arc",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "a",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "currentFile",
        hit: "aiUEO",
        query: "a",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: exclude customDictionary with 4 chars query", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWordsByPartialMatch(indexedWords, "aiue", 10, {
        providerMinChars: {
          currentFile: 0,
          currentVault: 0,
          customDictionary: 5,
          internalLink: 0,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "aiue",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "aiue",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "currentFile",
        hit: "aiUEO",
        query: "aiue",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });

  test("provider-specific min chars: include customDictionary with 5 chars query", () => {
    const indexedWords = createIndexedWords();
    expect(
      suggestWordsByPartialMatch(indexedWords, "aiueo", 10, {
        providerMinChars: {
          currentFile: 0,
          currentVault: 0,
          customDictionary: 5,
          internalLink: 0,
        },
        globalMinChar: 0,
      }),
    ).toStrictEqual([
      {
        value: "aiUEO",
        type: "internalLink",
        hit: "aiUEO",
        query: "aiueo",
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "あいうえお",
        type: "internalLink",
        hit: "aiueo",
        query: "aiueo",
        aliases: ["aiueo"],
        createdPath: "",
        fuzzy: false,
      },
      {
        value: "aiUEO",
        type: "customDictionary",
        hit: "aiUEO",
        query: "aiueo",
        createdPath: "",
        fuzzy: false,
      },
    ]);
  });
});

describe("folder priority ranking", () => {
  const currentFilePath = "Novel/A/Chapter 1.md";
  const limitingFolder = "Novel";

  function createRankData(
    currentFileTargets: [string, number][],
    targetToSourceFolders: [string, [string, number][]][],
    unresolvedNames: [string, number][] = [],
  ): LinkRankData {
    return {
      builtForFilePath: currentFilePath,
      builtForLimitingFolder: limitingFolder,
      currentFileTargets: new Map(currentFileTargets),
      currentFileUnresolvedNames: new Map(unresolvedNames),
      targetToSourceFolders: new Map(
        targetToSourceFolders.map(([target, folders]) => [
          target,
          new Map(folders),
        ]),
      ),
      unresolvedNameToSourceFolders: new Map(),
    };
  }

  const createIndexedWords = (): IndexedWords => ({
    currentFile: {},
    currentVault: {},
    customDictionary: {},
    internalLink: {
      j: [
        {
          value: "Johnny",
          type: "internalLink",
          createdPath: "Novel/A/Johnny.md",
        },
        {
          value: "Job",
          type: "internalLink",
          createdPath: "Novel/B/Job.md",
        },
        {
          value: "John",
          type: "internalLink",
          createdPath: "Characters/John.md",
        },
      ],
    },
    frontMatter: {},
  });

  test("prefix mode: file-tier word beats a shorter non-tier word", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWords(indexedWords, "j", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [["Novel/A/Johnny.md", 1]],
          [["Novel/A/Johnny.md", [["Novel/A", 1]]]],
        ),
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["Johnny", "Job", "John"]);
  });

  test("partial mode: file-tier word with longer value beats a startsWith-prefix non-tier word", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [["Novel/A/Johnny.md", 1]],
          [["Novel/A/Johnny.md", [["Novel/A", 1]]]],
        ),
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["Johnny", "Job", "John"]);
  });

  test("same-folder link beats link whose only source folders are outside the limiting folder", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [],
          [
            ["Novel/A/Johnny.md", [["Novel/A", 1]]],
            ["Novel/B/Job.md", [["Resources/Other", 1]]],
          ],
        ),
        folderRankCache: {
          getList: () => ({
            folder: "Novel/A",
            builtForLimitingFolder: limitingFolder,
            globalVersion: 1,
            resolvedScores: new Map([
              ["Novel/A/Johnny.md", { level: 0, frequency: 1, score: 1 }],
            ]),
            unresolvedScores: new Map(),
          }),
        },
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["Johnny", "Job", "John"]);
  });

  test("resolved link with folder proximity beats phantom without proximity", () => {
    const indexedWords: IndexedWords = {
      currentFile: {},
      currentVault: {},
      customDictionary: {},
      internalLink: {
        j: [
          {
            value: "John",
            type: "internalLink",
            createdPath: "Characters/John.md",
            phantom: true,
          },
          {
            value: "Johnny",
            type: "internalLink",
            createdPath: "Novel/A/Johnny.md",
          },
        ],
      },
      frontMatter: {},
    };

    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [],
          [
            ["Characters/John.md", [["Novel/A", 1]]],
            ["Novel/A/Johnny.md", [["Novel/A", 1]]],
          ],
        ),
        folderRankCache: {
          getList: () => ({
            folder: "Novel/A",
            builtForLimitingFolder: limitingFolder,
            globalVersion: 1,
            resolvedScores: new Map([
              ["Novel/A/Johnny.md", { level: 0, frequency: 1, score: 1 }],
            ]),
            unresolvedScores: new Map(),
          }),
        },
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["Johnny", "John"]);
  });

  test("selection history decides when link tiers tie", () => {
    const indexedWords = createIndexedWords();
    const history = new SelectionHistoryStorage(
      {
        Job: {
          Job: {
            internalLink: { count: 5, lastUpdated: Date.now() },
          },
        },
      },
      30,
      1000,
    );

    const actual = suggestWords(indexedWords, "j", 10, {
      selectionHistoryStorage: history,
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData([], []),
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["Job", "John", "Johnny"]);
  });

  test("non-internalLink pair skips tier block", () => {
    const indexedWords: IndexedWords = {
      currentFile: {
        j: [
          { value: "jogging", type: "currentFile", createdPath: "" },
          { value: "joke", type: "currentFile", createdPath: "" },
        ],
      },
      currentVault: {},
      customDictionary: {},
      internalLink: {},
      frontMatter: {},
    };

    const withPriority = suggestWords(indexedWords, "j", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData([], []),
      },
    });
    const withoutPriority = suggestWords(indexedWords, "j", 10);

    expect(withPriority.map((x) => x.value)).toStrictEqual(
      withoutPriority.map((x) => x.value),
    );
  });

  test("word-as-alias mode: basename and alias for the same target share tier", () => {
    const indexedWords: IndexedWords = {
      currentFile: {},
      currentVault: {},
      customDictionary: {},
      internalLink: {
        j: [
          {
            value: "John",
            type: "internalLink",
            createdPath: "Characters/John.md",
          },
          {
            value: "Johnny",
            type: "internalLink",
            createdPath: "Characters/John.md",
            aliasMeta: { origin: "Characters/John.md" },
          },
          {
            value: "Job",
            type: "internalLink",
            createdPath: "Novel/B/Job.md",
          },
        ],
      },
      frontMatter: {},
    };

    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      folderPriority: {
        enabled: true,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [["Characters/John.md", 1]],
          [
            ["Characters/John.md", [["Novel/A", 1]]],
            ["Novel/B/Job.md", [["Novel/B", 1]]],
          ],
        ),
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual(["John", "Johnny", "Job"]);
  });

  test("enabled=false behaves like no folderPriority option", () => {
    const indexedWords = createIndexedWords();
    const withDisabled = suggestWords(indexedWords, "j", 10, {
      folderPriority: {
        enabled: false,
        currentFilePath,
        limitingFolder,
        rankData: createRankData(
          [["Novel/A/Johnny.md", 1]],
          [["Novel/A/Johnny.md", [["Novel/A", 1]]]],
        ),
      },
    });
    const withoutOption = suggestWords(indexedWords, "j", 10);

    expect(withDisabled.map((x) => x.value)).toStrictEqual(
      withoutOption.map((x) => x.value),
    );
  });
});

describe("alias priority", () => {
  // Use same-length basename and alias so that length does not hide the
  // same-target alias-priority tie-breaker.
  const createIndexedWords = (): IndexedWords => ({
    currentFile: {},
    currentVault: {},
    customDictionary: {},
    internalLink: {
      j: [
        {
          value: "John",
          type: "internalLink",
          createdPath: "Characters/John.md",
        },
        {
          value: "Jony",
          type: "internalLink",
          createdPath: "Characters/John.md",
          aliasMeta: { origin: "Characters/John.md" },
        },
      ],
    },
    frontMatter: {},
  });

  test("prefix: prioritizeAliases true puts same-target alias before basename", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWords(indexedWords, "j", 10, {
      prioritizeAliases: true,
    });
    expect(actual.map((x) => x.value)).toStrictEqual(["Jony", "John"]);
  });

  test("prefix: prioritizeAliases false keeps old alias tie-break", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWords(indexedWords, "j", 10, {
      prioritizeAliases: false,
    });
    expect(actual.map((x) => x.value)).toStrictEqual(["John", "Jony"]);
  });

  test("prefix: absent prioritizeAliases keeps old alias tie-break", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWords(indexedWords, "j", 10);
    expect(actual.map((x) => x.value)).toStrictEqual(["John", "Jony"]);
  });

  test("partial: prioritizeAliases true puts same-target alias before basename", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      prioritizeAliases: true,
    });
    expect(actual.map((x) => x.value)).toStrictEqual(["Jony", "John"]);
  });

  test("partial: prioritizeAliases false keeps old alias tie-break", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10, {
      prioritizeAliases: false,
    });
    expect(actual.map((x) => x.value)).toStrictEqual(["John", "Jony"]);
  });

  test("partial: absent prioritizeAliases keeps old alias tie-break", () => {
    const indexedWords = createIndexedWords();
    const actual = suggestWordsByPartialMatch(indexedWords, "jo", 10);
    expect(actual.map((x) => x.value)).toStrictEqual(["John", "Jony"]);
  });

  test("prefix: different-target pairs are unaffected by the new alias-priority stage", () => {
    const indexedWords: IndexedWords = {
      currentFile: {},
      currentVault: {},
      customDictionary: {},
      internalLink: {
        j: [
          {
            value: "Jane",
            type: "internalLink",
            createdPath: "Characters/Jane.md",
            aliasMeta: { origin: "Characters/Jane.md" },
          },
          {
            value: "J",
            type: "internalLink",
            createdPath: "Characters/J.md",
          },
        ],
      },
      frontMatter: {},
    };
    const withTrue = suggestWords(indexedWords, "j", 10, {
      prioritizeAliases: true,
    });
    const withFalse = suggestWords(indexedWords, "j", 10, {
      prioritizeAliases: false,
    });
    expect(withTrue.map((x) => x.value)).toStrictEqual(
      withFalse.map((x) => x.value),
    );
  });

  test("folder priority still dominates alias priority when both are enabled", () => {
    const indexedWords: IndexedWords = {
      currentFile: {},
      currentVault: {},
      customDictionary: {},
      internalLink: {
        j: [
          {
            value: "Jobb",
            type: "internalLink",
            createdPath: "Novel/B/Jobb.md",
          },
          {
            value: "JobA",
            type: "internalLink",
            createdPath: "Novel/B/Jobb.md",
            aliasMeta: { origin: "Novel/B/Jobb.md" },
          },
          {
            value: "John",
            type: "internalLink",
            createdPath: "Characters/John.md",
          },
          {
            value: "Jony",
            type: "internalLink",
            createdPath: "Characters/John.md",
            aliasMeta: { origin: "Characters/John.md" },
          },
        ],
      },
      frontMatter: {},
    };

    const data: LinkRankData = {
      builtForFilePath: "Novel/A/Chapter 1.md",
      builtForLimitingFolder: "Novel",
      currentFileTargets: new Map(),
      currentFileUnresolvedNames: new Map(),
      targetToSourceFolders: new Map([
        ["Characters/John.md", new Map([["Novel/A", 1]])],
        ["Novel/B/Jobb.md", new Map([["Novel/B", 1]])],
      ]),
      unresolvedNameToSourceFolders: new Map(),
    };

    const actual = suggestWords(indexedWords, "j", 10, {
      prioritizeAliases: true,
      folderPriority: {
        enabled: true,
        currentFilePath: "Novel/A/Chapter 1.md",
        limitingFolder: "Novel",
        rankData: data,
        folderRankCache: {
          getList: () => ({
            folder: "Novel/A",
            builtForLimitingFolder: "Novel",
            globalVersion: 1,
            resolvedScores: new Map([
              ["Characters/John.md", { level: 0, frequency: 1, score: 1 }],
              ["Novel/B/Jobb.md", { level: 1, frequency: 1, score: 1 }],
            ]),
            unresolvedScores: new Map(),
          }),
        },
      },
    });

    expect(actual.map((x) => x.value)).toStrictEqual([
      "Jony",
      "John",
      "JobA",
      "Jobb",
    ]);
  });
});

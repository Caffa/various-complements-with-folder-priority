import { describe, expect, test } from "@jest/globals";
import { isPureShortening } from "./suggestion-memory";

describe("isPureShortening", () => {
  test.each<{
    prev: string;
    cur: string;
    expected: boolean;
    description: string;
  }>`
    prev      | cur       | expected | description
    ${""}     | ${""}     | ${false} | ${"both empty"}
    ${""}     | ${"a"}    | ${false} | ${"prev empty"}
    ${"a"}    | ${""}     | ${false} | ${"cur empty"}
    ${"abc"}  | ${"abc"}  | ${false} | ${"equal strings"}
    ${"abc"}  | ${"abcd"} | ${false} | ${"extension"}
    ${"abcd"} | ${"abc"}  | ${true}  | ${"prefix shortening"}
    ${"abcd"} | ${"abx"}  | ${false} | ${"non-prefix change"}
    ${"abcd"} | ${"ab"}   | ${true}  | ${"shorter prefix"}
  `(
    "$description: isPureShortening($prev, $cur) = $expected",
    ({ prev, cur, expected }) => {
      expect(isPureShortening(prev, cur)).toBe(expected);
    },
  );
});

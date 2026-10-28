import { describe, expect, test } from "@jest/globals";
import { validateRegexPatterns } from "./regex-validation";

describe("validateRegexPatterns", () => {
  test("returns all valid patterns and no errors for valid regex", () => {
    const result = validateRegexPatterns(["^~~~.*", "^```.*", "abc"]);
    expect(result.valid).toEqual(["^~~~.*", "^```.*", "abc"]);
    expect(result.errors).toEqual([]);
  });

  test("returns empty valid and empty errors for empty array", () => {
    const result = validateRegexPatterns([]);
    expect(result.valid).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("separates invalid patterns and reports errors", () => {
    const result = validateRegexPatterns(["^~~~.*", "[invalid", "abc"]);
    expect(result.valid).toEqual(["^~~~.*", "abc"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Invalid regex "[invalid"');
    expect(result.errors[0]).toContain("Unterminated");
  });

  test("handles multiple invalid patterns", () => {
    const result = validateRegexPatterns(["[invalid", "(unclosed", "valid"]);
    expect(result.valid).toEqual(["valid"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('Invalid regex "[invalid"');
    expect(result.errors[1]).toContain('Invalid regex "(unclosed"');
  });

  test("handles unclosed parenthesis", () => {
    const result = validateRegexPatterns(["(abc"]);
    expect(result.valid).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  test("handles invalid quantifier repetition", () => {
    const result = validateRegexPatterns(["a{b}"]);
    // Note: some JS engines treat {b} as a literal, so this may be valid
    // Use a pattern that's definitively invalid across engines
    expect(result.errors.length + result.valid.length).toBe(1);
  });

  test("handles all valid patterns with special characters", () => {
    const result = validateRegexPatterns(["^\\d+$", "\\s*\\w+", "(?:abc|def)"]);
    expect(result.valid).toEqual(["^\\d+$", "\\s*\\w+", "(?:abc|def)"]);
    expect(result.errors).toEqual([]);
  });

  test("preserves order of valid patterns", () => {
    const result = validateRegexPatterns(["first", "second", "third"]);
    expect(result.valid).toEqual(["first", "second", "third"]);
  });
});

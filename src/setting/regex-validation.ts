/**
 * Regex pattern validation utilities.
 *
 * Provides helpers for validating user-supplied regex patterns
 * before they are stored in plugin settings.
 */

/**
 * Validates an array of regex pattern strings, separating valid patterns
 * from invalid ones. Returns the valid patterns and error messages for
 * any patterns that fail RegExp construction.
 */
export function validateRegexPatterns(patterns: string[]): {
  valid: string[];
  errors: string[];
} {
  const valid: string[] = [];
  const errors: string[] = [];

  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
      valid.push(pattern);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`Invalid regex "${pattern}": ${message}`);
    }
  }

  return { valid, errors };
}
import type { ModelInfo } from "../api";

/**
 * Normalize a string for fuzzy matching:
 * - Lowercase
 * - Remove separator characters (hyphen, underscore, dot, slash)
 *
 * Preserves spaces (which serve as field/word boundaries) and alphanumeric chars.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_./]/g, "");
}

/**
 * Check if `needle` is a subsequence of `haystack` — every character of
 * `needle` appears in `haystack` in the same order, but not necessarily
 * contiguously.
 *
 * Both inputs should be pre-normalized.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (needle[ni] === haystack[hi]) ni++;
  }
  return ni === needle.length;
}

/**
 * Check whether `needle` has edit distance ≤ `maxDist` to any contiguous
 * substring of `haystack`, using a DP-based fuzzy-substring algorithm with
 * Damerau-Levenshtein support (insertion, deletion, substitution, and
 * adjacent transposition).
 *
 * The first DP row is initialised to zero so matching can begin at any
 * position in `haystack` without penalty.
 */
function fuzzySubstring(needle: string, haystack: string, maxDist: number): boolean {
  const n = needle.length;
  const m = haystack.length;

  if (n === 0) return true;
  if (m === 0) return false;

  // Two-rows-back buffer (needed for the transposition case)
  let prev2 = new Array<number>(m + 1).fill(0);
  // Previous DP row — initialised to 0 (free start position)
  let prev = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    const curr = new Array<number>(m + 1);
    curr[0] = i;

    for (let j = 1; j <= m; j++) {
      const cost = needle[i - 1] === haystack[j - 1] ? 0 : 1;

      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );

      // Adjacent transposition (Damerau-Levenshtein)
      if (
        i >= 2 &&
        j >= 2 &&
        needle[i - 1] === haystack[j - 2] &&
        needle[i - 2] === haystack[j - 1]
      ) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + 1);
      }
    }

    prev2 = prev;
    prev = curr;
  }

  // If any ending position has distance ≤ maxDist the needle fuzzy-matches
  for (let j = 0; j <= m; j++) {
    if (prev[j] <= maxDist) return true;
  }
  return false;
}

/**
 * Check if a single search term matches the combined provider/id/name text,
 * using these deterministic rules (any one is sufficient):
 *
 *  1. **Normalized substring** — separator-stripped, case-insensitive
 *     substring match against the full haystack (preserves original behaviour).
 *  2. **Normalized subsequence** — characters appear in order within a single
 *     token (space-separated word) but need not be contiguous
 *     (e.g. `"cld"` → `"claude"`).  Requires ≥ 3 chars to avoid short-query
 *     false positives.
 *  3. **Typo tolerance** — Damerau-Levenshtein edit distance ≤ 1 to any
 *     substring of a single token, supporting single-char insertion, deletion,
 *     substitution, and adjacent transposition (e.g. `"sonet"` → `"sonnet"`).
 *     Requires ≥ 4 chars.
 *
 * Separators (hyphen, underscore, dot, slash) are stripped from *both*
 * the term and the haystack before matching so that `"gpt4o"` matches
 * `"gpt-4o"`.
 *
 * Subsequence and typo checks are scoped to individual tokens (space-split
 * parts of the haystack) to prevent cross-field false positives.
 */
function termMatches(term: string, haystack: string): boolean {
  const normTerm = normalize(term);
  const normHaystack = normalize(haystack);

  if (normTerm.length === 0) return true;

  // 1. Substring match against full normalized haystack (any length)
  if (normHaystack.includes(normTerm)) return true;

  // For subsequence and fuzzy matching, check against individual tokens
  // to avoid false positives from cross-field character picking.
  const tokens = normHaystack.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    // 2. Subsequence match (min 3 chars to avoid short-query false positives)
    if (normTerm.length >= 3 && isSubsequence(normTerm, token)) return true;

    // 3. Typo-tolerant fuzzy match (min 4 chars)
    if (normTerm.length >= 4 && fuzzySubstring(normTerm, token, 1)) return true;
  }

  return false;
}

/**
 * Filter models by search terms matching provider, id, or name.
 *
 * Supports multi-word filters with space-separated **AND** logic — every
 * term must match independently.  Matching is fuzzy: separator-insensitive,
 * typo-tolerant (edit distance ≤ 1), and subsequence-aware, while still
 * producing the same results as the old substring matcher for exact and
 * substring queries.
 *
 * Result ordering is **stable** — models are returned in input-array order
 * with no fuzzy-score re-sorting.
 */
export function filterModels(models: ModelInfo[], filter: string): ModelInfo[] {
  const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${m.provider} ${m.id} ${m.name}`;
    return terms.every((term) => termMatches(term, haystack));
  });
}

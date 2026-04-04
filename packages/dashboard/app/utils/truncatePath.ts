/**
 * Truncates a file path from the middle, preserving the end (filename).
 *
 * Example:
 *   Input:  "packages/dashboard/app/components/TaskChangesTab.tsx" (52 chars)
 *   With maxLength=40: "packages/.../components/TaskChangesTab.tsx"
 *   With maxLength=30: ".../TaskChangesTab.tsx"
 *
 * The function always tries to preserve the filename (after the last separator).
 * Truncation snaps to path segment boundaries for clean output.
 */
export function truncateMiddle(path: string, maxLength: number = 60): string {
  if (!path || path.length <= maxLength) return path;

  // Minimum meaningful truncation: "..." plus at least 1 char on each side
  if (maxLength < 4) return path.slice(0, maxLength);

  const ellipsis = "...";

  const lastSep = path.lastIndexOf("/");
  if (lastSep === -1) {
    // No separator — keep the beginning, truncate the end
    const headLen = Math.max(1, maxLength - ellipsis.length);
    return path.slice(0, headLen) + ellipsis;
  }

  // Find all separator positions to use as candidate split points
  const seps: number[] = [];
  for (let i = 1; i < path.length; i++) {
    if (path[i] === "/") seps.push(i);
  }

  const budget = maxLength - ellipsis.length;

  // Try all combinations of prefix-cut (before "...") and suffix-start (after "...")
  // We want prefix + "..." + suffix where both align on separators
  // Iterate suffix start positions from the end (preferring to keep the filename)
  let bestResult: string | null = null;
  let bestScore = -1; // prefer results with more chars preserved

  for (let si = seps.length - 1; si >= 0; si--) {
    const suffixStart = seps[si]; // position of "/" starting the suffix
    const suffix = path.slice(suffixStart); // includes leading "/"

    if (suffix.length > budget) continue; // suffix alone doesn't fit

    const remainingForPrefix = budget - suffix.length;

    // Find the longest prefix that fits
    for (let pi = 0; pi < seps.length; pi++) {
      const prefixEnd = seps[pi]; // prefix goes up to (not including) this "/"
      const prefix = path.slice(0, prefixEnd);

      if (prefix.length <= remainingForPrefix) {
        const totalLen = prefix.length + ellipsis.length + suffix.length;
        if (totalLen <= maxLength && prefix.length + suffix.length > bestScore) {
          bestScore = prefix.length + suffix.length;
          bestResult = prefix + ellipsis + suffix;
        }
      }
    }
  }

  if (bestResult) return bestResult;

  // Fallback: just ellipsis + the filename portion (with leading "/")
  const suffixWithSlash = path.slice(lastSep);
  if (ellipsis.length + suffixWithSlash.length <= maxLength) {
    return ellipsis + suffixWithSlash;
  }

  // Filename itself is too long — truncate from the end
  const endLen = maxLength - ellipsis.length;
  return ellipsis + path.slice(path.length - endLen);
}

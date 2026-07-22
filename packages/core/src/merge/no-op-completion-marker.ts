export type NoOpCompletionMarkerKind = "premise-stale" | "no-op" | "duplicate" | "redundant";

export interface NoOpCompletionMarker {
  kind: NoOpCompletionMarkerKind;
  reason: string;
  canonicalId?: string;
}

const PREFIXES: Array<{ pattern: RegExp; kind: NoOpCompletionMarkerKind }> = [
  { pattern: /^PREMISE STALE:\s*/i, kind: "premise-stale" },
  { pattern: /^NO-OP:\s*/i, kind: "no-op" },
  { pattern: /^NOOP:\s*/i, kind: "no-op" },
  { pattern: /^DUPLICATE:\s*/i, kind: "duplicate" },
  { pattern: /^REDUNDANT:\s*/i, kind: "redundant" },
];

/**
 * Detects explicit executor completion summaries that mean the task was
 * verified as already satisfied on HEAD (no source commit is appropriate).
 *
 * The marker must be a leading, case-insensitive prefix. Mid-summary mentions
 * intentionally do not match so ordinary prose cannot accidentally bypass the
 * no-commits invariant.
 */
export function parseNoOpCompletionMarker(summary: string | undefined): NoOpCompletionMarker | null {
  const trimmed = summary?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  for (const { pattern, kind } of PREFIXES) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    const reason = trimmed.slice(match[0].length).trim();
    const idMatch = kind === "duplicate" || kind === "redundant"
      ? reason.match(/\b(FN-\d+)\b/i)
      : null;

    return {
      kind,
      reason,
      ...(idMatch ? { canonicalId: idMatch[1].toUpperCase() } : {}),
    };
  }

  return null;
}

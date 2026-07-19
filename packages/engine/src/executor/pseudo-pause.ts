/**
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Pseudo-pause and review-handoff detectors peeled from executor.ts.
 */

/**
 * Result of a pseudo-pause detection check.
 */
export interface PseudoPauseResult {
  /** Detection method: "regex" if a regex pattern matched, "structural" for structural
   * heuristics, or "none" if no pseudo-pause was detected. */
  kind: "regex" | "structural" | "none";
  /** The matched text or pattern description when kind is not "none". */
  matched?: string;
}

/**
 * Detect whether the last assistant text output looks like a "pseudo-pause" —
 * where the agent ended a turn by asking for permission or summarizing progress
 * instead of calling a tool.
 *
 * Returns a {@link PseudoPauseResult} describing the detection kind and the
 * matched text/pattern. Returns `{ kind: "none" }` when no pseudo-pause is found.
 *
 * @param lastText - The last assistant text output from the session.
 */
export function detectPseudoPause(lastText: string): PseudoPauseResult {
  if (!lastText || lastText.trim().length === 0) {
    return { kind: "none" };
  }

  const regexPatterns: RegExp[] = [
    /\bif you (?:want|wish|need|like|prefer|'?d like)\b/i,
    /\bshould I (?:continue|proceed|go ahead|move on|start|begin)\b/i,
    /\blet me know\b/i,
    /\b(?:want|would you like) me to (?:continue|proceed|finish|complete|do)\b/i,
    /\bready to (?:proceed|continue|move on|begin)\b/i,
    /\bshall I\b/i,
    /\b(?:awaiting|waiting for) (?:your )?(?:approval|confirmation|go-ahead|response)\b/i,
  ];

  for (const pattern of regexPatterns) {
    const match = pattern.exec(lastText);
    if (match) {
      // Capture surrounding context (up to 120 chars around the match)
      const start = Math.max(0, match.index - 40);
      const end = Math.min(lastText.length, match.index + match[0].length + 80);
      const snippet = lastText.slice(start, end).replace(/\n+/g, " ").trim();
      return { kind: "regex", matched: snippet };
    }
  }

  // Structural fallback: long output that ends with a question or a markdown "next steps" heading
  const trimmed = lastText.trimEnd();
  if (trimmed.length > 200) {
    if (trimmed.endsWith("?")) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
    const nextStepsPattern = /(?:^|\n)#+\s*(?:notes?|next steps?|summary|what'?s? next)\s*:?\s*$/i;
    if (nextStepsPattern.test(trimmed)) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
    // Also catch plain "Next steps:" or "### Next steps" at the very end
    if (/next steps?\s*:?\s*$/i.test(trimmed)) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
  }

  return { kind: "none" };
}

/**
 * Detect if a steering comment contains a review handoff request.
 * Matches common handoff phrases that agents can use to request
 * human review of their work.
 */
export function detectReviewHandoffIntent(commentText: string): boolean {
  const text = commentText.toLowerCase();
  const handoffPhrases = [
    "send it back to me",
    "hand off to user",
    "needs human review",
    "assign to user",
    "return to user",
    "user review needed",
    "requesting user review",
  ];

  return handoffPhrases.some((phrase) => text.includes(phrase));
}

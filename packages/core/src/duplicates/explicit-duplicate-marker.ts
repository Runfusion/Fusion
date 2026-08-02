export interface ExplicitDuplicateMarker {
  canonicalId: string;
}

function stripCodeFenceLayer(content: string): string {
  const fenceMatch = content.match(/^```(?:[\t ]*(?:text|markdown))?[\t ]*\n([\s\S]*?)\n```$/i);
  if (!fenceMatch) {
    return content;
  }
  return fenceMatch[1] ?? "";
}

function stripSingleWrapper(line: string): string {
  if (line.startsWith("`") && line.endsWith("`") && line.length >= 2) {
    return line.slice(1, -1).trim();
  }
  if (line.startsWith("**") && line.endsWith("**") && line.length >= 4) {
    return line.slice(2, -2).trim();
  }
  return line;
}

/**
 * Detects the canonical triage "redirect" marker emitted by the planning
 * agent when the new task duplicates an existing one.
 */
export function parseExplicitDuplicateMarker(content: string): ExplicitDuplicateMarker | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const withoutFence = stripCodeFenceLayer(trimmed).trim();
  const nonBlankLines = withoutFence
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonBlankLines.length !== 1) {
    return null;
  }

  const candidate = stripSingleWrapper(nonBlankLines[0] ?? "");
  const match = candidate.match(/^DUPLICATE:\s*(FN-\d+)\s*$/i);
  if (!match) {
    return null;
  }

  return {
    canonicalId: match[1].toUpperCase(),
  };
}

/*
FNXC:DuplicateIntake 2026-08-01-19:24:
A PROMPT.md whose entire body is `DUPLICATE: FN-####` is a triage redirect verdict, not an
executable plan. FN-8704 was admitted into WIP because filesystem validation only required
non-empty content; the graph then failed at the `parse` node and parked failed in-progress in a
loop. Shared predicate so dispatch, hold-release, awaiting-planning badges, and graph-failure
recovery all reject this shape the same way.
*/
/** True when content is solely an explicit triage duplicate redirect (not a real plan body). */
export function isDuplicateRedirectOnlyPrompt(content: string): boolean {
  return parseExplicitDuplicateMarker(content) !== null;
}

/**
 * Operator-facing reason for rejecting a non-executable PROMPT at dispatch, or null when content
 * is not a duplicate-only redirect.
 */
export function nonExecutableDuplicateRedirectReason(content: string): string | null {
  const marker = parseExplicitDuplicateMarker(content);
  if (!marker) return null;
  return `PROMPT.md is a duplicate redirect marker (DUPLICATE: ${marker.canonicalId}), not an executable plan`;
}

/*
FNXC:DuplicateIntake 2026-07-26-10:40:
Recovery parser for a duplicate verdict the planner announced in its REPLY instead of writing it to
PROMPT.md. Observed on FN-8600 (2026-07-26): the planner correctly identified the duplicate, said
"DUPLICATE: FN-8595" followed by its reasoning, and explicitly declined to write a spec file — so the
engine, which reads the verdict only from PROMPT.md's contents, saw a planner that produced no plan.
The card then failed deterministic validation, retried, terminalized, and was re-planned in a loop,
never reaching the branch that records the operator's keep-or-delete decision.

Deliberately NARROWER than a "find the word anywhere" scan, because session text is prose and a
planner may legitimately discuss another task's duplicate marker while writing a real spec:
 - the marker must occupy an ENTIRE line by itself (same shape the file contract demands), so a
   mention inside a sentence never triggers it;
 - only the FIRST such line counts — a planner listing several ids has not made a single decision;
 - callers must gate on "no plan was written", so this can never override a real spec.
*/
export function parseDuplicateMarkerFromSessionText(text: string): ExplicitDuplicateMarker | null {
  if (!text.trim()) return null;

  for (const rawLine of text.split("\n")) {
    const candidate = stripSingleWrapper(rawLine.trim());
    const match = candidate.match(/^DUPLICATE:\s*(FN-\d+)\s*$/i);
    if (match) {
      return { canonicalId: match[1].toUpperCase() };
    }
  }
  return null;
}

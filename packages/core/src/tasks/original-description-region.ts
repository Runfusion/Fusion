import { createLogger } from "../process/logger.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
  resolveOriginalDescriptionEnd,
} from "./original-description-policy.js";

/**
 * FNXC:PlanApproval 2026-07-15-21:30:
 * FN-8008 — Original Description bodies are verbatim, so marker-like text can occur both
 * inside the generated body and later in operator-authored prompt content. The generated
 * closing marker is bounded by the next known PROMPT section (or end of file), preventing a
 * later literal marker from swallowing a real Mission/Steps/File Scope revision.
 *
 * FNXC:SpecLock 2026-09-07-05:09:
 * The spec-lock parser and approval fingerprint share this resolver so operator prose cannot
 * drift their view of planner-authored prompt structure.
 *
 * FNXC:SpecLock 2026-09-09-08:09:
 * FN-9272 derives accepted marker successors from the policy-owned terminator list. This keeps
 * the planner-required What This Delivers section aligned with spec-lock parsing while retaining
 * the known-heading boundary that prevents literal markers in operator prose from swallowing plans.
 */
export function findGeneratedOriginalDescriptionEnd(promptText: string, start: number): number {
  if (start === -1) return -1;
  const result = resolveOriginalDescriptionEnd(
    promptText,
    start + ORIGINAL_DESCRIPTION_START_MARKER.length,
  );
  return result.resolved ? result.end : -1;
}

/** Remove only the exact deterministic Original Description section injected during specification hygiene. */
export function stripGeneratedOriginalDescription(promptText: string): string {
  const start = promptText.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
  if (start === -1) return promptText;
  const result = resolveOriginalDescriptionEnd(
    promptText,
    start + ORIGINAL_DESCRIPTION_START_MARKER.length,
  );
  // The read path alone reports ambiguity: unresolved takes precedence over skipped candidates.
  if (!result.resolved) {
    createLogger("original-description-region").warn(
      `Generated Original Description start marker has no acceptable end marker; successor heading: ${result.rejectedSuccessorHeading ?? "(no following H2 heading)"}; skipped candidates: ${result.skippedCandidateCount}`,
    );
    return promptText;
  }
  if (result.skippedCandidateCount > 0) {
    createLogger("original-description-region").warn(
      `Generated Original Description skipped candidates before a resolved end marker: ${result.skippedCandidateCount}`,
    );
  }
  const end = result.end;

  const heading = promptText.lastIndexOf(ORIGINAL_DESCRIPTION_HEADING, start);
  if (heading === -1) return promptText;

  const sectionEnd = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  const before = promptText.slice(0, heading).trimEnd();
  const after = promptText.slice(sectionEnd).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

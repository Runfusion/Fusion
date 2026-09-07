import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
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
 */
export function findGeneratedOriginalDescriptionEnd(promptText: string, start: number): number {
  if (start === -1) return -1;

  let searchFrom = start + ORIGINAL_DESCRIPTION_START_MARKER.length;
  while (searchFrom < promptText.length) {
    const end = promptText.indexOf(ORIGINAL_DESCRIPTION_END_MARKER, searchFrom);
    if (end === -1) return -1;

    const after = promptText.slice(end + ORIGINAL_DESCRIPTION_END_MARKER.length);
    if (
      !after.trim()
      || /^\n{1,2}##\s+(?:Before\s*→\s*After Transformation|Review Level(?:\s*:.*)?|Mission|Surface Enumeration|Symptom Verification|Dependencies|Context to Read First|File Scope|Steps|Documentation Requirements|Completion Criteria|Git Commit Convention|Do NOT|Changeset Requirements|Frontend UX Criteria|Acceptance Criteria|Notifications|External Integration Evidence)\s*(?:\n|$)/.test(after)
    ) {
      return end;
    }
    searchFrom = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  }
  return -1;
}

/** Remove only the exact deterministic Original Description section injected during specification hygiene. */
export function stripGeneratedOriginalDescription(promptText: string): string {
  const start = promptText.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
  const end = findGeneratedOriginalDescriptionEnd(promptText, start);
  if (start === -1 || end === -1) return promptText;

  const heading = promptText.lastIndexOf(ORIGINAL_DESCRIPTION_HEADING, start);
  if (heading === -1) return promptText;

  const sectionEnd = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  const before = promptText.slice(0, heading).trimEnd();
  const after = promptText.slice(sectionEnd).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

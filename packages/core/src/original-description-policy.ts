/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Generated PROMPT.md (AI-planned and non-AI specified) must keep the operator's original
task description near the top so executors always see the source request after planning
rewrites Mission/Steps/etc. Bootstrap stubs (buildBootstrapPrompt) stay description-only
under the title — this helper is only for real specifications.

Placement: after the `#` title heading and optional Created/Size metadata lines, before
any other `##` section (including Before → After Transformation and Mission).

Idempotent: if `## Original Description` already exists, replace its body with the verbatim
description so paraphrased planner copies cannot stick. Empty descriptions still get a
section so the heading is a stable contract for executors and tests.
*/

export const ORIGINAL_DESCRIPTION_HEADING = "## Original Description";

/**
 * Build the `## Original Description` section body (heading + blank line + verbatim text).
 * Ends with exactly one trailing newline so insertion is predictable.
 */
export function buildOriginalDescriptionSection(originalDescription: string): string {
  const body = originalDescription ?? "";
  return `${ORIGINAL_DESCRIPTION_HEADING}\n\n${body.trimEnd()}\n`;
}

/**
 * Ensure `promptMarkdown` includes a top-of-spec `## Original Description` section with the
 * operator text verbatim. Safe to call repeatedly; never inspects bootstrap-stub equality
 * (callers only apply this to planned/specified prompts).
 */
export function applyOriginalDescription(
  promptMarkdown: string,
  originalDescription: string,
): string {
  if (!promptMarkdown) {
    return promptMarkdown;
  }

  const wantedBody = (originalDescription ?? "").trimEnd();
  const existingBody = extractOriginalDescriptionBody(promptMarkdown);
  // Idempotent when the section already carries the exact operator text.
  if (existingBody !== null && existingBody.trimEnd() === wantedBody) {
    return promptMarkdown;
  }

  const section = buildOriginalDescriptionSection(originalDescription);
  if (existingBody !== null) {
    return replaceOriginalDescriptionSection(promptMarkdown, section);
  }
  return insertOriginalDescriptionNearTop(promptMarkdown, section);
}

/** Returns the body under `## Original Description`, or null when the section is absent. */
function extractOriginalDescriptionBody(content: string): string | null {
  const match = content.match(/^##\s+Original Description\s*$/m);
  if (!match || match.index === undefined) {
    return null;
  }
  const headerEnd = match.index + match[0].length;
  const rest = content.slice(headerEnd);
  const nextHeading = rest.search(/\n##\s/);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return body.replace(/^\n+/, "").replace(/\n+$/, "\n").trimEnd();
}

function replaceOriginalDescriptionSection(content: string, section: string): string {
  const match = content.match(/^##\s+Original Description\s*$/m);
  if (!match || match.index === undefined) {
    return content;
  }

  const headerEnd = match.index + match[0].length;
  const rest = content.slice(headerEnd);
  const nextHeading = rest.search(/\n##\s/);
  const sectionEndAbsolute = nextHeading === -1 ? content.length : headerEnd + nextHeading;
  const before = content.slice(0, match.index).trimEnd();
  const after = content.slice(sectionEndAbsolute);
  // Keep a blank line before the next ## heading (after is "" or "\n## ...").
  // section already ends with one trailing newline from buildOriginalDescriptionSection.
  if (!after) {
    return `${before}\n\n${section.trimEnd()}\n`;
  }
  return `${before}\n\n${section.trimEnd()}\n${after}`;
}

/**
 * Insert before the first `##` heading so the section sits under title/metadata and above
 * planner sections (Before → After, Mission, etc.). If no H2 exists, append after the body.
 */
function insertOriginalDescriptionNearTop(content: string, section: string): string {
  const firstH2 = content.search(/^##\s+/m);
  if (firstH2 !== -1) {
    const before = content.slice(0, firstH2).trimEnd();
    const after = content.slice(firstH2);
    return `${before}\n\n${section.trimEnd()}\n\n${after}`;
  }
  return `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
}

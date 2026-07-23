/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Generated PROMPT.md (AI-planned and non-AI specified) must keep the operator's original
task description near the top so executors always see the source request after planning
rewrites Mission/Steps/etc. Bootstrap stubs (buildBootstrapPrompt) stay description-only
under the title — this helper is only for real specifications.

Placement: after the `#` title heading and optional Created/Size metadata lines, before
any other structural `##` section (including Before → After Transformation and Mission).

Idempotent: if `## Original Description` already exists, replace its body with the verbatim
description so paraphrased planner copies cannot stick. Empty descriptions still get a
section so the heading is a stable contract for executors and tests.

FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
Operator descriptions routinely contain markdown H2 lines (e.g. `## Required behavior`).
Naive "next `##` ends the section" parsing treated those as PROMPT structure and, on
description updates, replaced only a prefix while leaving the old suffix — duplicating and
corrupting PROMPT.md. Section bounds use HTML markers when present, else only known
structural PROMPT headings (Mission, File Scope, Steps, …), so embedded H2s stay inside
the Original Description body.
*/

export const ORIGINAL_DESCRIPTION_HEADING = "## Original Description";

/** Markers delimit the verbatim body so embedded `##` lines cannot end the section. */
export const ORIGINAL_DESCRIPTION_START_MARKER = "<!-- fusion-original-description:start -->";
export const ORIGINAL_DESCRIPTION_END_MARKER = "<!-- fusion-original-description:end -->";

/**
 * When markers are absent (planner-written plain section), end Original Description at the
 * first *preferred following* structural heading that appears in the file — not the first
 * arbitrary `##` line. Preferred order matters: operator text may contain `## Mission` as
 * prose; we still bind to a later `## Before → After Transformation` / `## Review Level`
 * when those exist (standard/concise templates). Unknown H2s never end the section.
 */
const PREFERRED_SECTION_TERMINATORS: RegExp[] = [
  /^##\s+Before\s*→\s*After Transformation\s*$/im,
  /^##\s+Review Level(?:\s*:.*)?\s*$/im,
  /^##\s+Mission\s*$/im,
  /^##\s+Surface Enumeration\s*$/im,
  /^##\s+Symptom Verification\s*$/im,
  /^##\s+Dependencies\s*$/im,
  /^##\s+Context to Read First\s*$/im,
  /^##\s+File Scope\s*$/im,
  /^##\s+Steps\s*$/im,
  /^##\s+Documentation Requirements\s*$/im,
  /^##\s+Completion Criteria\s*$/im,
  /^##\s+Git Commit Convention\s*$/im,
  /^##\s+Do NOT\s*$/im,
  /^##\s+Changeset Requirements\s*$/im,
  /^##\s+Frontend UX Criteria\s*$/im,
  /^##\s+Acceptance Criteria\s*$/im,
  /^##\s+Notifications\s*$/im,
  /^##\s+External Integration Evidence\s*$/im,
];

/**
 * Build the `## Original Description` section body (heading + marked verbatim text).
 * Ends with exactly one trailing newline so insertion is predictable.
 */
export function buildOriginalDescriptionSection(originalDescription: string): string {
  const body = (originalDescription ?? "").trimEnd();
  return (
    `${ORIGINAL_DESCRIPTION_HEADING}\n\n` +
    `${ORIGINAL_DESCRIPTION_START_MARKER}\n` +
    `${body}\n` +
    `${ORIGINAL_DESCRIPTION_END_MARKER}\n`
  );
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
    // Still rewrite when markers are missing so later updates stay H2-safe.
    if (hasOriginalDescriptionMarkers(promptMarkdown)) {
      return promptMarkdown;
    }
  }

  const section = buildOriginalDescriptionSection(originalDescription);
  if (existingBody !== null || hasOriginalDescriptionHeading(promptMarkdown)) {
    return replaceOriginalDescriptionSection(promptMarkdown, section);
  }
  return insertOriginalDescriptionNearTop(promptMarkdown, section);
}

/** Returns the body under `## Original Description`, or null when the section is absent. */
export function extractOriginalDescriptionBody(content: string): string | null {
  const range = findOriginalDescriptionRange(content);
  if (!range) {
    return null;
  }
  return range.body.trimEnd();
}

function hasOriginalDescriptionHeading(content: string): boolean {
  return /^##\s+Original Description\s*$/m.test(content);
}

function hasOriginalDescriptionMarkers(content: string): boolean {
  return (
    content.includes(ORIGINAL_DESCRIPTION_START_MARKER) &&
    content.includes(ORIGINAL_DESCRIPTION_END_MARKER)
  );
}

/**
 * Absolute [start, end) range of the Original Description section and its body text.
 * Prefer HTML markers; fall back to the next known structural PROMPT heading.
 */
function findOriginalDescriptionRange(
  content: string,
): { sectionStart: number; sectionEnd: number; body: string } | null {
  const match = content.match(/^##\s+Original Description\s*$/m);
  if (!match || match.index === undefined) {
    return null;
  }

  const sectionStart = match.index;
  const headerEnd = match.index + match[0].length;
  const afterHeader = content.slice(headerEnd);

  // Marker-bounded body (preferred — safe for any embedded markdown).
  const startMarkerIdx = afterHeader.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
  const endMarkerIdx = afterHeader.indexOf(ORIGINAL_DESCRIPTION_END_MARKER);
  if (
    startMarkerIdx !== -1 &&
    endMarkerIdx !== -1 &&
    endMarkerIdx > startMarkerIdx
  ) {
    const bodyStart = startMarkerIdx + ORIGINAL_DESCRIPTION_START_MARKER.length;
    const body = afterHeader.slice(bodyStart, endMarkerIdx).replace(/^\n/, "").replace(/\n$/, "");
    const sectionEnd =
      headerEnd + endMarkerIdx + ORIGINAL_DESCRIPTION_END_MARKER.length;
    // Consume a single trailing newline after the end marker when present.
    const absoluteEnd =
      content[sectionEnd] === "\n" ? sectionEnd + 1 : sectionEnd;
    return { sectionStart, sectionEnd: absoluteEnd, body };
  }

  // Unmarked (planner-written): end at preferred following structural heading.
  const structuralOffset = findPreferredSectionTerminatorOffset(afterHeader);
  const sectionEnd =
    structuralOffset === -1 ? content.length : headerEnd + structuralOffset;
  const body = afterHeader
    .slice(0, structuralOffset === -1 ? undefined : structuralOffset)
    .replace(/^\n+/, "")
    .trimEnd();
  return { sectionStart, sectionEnd, body };
}

/**
 * Offset of the preferred section terminator within `text`, or -1.
 * Walks preferred following headings in template order and returns the first that exists
 * (even if a lower-priority structural heading like Mission appears earlier in the body).
 */
function findPreferredSectionTerminatorOffset(text: string): number {
  for (const re of PREFERRED_SECTION_TERMINATORS) {
    // Fresh regex instance so global/sticky flags never retain lastIndex.
    const match = new RegExp(re.source, re.flags).exec(text);
    if (match) {
      return match.index;
    }
  }
  return -1;
}

function replaceOriginalDescriptionSection(content: string, section: string): string {
  const range = findOriginalDescriptionRange(content);
  if (!range) {
    return content;
  }

  const before = content.slice(0, range.sectionStart).trimEnd();
  let after = content.slice(range.sectionEnd);
  // Drop a leading blank line on after so we don't triple-space before the next section.
  after = after.replace(/^\n*/, "\n\n");
  if (!after.trim()) {
    return `${before}\n\n${section.trimEnd()}\n`;
  }
  return `${before}\n\n${section.trimEnd()}${after}`;
}

/**
 * Insert before the preferred following structural section so the block sits under
 * title/metadata. Unknown H2s are ignored. Falls back to the first H2, then append.
 */
function insertOriginalDescriptionNearTop(content: string, section: string): string {
  const structuralOffset = findPreferredSectionTerminatorOffset(content);
  if (structuralOffset !== -1) {
    const before = content.slice(0, structuralOffset).trimEnd();
    const after = content.slice(structuralOffset);
    return `${before}\n\n${section.trimEnd()}\n\n${after}`;
  }

  const firstH2 = content.search(/^##\s+/m);
  if (firstH2 !== -1) {
    const before = content.slice(0, firstH2).trimEnd();
    const after = content.slice(firstH2);
    return `${before}\n\n${section.trimEnd()}\n\n${after}`;
  }
  return `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
}

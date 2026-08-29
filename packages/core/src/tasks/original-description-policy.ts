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

FNXC:OriginalDescriptionInPrompt 2026-08-01-05:18:
Custom workflow plan-node sections are first-class: hygiene must neither swallow nor reorder them.
For an unmarked section, precedence is: (1) an empty description ends at the first following H2;
(2a) full normalized positional alignment ends at the first H2 at/after the aligned body; (2b) a
non-empty matching prefix does the same only when its unmatched description suffix has no H2; (2c)
a prefix whose unmatched suffix contains an H2 is unsafe and falls through because that next document
H2 may be embedded operator prose, so terminating there would truncate the operator body; (2d) no
alignment also falls through; (3) those failure cases retain the allowlist-priority (not document-order)
tiebreak; (4) no selected heading runs to end-of-document. Heading-title evidence is not primary: a
custom heading can also appear in operator prose and title skipping would destroy that section. Empty
operator text has no embedded-H2 risk, so it bypasses the allowlist. INSERT has no body to align and
therefore changed from allowlist-preferred placement to anchoring before the first document H2.
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
  const existingBody = extractOriginalDescriptionBody(promptMarkdown, originalDescription);
  // Idempotent when the section already carries the exact operator text.
  if (existingBody !== null && existingBody.trimEnd() === wantedBody) {
    // Still rewrite when markers are missing so later updates stay H2-safe.
    if (hasOriginalDescriptionMarkers(promptMarkdown)) {
      return promptMarkdown;
    }
  }

  const section = buildOriginalDescriptionSection(originalDescription);
  if (existingBody !== null || hasOriginalDescriptionHeading(promptMarkdown)) {
    return replaceOriginalDescriptionSection(promptMarkdown, section, originalDescription);
  }
  return insertOriginalDescriptionNearTop(promptMarkdown, section);
}

/** Returns the body under `## Original Description`, or null when the section is absent. */
export function extractOriginalDescriptionBody(
  content: string,
  originalDescription?: string,
): string | null {
  const range = findOriginalDescriptionRange(content, originalDescription);
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
 * Prefer HTML markers; otherwise align the known operator body before using legacy structure.
 */
function findOriginalDescriptionRange(
  content: string,
  originalDescription?: string,
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

  // Unmarked planner output: preserve arbitrary custom H2 sections after the aligned body.
  const terminatorOffset = findUnmarkedSectionTerminatorOffset(afterHeader, originalDescription);
  const sectionEnd =
    terminatorOffset === -1 ? content.length : headerEnd + terminatorOffset;
  const body = afterHeader
    .slice(0, terminatorOffset === -1 ? undefined : terminatorOffset)
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

type NormalizedLine = { value: string; endOffset: number };

/**
 * Normalize markdown lines for body alignment while retaining each normalized line's source end.
 * Blank runs coalesce so harmless planner formatting does not defeat alignment.
 */
function normalizeLines(content: string): NormalizedLine[] {
  const lines: NormalizedLine[] = [];
  let offset = 0;
  let pendingBlank: NormalizedLine | undefined;

  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const lineEnd = newline === -1 ? content.length : newline;
    const rawLine = content.slice(offset, lineEnd).replace(/\r$/, "");
    const nextOffset = newline === -1 ? content.length : newline + 1;
    const line = { value: rawLine.trim(), endOffset: nextOffset };

    if (!line.value) {
      // Leading/trailing blanks are discarded; interior runs become one blank line.
      if (lines.length > 0) pendingBlank = line;
    } else {
      if (pendingBlank) lines.push(pendingBlank);
      pendingBlank = undefined;
      lines.push(line);
    }
    offset = nextOffset;
  }

  return lines;
}

function isH2Heading(line: string): boolean {
  return /^##\s+\S.*$/.test(line);
}

function findFirstH2AtOrAfter(text: string, offset: number): number {
  const candidates = /^##\s+\S.*$/gm;
  for (const match of text.matchAll(candidates)) {
    if (match.index !== undefined && match.index >= offset) return match.index;
  }
  return -1;
}

/**
 * Find an unmarked section boundary using the operator body before legacy heading tiebreaks.
 */
function findUnmarkedSectionTerminatorOffset(
  text: string,
  originalDescription?: string,
): number {
  const descriptionLines = normalizeLines(originalDescription ?? "");
  if (descriptionLines.length === 0) {
    return findFirstH2AtOrAfter(text, 0);
  }

  const documentLines = normalizeLines(text);
  let matched = 0;
  while (
    matched < descriptionLines.length &&
    matched < documentLines.length &&
    descriptionLines[matched].value === documentLines[matched].value
  ) {
    matched += 1;
  }

  const unmatchedDescriptionHasH2 = descriptionLines
    .slice(matched)
    .some((line) => isH2Heading(line.value));
  const alignmentIsSafe = matched === descriptionLines.length ||
    (matched > 0 && !unmatchedDescriptionHasH2);
  if (alignmentIsSafe) {
    const alignEnd = documentLines[matched - 1].endOffset;
    return findFirstH2AtOrAfter(text, alignEnd);
  }

  // Preserve historical allowlist-priority behavior only when alignment cannot prove a boundary.
  const preferredOffset = findPreferredSectionTerminatorOffset(text);
  return preferredOffset !== -1 ? preferredOffset : findFirstH2AtOrAfter(text, 0);
}

function replaceOriginalDescriptionSection(
  content: string,
  section: string,
  originalDescription?: string,
): string {
  const range = findOriginalDescriptionRange(content, originalDescription);
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
 * Insert before the first structural H2 so custom sections retain their document order.
 * There is no existing body here, so range alignment deliberately does not apply.
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

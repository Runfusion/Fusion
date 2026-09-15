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

FNXC:OriginalDescriptionInPrompt 2026-08-27-10:22:
The product summary now sits between Original Description and Before → After Transformation.
On an unmarked, unaligned fallback it must be the highest-priority terminator, otherwise
hygiene rewrites Original Description through the summary and destroys the operator's intent check.

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
export const ORIGINAL_DESCRIPTION_ENCODING_MARKER = "<!-- fusion-original-description:encoding=escaped-v1 -->";
export const ORIGINAL_DESCRIPTION_ESCAPE_PREFIX = "<!-- fusion-original-description:esc:";

/**
 * FNXC:SpecLock 2026-09-15-02:52:
 * FN-9272 makes marker quoting decidable at the hygiene write boundary. Encoding is declared
 * in-band because conditionally escaping then guessing whether to decode loses operator text.
 * The declaration is itself reserved, so an operator cannot spoof an encoded region.
 */
const ESCAPED_MARKERS = {
  start: `${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}start -->`,
  end: `${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}end -->`,
  encoding: `${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}encoding -->`,
  escape: `${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}escape -->`,
} as const;

function normalizeOriginalDescriptionBody(body: string): string {
  return (body ?? "").trimEnd();
}

export function shouldEncodeOriginalDescriptionBody(body: string): boolean {
  return [
    ORIGINAL_DESCRIPTION_START_MARKER,
    ORIGINAL_DESCRIPTION_END_MARKER,
    ORIGINAL_DESCRIPTION_ENCODING_MARKER,
    ORIGINAL_DESCRIPTION_ESCAPE_PREFIX,
  ].some((token) => body.includes(token));
}

/** Total, injective codec: escape the escape prefix before reserved marker tokens. */
export function encodeOriginalDescriptionBody(body: string): string {
  return body
    .replaceAll(ORIGINAL_DESCRIPTION_ESCAPE_PREFIX, ESCAPED_MARKERS.escape)
    .replaceAll(ORIGINAL_DESCRIPTION_START_MARKER, ESCAPED_MARKERS.start)
    .replaceAll(ORIGINAL_DESCRIPTION_END_MARKER, ESCAPED_MARKERS.end)
    .replaceAll(ORIGINAL_DESCRIPTION_ENCODING_MARKER, ESCAPED_MARKERS.encoding);
}

/** Decode one encoded body in a single left-to-right scan so escape forms never double-decode. */
export function decodeOriginalDescriptionBody(body: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < body.length) {
    const next = body.indexOf(ORIGINAL_DESCRIPTION_ESCAPE_PREFIX, cursor);
    if (next === -1) return output + body.slice(cursor);
    output += body.slice(cursor, next);
    const suffix = body.slice(next);
    const match = Object.entries(ESCAPED_MARKERS).find(([, escaped]) => suffix.startsWith(escaped));
    if (!match) {
      output += ORIGINAL_DESCRIPTION_ESCAPE_PREFIX;
      cursor = next + ORIGINAL_DESCRIPTION_ESCAPE_PREFIX.length;
      continue;
    }
    const [kind, escaped] = match;
    output += kind === "start" ? ORIGINAL_DESCRIPTION_START_MARKER
      : kind === "end" ? ORIGINAL_DESCRIPTION_END_MARKER
        : kind === "encoding" ? ORIGINAL_DESCRIPTION_ENCODING_MARKER
          : ORIGINAL_DESCRIPTION_ESCAPE_PREFIX;
    cursor = next + escaped.length;
  }
  return output;
}

function stripMarkedBodyEnvelope(body: string): string {
  return body.replace(/^\n/, "").replace(/\n$/, "");
}

function decodeDeclaredOriginalDescriptionBody(body: string): string {
  const enveloped = stripMarkedBodyEnvelope(body);
  if (enveloped === ORIGINAL_DESCRIPTION_ENCODING_MARKER) return "";
  if (enveloped.startsWith(`${ORIGINAL_DESCRIPTION_ENCODING_MARKER}\n`)) {
    return decodeOriginalDescriptionBody(enveloped.slice(ORIGINAL_DESCRIPTION_ENCODING_MARKER.length + 1));
  }
  return enveloped;
}

/**
 * When markers are absent (planner-written plain section), end Original Description at the
 * first *preferred following* structural heading that appears in the file — not the first
 * arbitrary `##` line. Preferred order matters: operator text may contain `## Mission` as
 * prose; we still bind to a later `## Before → After Transformation` / `## Review Level`
 * when those exist (standard/concise templates). Unknown H2s never end the section.
 */
/*
 * FNXC:SpecLock 2026-09-09-08:09:
 * FN-9272 makes this policy-owned list the shared definition for both unmarked Original
 * Description placement and marked-region validation. Keeping one definition ensures the
 * planner's required What This Delivers successor cannot drift from spec-lock parsing.
 */
export const PREFERRED_SECTION_TERMINATORS: readonly RegExp[] = [
  /^##\s+What This Delivers\s*$/im,
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
  const body = normalizeOriginalDescriptionBody(originalDescription);
  const storedBody = shouldEncodeOriginalDescriptionBody(body)
    ? `${ORIGINAL_DESCRIPTION_ENCODING_MARKER}\n${encodeOriginalDescriptionBody(body)}`
    : body;
  return (
    `${ORIGINAL_DESCRIPTION_HEADING}\n\n` +
    `${ORIGINAL_DESCRIPTION_START_MARKER}\n` +
    `${storedBody}\n` +
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

  const wantedBody = normalizeOriginalDescriptionBody(originalDescription);
  const existingBody = extractOriginalDescriptionBody(promptMarkdown, originalDescription);
  const needsEncoding = shouldEncodeOriginalDescriptionBody(wantedBody);
  // Idempotent only when the stored form also satisfies the declared encoding protocol.
  if (existingBody !== null && existingBody.trimEnd() === wantedBody) {
    const hasDeclaration = promptMarkdown.includes(
      `${ORIGINAL_DESCRIPTION_START_MARKER}\n${ORIGINAL_DESCRIPTION_ENCODING_MARKER}`,
    );
    if (hasOriginalDescriptionMarkers(promptMarkdown) && hasDeclaration === needsEncoding) {
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
  return decodeDeclaredOriginalDescriptionBody(range.body).trimEnd();
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
 * FNXC:SpecLock 2026-09-15-02:52:
 * Writer and reader use this one resolver, but only hygiene supplies the known operator body:
 * that makes the write boundary decidable and repairs truncated legacy artifacts. Readers stay
 * pure prompt functions because their results feed persisted approval/spec-lock hashes.
 *
 * The invariant is region-scoped: hygiene encodes marker literals so P1 leaves no raw end marker
 * inside a written region and P2 selects its first end marker. Plans may quote markers after the
 * region, so file-wide uniqueness and fence tracking are both invalid. The known-heading guard
 * remains for best-effort legacy reads; only the read path turns skipped/unresolved results into
 * one warning, while matching hygiene is deliberately silent.
 */
export function resolveOriginalDescriptionEnd(
  promptText: string,
  startAfterMarker: number,
  expectedBody?: string,
): { resolved: boolean; end: number; skippedCandidateCount: number; rejectedSuccessorHeading?: string } {
  let searchFrom = startAfterMarker;
  let skippedCandidateCount = 0;
  let rejectedSuccessorHeading: string | undefined;
  const expected = expectedBody === undefined ? undefined : normalizeOriginalDescriptionBody(expectedBody);

  while (searchFrom < promptText.length) {
    const end = promptText.indexOf(ORIGINAL_DESCRIPTION_END_MARKER, searchFrom);
    if (end === -1) break;
    const rawBody = promptText.slice(startAfterMarker, end);
    if (expected !== undefined) {
      if (normalizeOriginalDescriptionBody(decodeDeclaredOriginalDescriptionBody(rawBody)) === expected) {
        return { resolved: true, end, skippedCandidateCount };
      }
    } else {
      const after = promptText.slice(end + ORIGINAL_DESCRIPTION_END_MARKER.length);
      const successor = /^\n{1,2}(##[^\r\n]*)(?:\r?\n|$)/.exec(after)?.[1];
      const isKnownSuccessor = successor !== undefined && PREFERRED_SECTION_TERMINATORS.some((pattern) =>
        new RegExp(pattern.source, pattern.flags).test(successor),
      );
      if (!after.trim() || isKnownSuccessor) {
        return { resolved: true, end, skippedCandidateCount };
      }
      rejectedSuccessorHeading ??= /^##[^\r\n]*$/m.exec(after)?.[0]?.trim().slice(0, 160);
    }
    skippedCandidateCount += 1;
    searchFrom = end + ORIGINAL_DESCRIPTION_END_MARKER.length;
  }
  rejectedSuccessorHeading ??= /^##[^\r\n]*$/m.exec(promptText.slice(startAfterMarker))?.[0]?.trim().slice(0, 160);
  return { resolved: false, end: -1, skippedCandidateCount, rejectedSuccessorHeading };
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
  if (startMarkerIdx !== -1) {
    const bodyStart = headerEnd + startMarkerIdx + ORIGINAL_DESCRIPTION_START_MARKER.length;
    /*
    FNXC:SpecLock 2026-09-15-03:12:
    FN-9272 uses the known body to repair an ambiguous legacy region before later description
    updates. If that body no longer matches, fall back to the first valid boundary only: scanning
    past it could mistake a marker quote in planner prose for the region end and delete that prose.
    The writer remains silent because matching and conservative replacement are not read ambiguity.
    */
    const expectedResolution = resolveOriginalDescriptionEnd(content, bodyStart, originalDescription);
    const resolution = expectedResolution.resolved
      ? expectedResolution
      : resolveOriginalDescriptionEnd(content, bodyStart);
    if (!resolution.resolved) return null;
    const body = content.slice(bodyStart, resolution.end);
    const sectionEnd = resolution.end + ORIGINAL_DESCRIPTION_END_MARKER.length;
    // Consume a single trailing newline after the end marker when present.
    const absoluteEnd = content[sectionEnd] === "\n" ? sectionEnd + 1 : sectionEnd;
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

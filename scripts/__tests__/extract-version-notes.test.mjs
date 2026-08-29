import test from "node:test";
import assert from "node:assert/strict";

import { extractVersionNotes, replaceVersionSection } from "../lib/extract-version-notes.mjs";

const changelog = `# Fusion changelog

## 1.2.0

### @runfusion/fusion

#### Patch Changes

- Added release integration.

## 1.1.0

### @runfusion/fusion

#### Patch Changes

- Fixed parser bug.

## 1.0.0

### @runfusion/fusion

#### Patch Changes

- Initial release.
`;

test("extracts correct section for known version", () => {
  const notes = extractVersionNotes(changelog, "1.1.0");
  assert.match(notes, /Fixed parser bug\./);
  assert.doesNotMatch(notes, /Added release integration\./);
});

test("returns full multiline body including sub-headings", () => {
  const notes = extractVersionNotes(changelog, "1.2.0");
  assert.match(notes, /^### @runfusion\/fusion/m);
  assert.match(notes, /^#### Patch Changes/m);
  assert.match(notes, /- Added release integration\./);
});

test("returns fallback when version not found", () => {
  const notes = extractVersionNotes(changelog, "9.9.9");
  assert.equal(notes, "Release v9.9.9");
});

test("returns fallback when changelog content is empty", () => {
  const notes = extractVersionNotes("", "1.2.0");
  assert.equal(notes, "Release v1.2.0");
});

test("handles version as last section with no trailing heading", () => {
  const notes = extractVersionNotes(changelog, "1.0.0");
  assert.match(notes, /Initial release\./);
});

test("handles single-version changelog", () => {
  const single = `# Changelog\n\n## 2.0.0\n\n### pkg\n\n#### Patch Changes\n\n- Solo entry.\n`;
  const notes = extractVersionNotes(single, "2.0.0");
  assert.match(notes, /Solo entry\./);
});

test("does not bleed into adjacent version sections", () => {
  const notes = extractVersionNotes(changelog, "1.1.0");
  assert.doesNotMatch(notes, /Initial release\./);
  assert.doesNotMatch(notes, /Added release integration\./);
});

// --- replaceVersionSection ---

test("replaces version section with distilled notes", () => {
  const result = replaceVersionSection(changelog, "1.2.0", "### New\n\n- Distilled entry.");
  assert.match(result, /### New/);
  assert.match(result, /Distilled entry\./);
  // Other versions preserved.
  assert.match(result, /Fixed parser bug\./);
  assert.match(result, /Initial release\./);
  // Old content removed.
  assert.doesNotMatch(result, /Added release integration\./);
});

test("returns original content when version not found", () => {
  const result = replaceVersionSection(changelog, "9.9.9", "### New\n\n- Entry.");
  assert.equal(result, changelog);
});

test("preserves version heading", () => {
  const result = replaceVersionSection(changelog, "1.1.0", "### Fixed\n\n- New fix.");
  assert.match(result, /## 1\.1\.0/);
  assert.match(result, /## 1\.2\.0/);
  assert.match(result, /## 1\.0\.0/);
});

test("replaces last version section correctly", () => {
  const result = replaceVersionSection(changelog, "1.0.0", "### Fixed\n\n- Replaced.");
  assert.match(result, /Replaced\./);
  // Versions above 1.0.0 are preserved.
  assert.match(result, /## 1\.1\.0/);
});

test("handles null content gracefully", () => {
  const result = replaceVersionSection(null, "1.0.0", "Body.");
  assert.equal(result, null);
});

const withArchivePointer = `# Fusion changelog

## 1.0.0

### Highlights
- One thing

> Older releases (before 0.60.0) are archived in [\`CHANGELOG-archive.md\`](./CHANGELOG-archive.md).
`;

test("extractVersionNotes excludes trailing archive pointer from last section", () => {
  const notes = extractVersionNotes(withArchivePointer, "1.0.0");
  assert.match(notes, /### Highlights/);
  assert.match(notes, /One thing/);
  assert.doesNotMatch(notes, /Older releases/);
  assert.doesNotMatch(notes, /CHANGELOG-archive/);
});

test("replaceVersionSection preserves trailing archive pointer after last version", () => {
  const result = replaceVersionSection(
    withArchivePointer,
    "1.0.0",
    "### New\n\n- Distilled only.",
  );
  assert.match(result, /### New/);
  assert.match(result, /Distilled only\./);
  assert.doesNotMatch(result, /One thing/);
  assert.match(
    result,
    /Older releases \(before 0\.60\.0\) are archived in \[`CHANGELOG-archive\.md`\]\(\.\/CHANGELOG-archive\.md\)\./,
  );
});

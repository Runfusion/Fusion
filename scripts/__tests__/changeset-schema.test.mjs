import test from "node:test";
import assert from "node:assert/strict";

import {
  parseChangesetBody,
  parseChangesetFile,
  parseChangesetChangelogEntries,
  validateChangeset,
  MAX_SUMMARY_LENGTH,
  CATEGORIES,
} from "../lib/changeset-schema.mjs";

// --- parseChangesetBody ---

test("parses well-formed structured changeset with all three fields", () => {
  const body = "summary: Add LOC backfill control.\ncategory: feature\ndev: Uses fn_backfill_loc tool.";
  const result = parseChangesetBody(body);
  assert.deepEqual(result, {
    summary: "Add LOC backfill control.",
    category: "feature",
    dev: "Uses fn_backfill_loc tool.",
    legacy: false,
  });
});

test("parses multi-line dev field", () => {
  const body = "summary: Fix mobile keyboard.\ncategory: fix\ndev: Line one.\nLine two.\nLine three.";
  const result = parseChangesetBody(body);
  assert.equal(result.dev, "Line one.\nLine two.\nLine three.");
  assert.equal(result.legacy, false);
});

test("parses structured changeset without dev field", () => {
  const body = "summary: Fix crash on startup.\ncategory: fix";
  const result = parseChangesetBody(body);
  assert.equal(result.summary, "Fix crash on startup.");
  assert.equal(result.category, "fix");
  assert.equal(result.dev, undefined);
  assert.equal(result.legacy, false);
});

test("treats freeform paragraph as legacy", () => {
  const body = "Fix ntfy test notifications to honor unsaved Settings form config so users can enable ntfy, enter a valid topic/server/token, and send a test notification before saving.";
  const result = parseChangesetBody(body);
  assert.equal(result.legacy, true);
  assert.equal(result.category, "internal");
  assert.ok(result.summary.length > 0);
  assert.equal(result.summary, body.trim());
});

test("treats multi-line freeform paragraph as legacy with first line as summary", () => {
  const body = "First line of the changeset.\nSecond line with more detail.\nThird line.";
  const result = parseChangesetBody(body);
  assert.equal(result.legacy, true);
  assert.equal(result.summary, "First line of the changeset.");
});

test("returns null for empty body", () => {
  assert.equal(parseChangesetBody(""), null);
  assert.equal(parseChangesetBody("   \n  \n  "), null);
});

test("returns null for undefined body", () => {
  assert.equal(parseChangesetBody(undefined), null);
});

test("handles fields in any order", () => {
  const body = "category: fix\nsummary: Fix the bug.";
  const result = parseChangesetBody(body);
  assert.equal(result.category, "fix");
  assert.equal(result.summary, "Fix the bug.");
  assert.equal(result.legacy, false);
});

test("handles summary at exactly max length boundary", () => {
  const summary = "a".repeat(MAX_SUMMARY_LENGTH);
  const body = `summary: ${summary}\ncategory: feature`;
  const result = parseChangesetBody(body);
  assert.equal(result.summary.length, MAX_SUMMARY_LENGTH);
  const validation = validateChangeset(result);
  assert.equal(validation.valid, true);
});

test("handles summary over max length", () => {
  const summary = "a".repeat(MAX_SUMMARY_LENGTH + 1);
  const body = `summary: ${summary}\ncategory: feature`;
  const result = parseChangesetBody(body);
  const validation = validateChangeset(result);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors[0].includes("exceeds max length"));
});

// --- validateChangeset ---

test("validates clean structured changeset", () => {
  const parsed = { summary: "Good summary.", category: "feature", legacy: false };
  const result = validateChangeset(parsed);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("flags missing category on structured changeset", () => {
  const parsed = { summary: "Good summary.", category: "", legacy: false };
  const result = validateChangeset(parsed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("missing required `category`")));
});

test("flags invalid category value", () => {
  const parsed = { summary: "Good summary.", category: "enhancement", legacy: false };
  const result = validateChangeset(parsed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("invalid") && e.includes("enhancement")));
  assert.ok(result.errors.some((e) => e.includes(CATEGORIES.join(", "))));
});

test("skips validation for legacy changesets", () => {
  const parsed = { summary: "x".repeat(500), category: "internal", legacy: true };
  const result = validateChangeset(parsed);
  assert.equal(result.valid, true);
});

test("flags missing summary on structured changeset", () => {
  const parsed = { summary: "", category: "fix", legacy: false };
  const result = validateChangeset(parsed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("missing required `summary`")));
});

// --- parseChangesetFile ---

test("parses full changeset file with frontmatter", () => {
  const raw = "---\n\"@runfusion/fusion\": minor\n---\nsummary: New feature.\ncategory: feature\ndev: Implementation detail.";
  const result = parseChangesetFile(raw);
  assert.equal(result.frontmatter, '"@runfusion/fusion": minor');
  assert.ok(result.body.includes("summary:"));
  assert.equal(result.parsed.summary, "New feature.");
  assert.equal(result.parsed.category, "feature");
  assert.equal(result.parsed.dev, "Implementation detail.");
});

test("parses legacy changeset file with frontmatter", () => {
  const raw = "---\n\"@runfusion/fusion\": patch\n---\nFix a bug in the parser that caused crashes on startup.";
  const result = parseChangesetFile(raw);
  assert.equal(result.parsed.legacy, true);
  assert.equal(result.parsed.summary, "Fix a bug in the parser that caused crashes on startup.");
});

test("handles file without frontmatter gracefully", () => {
  const raw = "summary: No frontmatter.\ncategory: feature";
  const result = parseChangesetFile(raw);
  assert.equal(result.frontmatter, "");
  assert.equal(result.parsed.summary, "No frontmatter.");
});

// --- parseChangesetChangelogEntries ---

test("preserves multiline labeled fields from Changesets changelog bullets", () => {
  const notes = [
    "### Patch Changes",
    "",
    "- 831ed4c: summary: Restore Chinese roadmap duplicate labels.",
    "  category: fix",
    "  dev: Restores zh-CN and zh-TW catalog entries.",
  ].join("\n");

  assert.deepEqual(parseChangesetChangelogEntries(notes), [
    {
      summary: "Restore Chinese roadmap duplicate labels.",
      category: "fix",
      dev: "Restores zh-CN and zh-TW catalog entries.",
      legacy: false,
    },
  ]);
});

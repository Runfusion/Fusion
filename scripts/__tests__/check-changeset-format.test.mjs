import test from "node:test";
import assert from "node:assert/strict";

import { scanChangesets } from "../check-changeset-format.mjs";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function createTempChangesetDir(changesets) {
  const dir = mkdtempSync(join(tmpdir(), "changeset-lint-test-"));
  for (const [name, content] of Object.entries(changesets)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const validStructured = `---
"@runfusion/fusion": minor
---

summary: Add a new dashboard widget.
category: feature
dev: Uses the widget framework.
`;

const validMinimal = `---
"@runfusion/fusion": patch
---

summary: Fix a typo.
category: fix
`;

const legacyFreeform = `---
"@runfusion/fusion": patch
---

Fix ntfy test notifications to honor unsaved Settings form config so users can test before saving.
`;

const missingCategory = `---
"@runfusion/fusion": minor
---

summary: Add something.
`;

const invalidCategory = `---
"@runfusion/fusion": minor
---

summary: Add something.
category: enhancement
`;

const overLengthSummary = `---
"@runfusion/fusion": minor
---

summary: ${"a".repeat(121)}
category: feature
`;

const emptyBody = `---
"@runfusion/fusion": minor
---

`;

test("valid structured changeset passes with no errors", () => {
  const dir = createTempChangesetDir({ "valid.md": validStructured });
  try {
    const { errors, warnings } = scanChangesets(dir);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy freeform changeset passes with warning in transition mode", () => {
  const dir = createTempChangesetDir({ "legacy.md": legacyFreeform });
  try {
    const { errors, warnings } = scanChangesets(dir);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("legacy"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing category fails with error", () => {
  const dir = createTempChangesetDir({ "no-cat.md": missingCategory });
  try {
    const { errors } = scanChangesets(dir);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("missing required `category`"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid category value fails with error", () => {
  const dir = createTempChangesetDir({ "bad-cat.md": invalidCategory });
  try {
    const { errors } = scanChangesets(dir);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("invalid"));
    assert.ok(errors[0].includes("enhancement"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over-length summary fails with error", () => {
  const dir = createTempChangesetDir({ "long.md": overLengthSummary });
  try {
    const { errors } = scanChangesets(dir);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("exceeds max length"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty body fails with error", () => {
  const dir = createTempChangesetDir({ "empty.md": emptyBody });
  try {
    const { errors } = scanChangesets(dir);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("empty or unparseable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty directory passes with no errors or warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "changeset-lint-test-"));
  try {
    const { errors, warnings } = scanChangesets(dir);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nonexistent directory passes with no errors or warnings", () => {
  const { errors, warnings } = scanChangesets("/nonexistent/path");
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test("mixed valid and invalid changesets report all errors", () => {
  const dir = createTempChangesetDir({
    "valid.md": validStructured,
    "no-cat.md": missingCategory,
    "bad-cat.md": invalidCategory,
    "legacy.md": legacyFreeform,
  });
  try {
    const { errors, warnings } = scanChangesets(dir);
    assert.equal(errors.length, 2);
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid minimal structured changeset (no dev) passes", () => {
  const dir = createTempChangesetDir({ "minimal.md": validMinimal });
  try {
    const { errors, warnings } = scanChangesets(dir);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

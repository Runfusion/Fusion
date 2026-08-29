import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docPath = path.resolve(__dirname, "../../docs/multi-project-sequencing.md");
const doc = readFileSync(docPath, "utf8");

test("multi-project sequencing note exists with required section headings", () => {
  const headings = [
    "## Foundational layer",
    "## Identity model",
    "## Recommended sequencing",
    "## Risks of out-of-order execution",
  ];

  for (const heading of headings) {
    assert.ok(doc.includes(heading), `Missing heading: ${heading}`);
  }
});

test("multi-project sequencing note references required task IDs", () => {
  for (const taskId of ["FN-3448", "FN-3449", "FN-3503", "FN-3182"]) {
    assert.ok(doc.includes(taskId), `Expected reference to ${taskId}`);
  }
});

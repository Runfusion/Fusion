/*
FNXC:LifecycleColumnCensus 2026-08-10-06:00:
Workflow work-item `workflowRole` uses the triage/executor/reviewer/merger role vocabulary, not task
column ids. A triage-only comparison has no sibling role literal for the AST classifier to infer from,
so it must be named as a role receiver or the clean-main lifecycle ratchet reports a phantom column
guard and blocks every unrelated pull request.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { findComparisons } from "../lib/lifecycle-column-census-ast.mjs";

test("workflowRole triage comparisons stay in the role vocabulary", () => {
  const findings = findComparisons(
    "t.ts",
    'const held = items.find((item) => item.workflowRole === "triage");',
  );

  assert.deepEqual(
    findings.map(({ columnId, receiver, kind }) => ({ columnId, receiver, kind })),
    [{ columnId: "triage", receiver: "workflowRole", kind: "role" }],
  );
});

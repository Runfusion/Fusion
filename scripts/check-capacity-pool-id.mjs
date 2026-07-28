#!/usr/bin/env node
/*
FNXC:WorkflowCapacity 2026-07-28-21:10 (PR #2488 review):
THE RATCHET that makes `resolveCapacityPoolId` the ONLY way to compute a capacity
pool id, rather than merely the newest way.

Why a static check and not a code review note: the defect this guards against
already happened once, and it happened in a file that ALREADY IMPORTED the
canonical constant. `moves.ts` had `DEFAULT_WORKFLOW_ID` in scope and still wrote
`?? "builtin:coding"` where the counter used `?? DEFAULT_WORKFLOW_POOL_ID`, so the
two enforcement surfaces silently disagreed about pool identity and the
in-transaction capacity gate could never bind for a default-workflow task.
Availability of the right thing demonstrably does not prevent the wrong thing.

What is banned: deriving the pool inline with a `??` fallback onto the sentinel.
What is allowed: `resolveCapacityPoolId(...)`, and naming the constant directly
where no derivation happens (e.g. scheduler's diagnostic label for the default
pool, which has no selection input and therefore no way to drift).

Run from the merge gate so a reintroduction fails before it lands.
*/
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OWNER = "packages/core/src/workflow-capacity.ts";

// `x ?? DEFAULT_WORKFLOW_POOL_ID` in any qualified form (bare, TaskStore.-prefixed).
const BANNED = /\?\?\s*(?:[A-Za-z_$][\w$]*\.)?DEFAULT_WORKFLOW_POOL_ID/;

const files = execSync(
  "git ls-files 'packages/*/src/**/*.ts' 'packages/*/src/*.ts'",
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.endsWith(".test.ts"));

const violations = [];
for (const file of files) {
  if (file === OWNER) continue; // the resolver is where the convention lives
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    if (BANNED.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    "\ncheck-capacity-pool-id: a capacity pool id must be derived through resolveCapacityPoolId(),\n" +
      "not by an inline `?? DEFAULT_WORKFLOW_POOL_ID` fallback.\n\n" +
      "Two enforcement surfaces that each restate the convention WILL drift — that is exactly how\n" +
      "the in-transaction capacity gate silently stopped binding (moves.ts asked for pool\n" +
      '"builtin:coding" while the counter bucketed under the sentinel). Call the resolver instead:\n\n' +
      "    import { resolveCapacityPoolId } from '@fusion/core';\n" +
      "    const poolId = resolveCapacityPoolId(selection?.workflowId);\n\n" +
      "Offending lines:\n" +
      violations.map((v) => `  ${v}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(`check-capacity-pool-id: ok (${files.length} files scanned)`);

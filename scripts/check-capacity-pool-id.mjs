#!/usr/bin/env node
/*
FNXC:WorkflowCapacity 2026-07-28-22:30 (PR #2488 review — ratchet rebuilt):
CLI wrapper. The rules and their rationale live in
scripts/lib/capacity-pool-id-check.mjs; the regression suite that pins each form
this guard must catch lives in
packages/engine/src/__tests__/capacity-pool-id-check.test.ts.

Wired into `pretest`, `pretest:full`, and the blocking `test:gate`.
*/
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { findViolations, RESOLVER } from "./lib/capacity-pool-id-check.mjs";

let files;
try {
  files = execSync("git ls-files 'packages/*/src/**/*.ts' 'packages/*/src/*.ts'", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    // Test sources are excluded using the repo's own guideline shape — the
    // `{test,spec}.{ts,tsx}` family — because the earlier `.test.ts`-only suffix
    // would have scanned a `.spec.ts` sitting directly under `packages/<pkg>/src/`
    // as production source and flagged its fixtures as real violations.
    .filter((f) => !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
} catch (err) {
  // FAIL CLOSED: if we cannot even enumerate the files, we have checked nothing.
  console.error(`check-capacity-pool-id: could not list files — ${err?.message ?? err}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error("check-capacity-pool-id: file list is EMPTY — refusing to report success on zero files.");
  process.exit(1);
}

const violations = findViolations(files.map((file) => ({ file, read: () => readFileSync(file, "utf8") })));

if (violations.length > 0) {
  const byRule = {
    "unresolved-pool-into-capacity-sink":
      `a value reaching a capacity counter's \`workflowId\` must come from ${RESOLVER}().\n` +
      "  Two enforcement surfaces that each derive the pool themselves WILL drift: that is how the\n" +
      '  in-transaction gate silently stopped binding (moves.ts derived `?? "builtin:coding"` while the\n' +
      "  counter bucketed under the sentinel, so nothing was ever counted).",
    "sentinel-fallback":
      "the pool sentinel must not be restated in a `??` fallback — call the resolver instead.",
    unreadable: "a tracked source file could not be read, so it was NOT inspected.",
    unparseable: "a tracked source file could not be parsed, so it was NOT inspected.",
  };

  console.error("\ncheck-capacity-pool-id: FAILED\n");
  for (const rule of Object.keys(byRule)) {
    const hits = violations.filter((v) => v.rule === rule);
    if (hits.length === 0) continue;
    console.error(`${rule}: ${byRule[rule]}\n`);
    for (const v of hits) console.error(`  ${v.file}:${v.line}: ${v.text}`);
    console.error("");
  }
  console.error(`Fix by deriving the pool through ${RESOLVER}(selection?.workflowId).\n`);
  process.exit(1);
}

console.log(`check-capacity-pool-id: ok (${files.length} files inspected)`);

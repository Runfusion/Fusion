#!/usr/bin/env node
/*
FNXC:MoveTargetLiterals 2026-07-31-17:20 (u12 — #3150's population had no ratchet):

WHAT THIS GUARDS. A `moveTask(id, "in-review")` DESTINATION is a call argument, not a comparison, so
the lifecycle-column census — which parses comparisons — has never counted one. #3150 measured 31 such
targets across four files; they are now 0. Nothing held that at 0, so the population could regrow
silently, which is exactly how the comparison backlog drifted 787 -> 854 while its own gate was
unwired.

WHY IT MATTERS MORE THAN THE COMPARISON BACKLOG. A wrong lane GUARD silently answers "no". A wrong
move TARGET is rejected by `moveTaskInternal` with `TransitionRejectionError: unknown-column`, so on a
board that renamed its review lane, every task finishing implementation THREW instead of reaching
review. Loud, but only at runtime and only on a renamed board — the shape no unit test on the default
board can see.

AST, NOT GREP, and the reason is measured: a comment-naive scan of `self-healing.ts` reports one
remaining hit that is JSDoc prose (`* could call moveTask("in-review")`), and #3150's own SQL count
was 37 by grep against 12 real sites — 25 comments. Comments are not AST nodes, so this cannot
produce that class of false positive in either direction.

ESCAPE HATCH. A leading `DELIBERATE-LITERAL` comment on the enclosing statement exempts a site, for
the #1411 legacy safe-landing path (`recoveryRehome: true`), where the legacy id is the point rather
than an unconverted lane. Marker must be in LEADING comments — the census learned that an inline
marker attaches to the wrong node and is silently ignored.

Report-only by default; `--strict` fails on any change from the baseline, in EITHER direction, so a
drop is re-recorded in the same PR that earns it rather than leaving a stale allowance open.
*/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = process.env.FUSION_MOVE_TARGET_BASELINE_PATH
  ?? join(REPO, "scripts", "lib", "move-target-literals-baseline.json");

const LEGACY_COLUMN_IDS = new Set(["triage", "todo", "in-progress", "in-review", "done", "archived"]);
const MOVE_FNS = new Set(["moveTask", "moveTaskInternal"]);
const DELIBERATE_MARKER = "DELIBERATE-LITERAL";

const strict = process.argv.includes("--strict");
const updateBaseline = process.argv.includes("--update-baseline");
const json = process.argv.includes("--json");

let files;
try {
  files = execSync(
    "git ls-files 'packages/*/src/**/*.ts' 'packages/*/src/*.ts' 'packages/*/src/**/*.tsx' 'packages/*/app/**/*.ts' 'packages/*/app/**/*.tsx'",
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).split("\n").map((f) => f.trim()).filter(Boolean)
    .filter((f) => !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
} catch (err) {
  /* FAIL CLOSED: an unreadable file list means nothing was checked, which must not read as clean. */
  console.error(`check-move-target-literals: could not list files — ${err?.message ?? err}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error("check-move-target-literals: file list is EMPTY — refusing to report on zero files.");
  process.exit(1);
}

/** True when the statement enclosing `node` carries a DELIBERATE-LITERAL in its LEADING comments. */
function hasDeliberateMarker(node, source) {
  for (let cur = node; cur; cur = cur.parent) {
    const ranges = ts.getLeadingCommentRanges(source, cur.getFullStart()) ?? [];
    for (const r of ranges) {
      if (source.slice(r.pos, r.end).includes(DELIBERATE_MARKER)) return true;
    }
    if (ts.isStatement(cur)) break;
  }
  return false;
}

const byFile = {};
for (const file of files) {
  let source;
  try {
    source = readFileSync(join(REPO, file), "utf8");
  } catch {
    continue;
  }
  if (!source.includes("moveTask")) continue;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (MOVE_FNS.has(callee)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) && LEGACY_COLUMN_IDS.has(arg.text) && !hasDeliberateMarker(node, source)) {
            count += 1;
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  if (count > 0) byFile[file] = count;
}

const total = Object.values(byFile).reduce((a, b) => a + b, 0);
if (json) {
  console.log(JSON.stringify({ total, byFile }, null, 2));
  process.exit(0);
}

console.log(`check-move-target-literals: scanned ${files.length} source files`);
console.log(`  moveTask targets that are legacy column literals: ${total}`);
for (const [file, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)}  ${file}`);
}
if (total === 0) {
  console.log("  POPULATION EMPTY — #3150 measured 31 here; a wrong target THROWS rather than no-ops,");
  console.log("  so keep it empty. Use resolveTaskLifecycleColumns / the role helpers for destinations.");
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : { byFile: {} };
if (updateBaseline) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ byFile }, null, 2)}\n`);
  console.log("check-move-target-literals: baseline re-recorded.");
  process.exit(0);
}
if (!strict) process.exit(0);

const allowed = baseline.byFile ?? {};
const problems = [];
for (const [file, n] of Object.entries(byFile)) {
  const cap = allowed[file] ?? 0;
  if (n > cap) problems.push(`  ${file}: ${n} legacy move target(s), baseline allows ${cap}`);
}
for (const [file, cap] of Object.entries(allowed)) {
  const n = byFile[file] ?? 0;
  if (n < cap) problems.push(`  ${file}: ${n} legacy move target(s), baseline allows ${cap} — DROP, re-record it`);
}
if (problems.length > 0) {
  console.error("\ncheck-move-target-literals --strict: move-target population DIVERGES from baseline:\n");
  console.error(problems.join("\n"));
  console.error("\nA legacy move TARGET is rejected on a renamed board (TransitionRejectionError: unknown-column),");
  console.error("so this is a runtime throw rather than a silent no-op. Resolve the destination through the role");
  console.error("helpers, or add a leading DELIBERATE-LITERAL comment if the legacy id is genuinely the point");
  console.error("(the #1411 recoveryRehome safe-landing path). If a count went DOWN, re-record with");
  console.error("--strict --update-baseline in the same commit.\n");
  process.exit(1);
}
console.log("check-move-target-literals --strict: every file matches its baseline exactly.");
process.exit(0);

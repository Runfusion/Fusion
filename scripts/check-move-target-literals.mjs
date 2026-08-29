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

export function destinationLiterals(expr) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isConditionalExpression(expr)) {
    return [...destinationLiterals(expr.whenTrue), ...destinationLiterals(expr.whenFalse)];
  }
  if (ts.isParenthesizedExpression(expr)) return destinationLiterals(expr.expression);
  /*
  FNXC:MoveTargetRatchet 2026-07-31-19:25 (u12 — CAST yes, FALLBACK deliberately no):
  Columns are typed `ColumnId`, so `moveTask(id, "done" as ColumnId)` is the NATURAL spelling wherever
  the parameter is nominally typed. It was invisible until now, which left the gate weakest exactly
  where this codebase is most likely to write a literal.

  `??` / `||` / `&&` are NOT unwrapped, and that is a decision rather than an omission. I added them,
  ran the tree, and they flagged this:

      moveTask(id, (await resolveTaskLifecycleColumns(store, id))?.complete ?? "done", ...)

  which is the fail-soft idiom the whole conversion programme is built on — resolve, and fall back to
  the legacy id when the workflow is unreadable, exactly as the role helpers degrade. A gate that
  demands a DELIBERATE-LITERAL marker on every safe fallback teaches people to sprinkle markers, and a
  marker applied by habit is how the next real literal walks through.

  So the legacy id AFTER `??` is the SAFE shape and stays unflagged; a legacy id as the WHOLE
  destination is the unsafe one and is caught. If a fallback ever needs auditing it wants its own
  report, not this ratchet's exit code.
  */
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr) || ts.isTypeAssertionExpression?.(expr)) {
    return destinationLiterals(expr.expression);
  }
  return [];
}

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

/*
FNXC:MoveTargetRatchet 2026-08-01-04:24:
FN-8657 verified the production population at zero, but a zero-only test cannot prove the ratchet still
sees the throw-causing regression. Keep the AST walk callable with an in-memory fixture so tests prove a
literal destination is counted and that only a leading DELIBERATE-LITERAL can exempt it.

The audit found moveTaskInternal confined to moves.ts, its private enforcement point. We still scan it as
stronger-than-required defense-in-depth and pin that behavior here; external callers would not be invisible.
*/
export function countLegacyMoveTargetLiterals(source, file = "fixture.ts") {
  if (!source.includes("moveTask")) return 0;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let count = 0;
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (MOVE_FNS.has(callee)) {
        const destination = node.arguments[1];
        const hit = destination && destinationLiterals(destination).find((text) => LEGACY_COLUMN_IDS.has(text));
        if (hit && !hasDeliberateMarker(node, source)) count += 1;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return count;
}

/*
FNXC:MoveTargetRatchet 2026-07-31-19:05 (u12 — the scan ran on IMPORT, so the shape list could not be tested):
Everything below executed at module load and ended in `process.exit`, so importing this file to unit-test
`destinationLiterals` would have run the whole scan and killed the test process. That list has missed FOUR
spellings across three rounds, each found by hand against a throwaway probe file and then discarded,
because there was nowhere to put a regression.

Behaviour-preserving: the CLI body is unchanged, only wrapped so it runs when this file is the entry point
and not when imported. The two pure helpers are hoisted above it and `destinationLiterals` is exported.
*/
const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  let files;
  try {
    files = execSync(
      /*
      FNXC:MoveTargetRatchet 2026-07-31-22:30 (#3254's finding, same blind spot here):
      `--cached --others --exclude-standard` so a BRAND-NEW file is visible before it is committed.
      Plain `git ls-files` lists TRACKED files only, so a new file with `moveTask(id, "done")` scored
      0 locally and flipped the ratchet the moment it was staged — the author sees a green gate, then
      CI disagrees. Changes nothing in CI (nothing is untracked there) and nothing for the tracked
      population; it only makes the local reading honest. #3254 made the same change to the census.
      */
      "git ls-files --cached --others --exclude-standard 'packages/*/src/**/*.ts' 'packages/*/src/*.ts' 'packages/*/src/**/*.tsx' 'packages/*/app/**/*.ts' 'packages/*/app/**/*.tsx'",
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ).split("\n").map((f) => f.trim()).filter(Boolean)
      /* A path can appear under both --cached and --others in some index states; scanning it twice
         would double-count its hits against a baseline that expects one. */
      .filter((f, i, all) => all.indexOf(f) === i)
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

  const byFile = {};
  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(REPO, file), "utf8");
    } catch (error) {
      /* FNXC:MoveTargetRatchet 2026-07-31-23:55 (#3246 review): an unreadable tracked file made the
         count silently short, and this count is a claim about the whole tree. Fail closed. */
      console.error(`check-move-target-literals: cannot read tracked file ${file}: ${error?.message ?? error}`);
      console.error("check-move-target-literals: refusing to report a count that may be short.");
      process.exit(2);
    }
    const count = countLegacyMoveTargetLiterals(source, file);
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

}

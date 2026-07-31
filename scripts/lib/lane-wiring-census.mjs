/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:10:
Count CALL SITES that do not pass a resolved-lane argument to a function that accepts one.

WHY THIS EXISTS, and why it is a census rather than a guard.

`unwired-lane-parameter.mjs` catches a parameter that reaches NO caller. It is deliberately satisfied
by a mention anywhere, so PARTIAL wiring — some call sites pass the lane answer, others do not — is
invisible to it. Three defects reached `main` through that gap in one day:

  #2956  getInReviewStallReason wired at 0 of its 4 call sites while its two siblings were wired
  #2963  both merge entry points unwired -> "Cannot merge FN-x: task is in 'signoff', must be in
         'in-review'" — merging was impossible on a board with a renamed review lane
  #2964  merge-confirmed finalization unwired -> ALREADY-LANDED work parked `failed`

Each was a fix that added an optional parameter without the call-site sweep that has to follow it.

NOT A HARD GUARD, on purpose. Auditing the seven sites this finds showed FOUR were legitimately
unwired: `skipColumnIdentityCheck` callers have already proven lane identity by a stronger means, a
sentinel-column caller wants the identity check satisfied by construction, and a dead export has no
caller to wire. A check failing on all of them would be ~57% false positives, and the sibling guard's
header says why that is worse than a miss: it teaches people to disable the check.

So this ratchets like the lifecycle census: a baseline of known-unwired sites that may only shrink. A
NEW unwired call site raises the count and fails; wiring one lowers it and re-records. The recurrence —
adding a caller without the lane answer — is the thing caught.
*/
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Lane-answer argument names, kept in step with unwired-lane-parameter.mjs. */
export const LANE_ARGUMENT_NAMES = new Set([
  "reviewColumns",
  "terminalColumns",
  "completeColumns",
  "activeColumns",
  "escalationColumns",
  "columnFlags",
  "isReviewColumn",
  "isWipColumn",
  "holdColumn",
]);

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/**
 * Exported functions that ACCEPT a lane argument, as `name -> Set(argument names)`.
 *
 * Exported only: an internal helper's callers are all in one file and visible without a tool.
 */
export function findLaneAcceptingFunctions(files) {
  const accepting = new Map();
  for (const file of files) {
    const sf = parse(file);
    ts.forEachChild(sf, (node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name) return;
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      const names = new Set();
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name) && LANE_ARGUMENT_NAMES.has(param.name.text)) names.add(param.name.text);
        if (param.type && ts.isTypeLiteralNode(param.type)) {
          for (const member of param.type.members) {
            if (member.name && ts.isIdentifier(member.name) && LANE_ARGUMENT_NAMES.has(member.name.text)) {
              names.add(member.name.text);
            }
          }
        }
      }
      if (names.size > 0) accepting.set(node.name.text, names);
    });
  }
  return accepting;
}

/** Call sites of those functions that pass none of the accepted lane arguments. */
export function findUnwiredCallSites(files, accepting) {
  const unwired = [];
  for (const file of files) {
    const sf = parse(file);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const accepted = accepting.get(node.expression.text);
        if (accepted) {
          const passes = node.arguments.some((arg) =>
            ts.isObjectLiteralExpression(arg)
            && arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && accepted.has(p.name.text)));
          if (!passes) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            unwired.push({ file, line: line + 1, fn: node.expression.text });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return unwired;
}

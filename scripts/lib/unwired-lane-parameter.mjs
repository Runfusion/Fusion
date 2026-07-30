/*
FNXC:WorkflowLifecycleColumns 2026-07-31-16:40:
Find lane-resolution parameters that NO production caller supplies.

WHY THIS EXISTS. The lifecycle-column program repeatedly shipped a conversion shaped like this:

    export function isSomething(task, reviewColumns?: ReadonlySet<string>) {
      return reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review";
    }

…and then never passed `reviewColumns` from the production caller. The census counts the site as
converted (the literal is behind a documented fallback), every test passes (they inject the value by
hand), and production keeps the legacy behaviour. Measured: FIVE such parameters were live on `main`
at once, and auditing them found that in FOUR the parameter was unreachable because the CALLER held a
larger defect — a query for a column the board does not have, a count that was always zero, a store
read returning archived rows as open work.

Two workers found this class independently (#2787's review and #2799), which is the argument for
detecting it mechanically instead of by sweep. Unlike the census, the shape IS statically decidable:
an exported declaration has an optional parameter whose name is lane-shaped, and no file anywhere
mentions that name as an argument.

DELIBERATELY CONSERVATIVE. It only reports a parameter when:
  - the declaration is exported (an internal helper's callers are all in-file and easy to see);
  - the parameter is optional (a required one cannot be silently skipped);
  - the name matches the lane vocabulary this program actually uses;
  - and NO file in the scanned set mentions that name outside the declaring file.

The last condition is deliberately loose — a mention is enough. A guard that argues about how a value
reaches a call site would produce false positives, and a false positive here costs more than a miss:
it teaches people to disable the check.
*/

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/**
 * Parameter names this program uses for a resolved lane answer.
 *
 * A NAME list rather than a type check on purpose: the same fact is spelled `ReadonlySet<string>`,
 * `ColumnRoleFlags`, `boolean` and `(task) => boolean` across the packages, so the type tells you
 * less than the name does. Adding a name here is how a new convention opts into the guard.
 */
export const LANE_PARAMETER_NAMES = [
  "activeColumns",
  "columnFlags",
  "columnFlagsByColumnId",
  "columnFlagsByName",
  "completeColumns",
  "completeColumnsByTaskId",
  "escalationColumns",
  "flagsByColumnId",
  "holdColumn",
  "isReviewColumn",
  "isWipColumn",
  "reviewColumns",
  "satisfactionColumnsByTaskId",
  "terminalColumns",
  "terminalColumnsByTaskId",
];

const LANE_PARAMETER_SET = new Set(LANE_PARAMETER_NAMES);

function isExported(node) {
  const modifiers = node.modifiers ?? [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Declarations whose parameters are worth checking: exported functions and exported interfaces. */
function collectLaneParameters(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];

  const recordParam = (param, ownerName) => {
    if (!param.name || !ts.isIdentifier(param.name)) return;
    if (!LANE_PARAMETER_SET.has(param.name.text)) return;
    /* Only OPTIONAL parameters can be silently skipped; a required one fails to compile. */
    if (!param.questionToken && !param.initializer) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(param.getStart(sourceFile));
    found.push({ file: filePath, line: line + 1, parameter: param.name.text, owner: ownerName });
  };

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-01:20:
  An INLINE options-object type is the third spelling of the same declaration, and the guard was
  blind to it — the blind spot found by an actual escape, not by inspection.

      export function diffSnapshots(
        prev, next,
        opts: { notifyOnColumns: ReadonlySet<ColumnId>; completeColumnsByTaskId?: ReadonlyMap<...> },
      )

  `completeColumnsByTaskId` is in the name list, is optional, is exported, and is supplied by no
  file anywhere — the exact shape this module exists to report — and it sat on `main` unreported
  because the type is an anonymous `TypeLiteral` on the parameter rather than a named `interface`.
  Measured before the fix: the guard found 0 unwired parameters across 2114 files including this one.

  Walking the annotation makes the three spellings equivalent, which is the property the guard needs:
  whether a lane answer arrives as a bare parameter, an interface property, or an inline options
  field is a style choice, and a check that can be evaded by a style choice is decorative.
  */
  const recordInlineOptionsMembers = (param, ownerName) => {
    const annotation = param.type;
    if (!annotation || !ts.isTypeLiteralNode(annotation)) return;
    for (const member of annotation.members) {
      if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      if (!LANE_PARAMETER_SET.has(member.name.text)) continue;
      /* Optional only — a required field cannot be silently skipped. Same rule as a parameter. */
      if (!member.questionToken) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
      found.push({ file: filePath, line: line + 1, parameter: member.name.text, owner: ownerName });
    }
  };

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && isExported(node) && node.name) {
      for (const param of node.parameters) {
        recordParam(param, node.name.text);
        recordInlineOptionsMembers(param, node.name.text);
      }
    }
    /* An options-object property is the same fact wearing a different shape. */
    if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        if (!LANE_PARAMETER_SET.has(member.name.text)) continue;
        if (!member.questionToken) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
        found.push({ file: filePath, line: line + 1, parameter: member.name.text, owner: node.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * @param files absolute paths to scan (production sources; callers exclude tests)
 * @param readFile injected for testability
 * @returns declarations whose lane parameter is mentioned in no other file
 */
export function findUnwiredLaneParameters(files, readFile = (f) => readFileSync(f, "utf8")) {
  const sources = new Map();
  for (const file of files) sources.set(file, readFile(file));

  const declarations = [];
  for (const [file, source] of sources) declarations.push(...collectLaneParameters(file, source));

  return declarations.filter((declaration) => {
    for (const [file, source] of sources) {
      if (file === declaration.file) continue;
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-31-01:35:
      The mention must come from a file that also names the DECLARING symbol.

      The original rule — "the parameter name appears in any other file" — is unusable for any name
      that is also a common local variable, and I proved it on myself within one edit: renaming an
      unwired parameter from `completeColumnsByTaskId` to `completeColumns` made the guard go quiet
      immediately, because 15 unrelated production files happen to declare a local called
      `completeColumns`. The check had not been satisfied; it had been switched off by a rename.

      That is precisely the "evadable by a style choice" failure this module condemns, so the fix is
      the cause rather than a name blocklist: a file that never references `diffSnapshots` cannot be
      the thing that wires `diffSnapshots`'s options.

      Still deliberately loose — this is a co-occurrence test, not a call-graph analysis. It keeps
      the false-positive rate that makes the guard bearable while removing a false NEGATIVE that
      scaled with how ordinary the parameter's name was.
      */
      if (declaration.owner && !source.includes(declaration.owner)) continue;
      if (source.includes(declaration.parameter)) return false;
    }
    return true;
  });
}

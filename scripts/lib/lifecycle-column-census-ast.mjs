/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:20 (Phase C convergence — AST classifier):

WHY AN AST AND NOT A REGEX. Three people measured the remaining lifecycle-column work with three
greps and got three answers (6, 8, 12 role-bucket sites). A regex cannot tell a lifecycle-column
comparison from an agent role, a session purpose, a surface name, a step status, or a comment — so
no grep-derived number is authoritative, however careful the pattern. This module parses instead.

WHAT THE PARSER BUYS, concretely, over the text census next to it:
  - comments are not tokens, so prose about an old guard cannot be counted (the text version needed
    a comment stripper, and a bug in that stripper let ONE marker launder FOUR live guards);
  - the receiver is a real expression, so `t.column`, `live?.column`, `String(task.status)` and
    `tasks[i].column` all resolve without a hand-tuned pattern per shape;
  - sibling comparisons are found by walking the ENCLOSING expression rather than a line window, so
    a multi-line `||` chain is one unit and an unrelated line four rows away is not.

WHAT IT STILL CANNOT DO, stated plainly rather than implied: without a full type-checker program it
cannot prove a receiver is column-typed. So classification remains evidence-based — the receiver's
name plus the vocabulary its siblings use — and the three non-column classes are reported
SEPARATELY rather than netted, so a wrong classification is visible instead of silently changing
the bar. Two independent implementations agreeing on 12 role sites is the strongest evidence
available; one number from one grep is the weakest.

CLASSES (only the first is backlog):
  column      — a lifecycle-column guard.
  role        — AgentRole / session purpose / surface. Converting one is a real bug: the planner
                LANE is named `triage` and keeps that name; U11 removed the COLUMN.
  status      — StepStatus / mission / goal / feature status. `done`, `in-progress` and `archived`
                collide with column ids; `pending` and `skipped` never do.
  deliberate  — reviewed literal carrying a DELIBERATE-LITERAL marker in its leading comments.
*/

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** The legacy lifecycle column vocabulary — the ids that shipped as the builtin board. */
export const LEGACY_COLUMN_IDS = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

/** Receiver names that denote an agent role / lane rather than a task column. */
export const ROLE_RECEIVER_TOKENS = [
  "role", "agentType", "agent", "lane", "capability", "sessionPurpose", "surface", "purpose", "agentRole",
  /*
  FNXC:LifecycleColumnCensus 2026-07-29-20:50 (restores the pinned baseline):
  `outcome` names a RESULT enum, not a column. The one live instance is
  `deterministicReconcile.outcome === "archived"` — the verdict of a duplicate reconciliation, which
  happens to share a word with a column id.

  This is not a preference: the shipped classifier counted it, the pinned baseline did not, and that
  single site is the entire 22-vs-23 gap that has kept `--strict` RED on main since #2633 merged.
  So the baseline was recorded by a classifier that excluded it, and the exclusion was lost before
  the code shipped. Restoring it makes the instrument agree with its own pin rather than raising the
  pin to match a miscount — which would have quietly conceded a guard that does not exist.
  */
  "outcome",
];

/*
Values that belong to ONE vocabulary only, and therefore identify which vocabulary an expression is
matching regardless of what its variable is called. `AgentRole` is `triage | executor | reviewer |
merger` and `StepStatus` is `pending | in-progress | done | skipped`; the members below are never
column ids. This is the signal that caught `sessionPurpose` and `surface`, which a name list missed.
*/
const ROLE_ONLY_VALUES = new Set(["executor", "reviewer", "merger"]);
const STATUS_ONLY_VALUES = new Set(["pending", "skipped"]);

export const DELIBERATE_MARKER = "DELIBERATE-LITERAL";

const COMPARISON_KINDS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The name a comparison is made against: the property, the identifier, or the callee's argument. */
function receiverNameOf(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.getText();
  if (ts.isElementAccessExpression(node)) return receiverNameOf(node.expression);
  if (ts.isIdentifier(node)) return node.getText();
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return receiverNameOf(node.expression);
  }
  // `String(task.status)` / `normalize(col)` — the interesting name is the argument's.
  if (ts.isCallExpression(node) && node.arguments.length === 1) return receiverNameOf(node.arguments[0]);
  return "";
}

/** The string literal side of a comparison, if exactly one side is one. */
function literalOf(binary) {
  const left = binary.left;
  const right = binary.right;
  const leftIsLiteral = ts.isStringLiteralLike(left);
  const rightIsLiteral = ts.isStringLiteralLike(right);
  if (leftIsLiteral === rightIsLiteral) return undefined;
  return leftIsLiteral
    ? { literal: left.text, receiver: right }
    : { literal: right.text, receiver: left };
}

/**
 * The outermost expression this comparison participates in, so a multi-line `||` chain is examined
 * as ONE unit. A line window cannot express that: it both misses long chains and pulls in
 * unrelated neighbours.
 */
function enclosingExpression(node) {
  let current = node;
  while (
    current.parent
    && (ts.isBinaryExpression(current.parent)
      || ts.isParenthesizedExpression(current.parent)
      || ts.isPrefixUnaryExpression(current.parent)
      || ts.isConditionalExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/** Every string literal compared against `receiverName` inside `scope`. */
function siblingLiteralsFor(scope, receiverName) {
  const values = new Set();
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && COMPARISON_KINDS.has(node.operatorToken.kind)) {
      const parts = literalOf(node);
      if (parts && receiverNameOf(parts.receiver) === receiverName) values.add(parts.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return values;
}

/** True when a DELIBERATE-LITERAL marker appears in the comments attached above this node. */
function hasDeliberateMarker(sourceFile, node) {
  const fullText = sourceFile.getFullText();
  /*
  Walk every ANCESTOR, not just the enclosing statement. The real markers in this codebase sit above
  the enclosing FUNCTION (`legacyDependencySatisfied` in hold-release.ts is the case that caught
  this) while the comparison is a return statement inside it — so a statement-only lookup found
  nothing and silently reclassified three reviewed literals as backlog.

  Ancestor scope is also the right SEMANTICS, and strictly tighter than the line window it replaces:
  a marker excuses the construct it is attached to and everything inside it, and nothing else. The
  window version excused whatever happened to be within twelve lines.
  */
  let current = node;
  while (current && !ts.isSourceFile(current)) {
    const ranges = ts.getLeadingCommentRanges(fullText, current.getFullStart()) ?? [];
    if (ranges.some((range) => fullText.slice(range.pos, range.end).includes(DELIBERATE_MARKER))) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/*
FNXC:LifecycleColumnCensus 2026-07-29-19:20 (query-filter category):

A guard is not the only way a legacy column id decides behaviour. `listTasks({ column: "todo" })`
is a SOURCE QUERY: it selects the rows a sweep will consider, and on a board that renamed or merged
that column it returns nothing — so a sweep whose per-task predicate was correctly converted still
does nothing, and looks converted while being dead. `self-healing.ts:2849` names the pairing in
prose, and #2560 had to repair exactly that combination after a converted predicate was left with a
literal query. One measured consequence: `recoverStuckMergeDeadlocks` cannot see a renamed board at
all (proven on a live store: the renamed rows exist and none appear in its three-literal union).

The comparison walk cannot see these — a PropertyAssignment is not a BinaryExpression — so they
were invisible to the census and to its ratchet, meaning the class could grow silently.

COUNTED SEPARATELY, deliberately. `totals.column` and the per-column/per-file backlog are left
byte-identical, so the completion bar ("triage guards to 0") keeps its existing meaning and the
pinned baseline does not move. This adds a second, independently pinned number.

DEFINITIONS ARE NOT QUERIES. Workflow IR graph nodes carry `column:` to declare where a node lives
(`{ id: "review", kind: "...", column: "in-review" }`), which is the lineage DEFINING itself — the
builtin IR files hold ~32 of these. Converting one would be nonsense. They are told apart
structurally rather than by filename: a definition's object literal also carries `id:` or `kind:`,
a query's does not.
*/
function classifyColumnProperty(node) {
  const object = node.parent;
  if (!object || !ts.isObjectLiteralExpression(object)) return "query";
  const hasDefinitionSibling = object.properties.some(
    (property) =>
      property !== node
      && ts.isPropertyAssignment(property)
      && ts.isIdentifier(property.name)
      && (property.name.text === "id" || property.name.text === "kind"),
  );
  return hasDefinitionSibling ? "definition" : "query";
}

/** True for a `column: "<legacy id>"` property assignment. */
function columnPropertyLiteral(node) {
  if (!ts.isPropertyAssignment(node)) return undefined;
  const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
  if (name !== "column") return undefined;
  if (!ts.isStringLiteral(node.initializer)) return undefined;
  return LEGACY_COLUMN_IDS.includes(node.initializer.text) ? node.initializer.text : undefined;
}

/** Parse one file and classify every comparison against a legacy column id. */
export function findComparisons(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && COMPARISON_KINDS.has(node.operatorToken.kind)) {
      const parts = literalOf(node);
      if (parts && LEGACY_COLUMN_IDS.includes(parts.literal)) {
        const receiver = receiverNameOf(parts.receiver);
        const siblings = siblingLiteralsFor(enclosingExpression(node), receiver);
        const isRole = ROLE_RECEIVER_TOKENS.includes(receiver)
          || [...siblings].some((value) => ROLE_ONLY_VALUES.has(value));
        const isStatus = /status/i.test(receiver)
          || [...siblings].some((value) => STATUS_ONLY_VALUES.has(value));
        const deliberate = hasDeliberateMarker(sourceFile, node);
        findings.push({
          file: filePath,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          columnId: parts.literal,
          receiver,
          kind: deliberate ? "deliberate" : isRole ? "role" : isStatus ? "status" : "column",
        });
      }
    }
    const columnProperty = columnPropertyLiteral(node);
    if (columnProperty) {
      findings.push({
        file: filePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        columnId: columnProperty,
        receiver: "column",
        kind: hasDeliberateMarker(sourceFile, node) ? "deliberate" : classifyColumnProperty(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return findings;
}

/** Aggregate findings into the four headline counts plus per-file and per-column breakdowns. */
export function summarize(findings) {
  const totals = { column: 0, role: 0, status: 0, deliberate: 0 };
  const byColumnId = {};
  const byFile = new Map();

  /*
  Kept OUT of `totals` on purpose. `totals` is a published shape: the baseline file, the reporter,
  and other workers' in-flight PRs all read it, and the completion bar is defined against
  `totals.column`. Growing that object would move a number people are mid-way through driving to
  zero. The property-assignment counts are a second, independent instrument and live beside it.
  */
  const properties = { query: 0, definition: 0 };
  const queryByFile = new Map();
  const queryByColumnId = {};

  for (const finding of findings) {
    if (finding.kind === "query" || finding.kind === "definition") {
      properties[finding.kind] += 1;
      if (finding.kind === "query") {
        queryByColumnId[finding.columnId] = (queryByColumnId[finding.columnId] ?? 0) + 1;
        queryByFile.set(finding.file, (queryByFile.get(finding.file) ?? 0) + 1);
      }
      continue;
    }
    totals[finding.kind] += 1;
    if (finding.kind !== "column") continue;
    byColumnId[finding.columnId] = (byColumnId[finding.columnId] ?? 0) + 1;
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  }

  return {
    totals,
    byColumnId,
    byFile: [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    properties,
    queryByColumnId,
    queryByFile: [...queryByFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** Read + census a list of files. Callers own enumeration so this stays pure and testable. */
export function censusFiles(files, readFile = (f) => readFileSync(f, "utf8")) {
  return files.flatMap((file) => findComparisons(file, readFile(file)));
}

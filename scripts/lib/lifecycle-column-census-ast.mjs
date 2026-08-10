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

FOREIGN VOCABULARIES (audited 2026-07-30, batch-cli-plugins).

  The `status` category above catches a foreign enum reached through a PROPERTY (`step.status`,
  `feature.status`). It cannot catch one held in a BARE VARIABLE — `if (next === "archived")`, where
  `next` is a ReportStatus — because the receiver name carries no type information. Those land in the
  `column` backlog and read as unconverted lifecycle guards.

  Do NOT convert them: resolving a report's status against a task workflow is a category error. Mark
  the site DELIBERATE-LITERAL with the owning vocabulary named, as the reports plugin now does.

  Measured scope, so nobody re-hunts this: a full receiver-level audit of all 392 column-category
  sites found exactly 3 such false positives, all in `plugins/fusion-plugin-reports` (`next`, a
  ReportStatus), and all now marked. Every other receiver sampled — `to`, `from`, `column`,
  `fromColumn`, `toColumn`, `latestColumn`, `state`, `preArchiveColumn` — resolved to a genuine task
  column. Bare `status`/`currentStatus`/`liveStatus` step comparisons are correctly excluded already
  (`merge-queue-ops.ts` counts 1 of its 11 literals, and that 1 is the real `.column` guard).

  The backlog number is therefore real. Treat a surprising count as work, not as noise.
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
  /* FNXC:LifecycleColumnCensus 2026-08-10-06:00: Workflow work items persist the triage/executor/reviewer/merger role vocabulary. */
  "workflowRole",
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-22:00 (fleet phase — the work order was sending workers at
  non-columns):
  EVENT/RESULT DISCRIMINATORS, not columns. Found while claiming TaskDetailModal.tsx, whose census
  entry included `session.agentState === "done"` — an agent state, not a lane. Auditing every
  receiver the classifier currently counts surfaced four more of the same shape:

    event.type === "done"        register-chat-routes.ts   — an SSE event type
    mode === "done"              useTaskDiffStats.ts       — a cache-key mode
    evidence.kind === "done"     async-mission-store.ts    — an evidence kind
    event.kind === "done"        telemetry-hub.ts          — a telemetry event kind

    Each shares a WORD with a column id and nothing else. Converting one asks the trait registry
    what lane an SSE event is in, which has no answer — the same failure class as converting
    `role === "triage"`, which this list already exists to prevent.

    `state` is deliberately NOT added: `state === "archived"` in audit-ops/comments-ops is a task's
    column reaching those functions under a shorter name, so it is a genuine guard. Checked rather
    than assumed, because excluding a real one silently lowers the bar.
  */
  "type", "mode", "kind", "phase", "agentState",
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
const STATUS_ONLY_VALUES = new Set([
  "pending", "skipped",
  /*
  FNXC:LifecycleColumnCensus 2026-07-29-21:40 (widen the sibling vocabulary, not the name list):
  Members of state/phase/result enums that are NEVER column ids. Each earns its place by a measured
  site whose siblings prove the vocabulary:

    stepState   { active, done }                                        DashboardLoader.tsx:123
    agentState  { busy, ready, starting, done }                         TaskDetailModal.tsx:339
    phase       { confirm, pushing, done }                              dashboard-tui/app.tsx:3139
    kind        { exhausted, existing, invalid-deleted, missing,        async-mission-store.ts:1175
                  nonterminal, stopped, done }

  Deliberately extending the VALUE vocabulary rather than the receiver-name list, because names are
  unreliable here and provably so: `state` looked like the same class but holds
  `await getLiveTaskColumn(...)` — a real column, correctly counted. A name rule would have deleted
  that guard from the backlog. The sibling signal is the mechanism that already caught
  `sessionPurpose` and `surface`.
  */
  "active", "busy", "ready", "starting", "confirm", "pushing",
  "exhausted", "existing", "invalid-deleted", "missing", "nonterminal", "stopped",
]);

export const DELIBERATE_MARKER = "DELIBERATE-LITERAL";

/*
FNXC:LifecycleColumnCensus 2026-07-31-21:20:
The membership/switch walks demand a POSITIVE column signal, unlike the `===` walk which counts
unless the receiver looks like a role or status. Measured reason: switch statements over event and
state enums routinely carry `case "done"` / `case "archived"`, so a count-unless-excluded rule
reported 7 guards of which 6 were `switch (eventName)`, `switch (state)` and `switch (event)`.
Landing that would have injected six phantom guards into a backlog the ratchet treats as zero.
*/
const COLUMN_RECEIVER_RE = /^(column|columnId|col)$/i;

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
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-19:10:
    A TERNARY ARM'S OWN MARKER WAS INVISIBLE, which is the position people actually use.

        flags
          ? flags.hold === true
          /* DELIBERATE-LITERAL — the no-metadata fallback. *\/
          : column === "in-progress";

    That comment sits before the `:` token, so it is the COLON's leading trivia, not the arm
    expression's — `getLeadingCommentRanges` at the arm's full start never sees it. The ancestor walk
    does not help either: the next ancestor is the ConditionalExpression, whose own leading comments
    are somewhere else entirely.

    Measured before fixing: `in-review-stall.ts` carried a marker in exactly this position and stayed
    on the backlog, and the only way to clear it was to restructure the code into a named set. That
    is the tool dictating shape rather than reading intent — and a marker that silently does nothing
    trains people to stop marking.

    Scoped to the span between the previous arm (or the condition) and this one, so it cannot pick up
    a comment belonging to anything else.
    */
    const parent = current.parent;
    if (parent && ts.isConditionalExpression(parent)) {
      const previousEnd = current === parent.whenFalse ? parent.whenTrue.end
        : current === parent.whenTrue ? parent.condition.end
        : undefined;
      if (previousEnd !== undefined && fullText.slice(previousEnd, current.getStart()).includes(DELIBERATE_MARKER)) {
        return true;
      }
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
/*
FNXC:LifecycleColumnCensus 2026-08-01-04:00:
A QUERY property is not always a READ, and the difference decides whether it is convertible.

`column:` sits in an options-shaped object for both a source query and a write, so the existing
definition-vs-query rule (below) cannot separate them — and the resulting single number reads as
"dead reads to convert" when it is not. Measured while converting this class: of the sites outside
`self-healing.ts`, the read-shaped ones are convertible and the rest are soft-delete TOMBSTONE writes
(`.set({ column: "archived", deletedAt, … })`) and synthetic in-memory literals.

Converting a tombstone write would be actively harmful: `getLiveTaskColumn` returns `"archived"` as a
SENTINEL for any soft-deleted row, so the write and the sentinel must agree. This is the same shape
as #2808's `recoveryRehome` moves — a class where some members must NOT be fixed, and the count alone
cannot tell you which.

REPORTED, NOT RATCHETED. `queryByFile` and the `QUERY filters` total stay byte-identical so the pinned
baseline does not move; this adds a breakdown beside them. A number that misleads is worth splitting
even when the pinned total must not change.
*/
function queryPropertyRole(node) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isCallExpression(cursor)) {
      const callee = cursor.expression;
      const name = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : ts.isIdentifier(callee) ? callee.text : undefined;
      if (name === undefined) return "other";
      /* Drizzle's `.set(...)` and `.values(...)` are writes; `listTasks`/`searchTasks` are reads. */
      if (name === "set" || name === "values" || name === "insert" || name === "update") return "write";
      if (/^(list|search|find|get|count)/i.test(name)) return "read";
      return "other";
    }
    if (ts.isVariableDeclaration(cursor) || ts.isReturnStatement(cursor)) return "other";
  }
  return "other";
}

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
  if (hasDefinitionSibling) return "definition";
  /*
  FNXC:LifecycleColumnCensus 2026-08-01-23:23:
  A typed `{ column: "todo" } as Pick<Task, "column">` is a synthetic in-memory stand-in for a
  missing task, not a query or mutation. Counting it as a query hid the distinction between an
  executable workflow-lane filter and a legacy-seeded fallback with no workflow to resolve.

  Keep this structural and narrow: an untyped object or a real task-create input remains a query so a
  nearby assertion cannot launder executable lane debt.
  */
  const assertedType = ts.isAsExpression(object.parent) || ts.isTypeAssertionExpression(object.parent)
    ? object.parent.type.getText()
    : "";
  return /\bPick\s*<\s*Task\s*,\s*["']column["']\s*>/.test(assertedType)
    ? "synthetic"
    : "query";
}

/** True for a `column: "<legacy id>"` property assignment. */
function columnPropertyLiteral(node) {
  if (!ts.isPropertyAssignment(node)) return undefined;
  const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
  if (name !== "column") return undefined;
  if (!ts.isStringLiteral(node.initializer)) return undefined;
  return LEGACY_COLUMN_IDS.includes(node.initializer.text) ? node.initializer.text : undefined;
}


/*
FNXC:LifecycleColumnCensus 2026-08-01-01:10:
A LEGACY LITERAL IN A FALLBACK BRANCH IS NOT BACKLOG. The converted shape across the dashboard is

    if (flags) return flags.hold === true || flags.countsTowardWip === true;
    return column === "todo" || column === "in-progress";      // <- reachable only without traits

and that second literal is CORRECT: it answers for callers that have no resolved column metadata, which is
the distinction `resolveLifecycleColumns` returns `undefined`-for-the-whole-struct to preserve. Counting it
as an unconverted guard tells a batch worker to convert code that is already converted — and "convert it"
there means deleting the only answer available when traits are absent.

MEASURED, which is why this is worth a class rather than a preference: a proximity scan for
"legacy literal near a role-resolved call" over the dashboard returned 19 hits and ZERO defects, every one
this shape. The same scan over the engine found two real defects (#2670, #2672) — and in BOTH the literal was
in a separate statement beside resolved data, not in a fallback branch. That is the whole difference, and it
is structural, so the parser can see it.

Reported as its own line rather than removed from the total: a fallback literal is still a literal, and the
day the trait path is unconditional it should be deleted. This distinguishes "not yet converted" from
"converted, with a documented degradation".
*/
const TRAIT_TEST_HINTS = [
  "flags", "Flags", "columnFlags", "lifecycle", "roles", "trait", "resolveColumnFlags", "columnHasFlag",
  "resolveLifecycleColumns", "intake", "hold", "countsTowardWip", "mergeOrchestration", "mergeBlocker",
];

/*
FNXC:LifecycleColumnCensus 2026-07-30-22:15 (the other half of the inverted-fallback miss):
A CAMEL-CASE SUFFIX CANNOT BE A HINT, so resolved-lane variables get their own rule.

A resolver that hoists its answer names it `completeLanes`, `activeLanes`, `reviewLanes`,
`archivedLanes` — the shape used across analytics, the glasses notifier and the GitHub tracking
classifier. Adding `Lanes` to the hint list does NOT work, and the reason is a fix rather than an
oversight: hints are word-bounded because the unbounded form once let `hold` match `threshold` and
`household`. `\bLanes\b` therefore cannot match inside `completeLanes`, where the boundary the
regex needs does not exist.

So the suffix is matched explicitly. It is narrow on purpose — an identifier ENDING in `Lanes` or
`Columns` — which covers the resolved-lane naming without reopening the substring problem: `planes`
does not end in `Lanes` (case-sensitive), and `columnsRendered` does not end in `Columns`.
*/
const RESOLVED_LANE_IDENTIFIER = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Lanes|Columns)\b/;

/*
FNXC:LifecycleColumnCensus 2026-07-30-10:40 (PR #2677 review — coderabbit):
HINTS MUST NOT MATCH INSIDE A LONGER IDENTIFIER. The leading class was `[.?\w]`, so the `hold`
hint matched `threshold`, `staleThreshold`, `household`, `stronghold`, `withhold` — and `flags`
matched `myflags`. Any branch testing an unrelated `threshold` was then read as testing resolved
trait data, which marks a live legacy guard as an already-converted fallback.

The `\w` was also REDUNDANT, which is why removing it costs nothing: the third alternative
`\bhold\b` already matches `flags.hold` and `flags?.hold`, because `.` is a non-word character
and so supplies the word boundary itself. The `\w` alternative added only the false positives.
*/
/** True when `text` reads as a test for resolved trait data rather than for a column name. */
function testsTraitData(text) {
  return TRAIT_TEST_HINTS.some((hint) => new RegExp(`[.?]${hint}\\b|\\b${hint}\\s*[?.]|\\b${hint}\\b`).test(text))
    && !new RegExp(`(===|!==)\\s*["'](${LEGACY_COLUMN_IDS.join("|")})["']`).test(text);
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-10:05 (PR #2677 review — greptile):
A RETURN TOKEN IS NOT TERMINATION. The early-return detector used to ask whether the `then`
branch CONTAINED the word `return` anywhere. A branch that only returns conditionally —
`if (flags) { if (x) return a; }` — satisfies that while still falling through, so the
literal after it is REACHABLE with traits present and is a live guard.

The misclassification runs in the dangerous direction: it removes a real guard from the
backlog the census is trusted to report, and it does so silently. This asks whether the
branch DEFINITELY terminates instead, which is a property of structure rather than of the
presence of a token.
*/
function alwaysTerminates(stmt) {
  if (!stmt) return false;
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) {
    const statements = stmt.statements ?? [];
    return statements.length > 0 && alwaysTerminates(statements[statements.length - 1]);
  }
  /* Only terminates when BOTH arms do — a missing else is exactly the fall-through case. */
  if (ts.isIfStatement(stmt)) {
    return alwaysTerminates(stmt.thenStatement) && alwaysTerminates(stmt.elseStatement);
  }
  return false;
}

/**
 * True when this comparison sits in the FALLBACK branch of a conditional whose test reads resolved
 * trait data — i.e. it is the documented answer for callers without traits, not an unconverted guard.
 */
/**
 * True when a condition asks "is the trait data ABSENT?" rather than "is it present?".
 *
 * Form only, deliberately: `=== undefined`, `== null`, `=== null` or a leading `!`. Anything else is
 * treated as a positive test, so an unrecognised spelling leaves the site COUNTED — the safe
 * direction for a backlog measurement, since over-counting sends a reader to a correct line while
 * under-counting hides a live guard.
 */
function isNegativeTraitTest(text) {
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-23:15 (#2874 review — greptile P2, "compound absence tests
  over-classify"): SIMPLE conditions only.

  The equality check was unanchored, so `completeLanes === undefined || forceLegacy` passed — and its
  second disjunct can select the true branch with lane data PRESENT, making the literal a live guard
  rather than a fallback. Marking a live line "already converted" is the direction that removes a real
  guard from the backlog, which is the failure this whole rule was added to stop doing.

  A compound condition is not something to reason about here: whether the literal is reachable with
  traits present depends on the other operand. Refusing them leaves those sites COUNTED, which is the
  safe answer for a measurement — over-counting sends a reader to a correct line, under-counting hides
  a live one.

  ANCHORING IS WHAT DOES THE WORK, not a separate compound check. I wrote one — `if (/[|&]{2}/) return
  false` — and mutation showed it was dead: `^...$` already refuses anything with an operand beside
  the comparison. A redundant guard carrying a comment that claims it is load-bearing is worse than no
  guard, because the next reader trusts it instead of the anchors.
  */
  return /^\s*[A-Za-z_$][\w.$?[\]"'`]*\s*(===|==)\s*(undefined|null)\s*$/.test(text.trim())
    || /^\s*!\s*[A-Za-z_$][\w.$?[\]"'`]*\s*$/.test(text.trim());
}

function isTraitFallback(node, sourceFile) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    const parent = current.parent;
    if (ts.isConditionalExpression(parent) && parent.whenFalse === current) {
      if (testsTraitData(parent.condition.getText(sourceFile))) return true;
    }
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-21:55 (an INVERTED fallback the census counted as backlog):
    THE LITERAL IS SOMETIMES THE `whenTrue` BRANCH, BECAUSE THE CONDITION ASKS THE QUESTION BACKWARDS.

    Only `cond ? trait : literal` was recognised. The other spelling is at least as common once a
    caller resolves its lanes up front:

      complete: completeLanes === undefined ? columnId === "done" : completeLanes.includes(columnId)

    That is `github-tracking-state.ts:245`, a fully converted resolver whose two degraded arms the
    census reports as unconverted debt. The consequence is not cosmetic: the census header says
    "0 are trait-fallback branches (already converted)" while sites of exactly that shape exist, so
    the remaining number reads higher than the remaining WORK and a reader chasing the backlog is
    sent to lines that are already correct.

    A NEGATIVE trait test plus the true branch is the same statement as a positive test plus the
    false branch. Recognising it needs the condition to be negative in FORM — `=== undefined`,
    `== null`, or a leading `!` — because a positive condition with the literal on the true side is a
    live guard, not a fallback, and must keep counting.

    IMMEDIATE PARENT ONLY (`current === node`), unlike the sibling rules that walk ancestors, and this
    is measured rather than cautious. With the walk, any literal ANYWHERE inside a block governed by a
    negative lane test was marked converted — including
    `step.status === "done" || step.status === "in-progress"` in
    `register-task-workflow-routes.ts:941`, a STEP-STATUS comparison that is not a column guard at
    all. Marking a live line "already converted" is the dangerous direction for a backlog measurement,
    so this rule only fires where the literal IS the ternary's true branch, which is the shape it was
    written for.
    */
    if (current === node && ts.isConditionalExpression(parent) && parent.whenTrue === current) {
      const condition = parent.condition.getText(sourceFile);
      /*
      The lane-suffix rule is applied HERE ONLY, not folded into `testsTraitData`. Widening that
      shared predicate fed the ancestor-walking rules too, and they promptly marked
      `step.status === "done" || step.status === "in-progress"` at
      `register-task-workflow-routes.ts:941` — a STEP-STATUS comparison, not a column guard — as an
      already-converted fallback. Measured, not hypothetical: the count went to 6 with two of them
      wrong. A widening that reaches rules it was not reasoned about is how a measurement quietly
      starts excusing live lines.
      */
      if (isNegativeTraitTest(condition)
        && (testsTraitData(condition) || RESOLVED_LANE_IDENTIFIER.test(condition))) return true;
    }
    if (ts.isIfStatement(parent)) {
      /*
      Two shapes count: the explicit `else`, and the EARLY-RETURN form — `if (flags) return ...;` followed by
      the literal as the next statement, which is how most of these are actually written. The early-return
      case is detected by looking at the preceding sibling statement rather than at an else branch.
      */
      if (parent.elseStatement === current && testsTraitData(parent.expression.getText(sourceFile))) return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const statements = parent.statements ?? [];
      const index = statements.indexOf(current);
      for (let i = index - 1; i >= 0 && i >= index - 2; i -= 1) {
        const prior = statements[i];
        if (ts.isIfStatement(prior)
          && prior.elseStatement === undefined
          && testsTraitData(prior.expression.getText(sourceFile))
          && alwaysTerminates(prior.thenStatement)) {
          return true;
        }
      }
    }
    current = parent;
  }
  return false;
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
          /*
          Advisory only — it never changes `kind`, so a wrong hint cannot move the bar. It exists so a batch
          worker can tell an unconverted guard from an already-converted site's documented fallback.
          */
          traitFallback: isTraitFallback(node, sourceFile),
        });
      }
    }
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-21:05 (the comparison walk has two more blind spots):
    MEMBERSHIP and SWITCH guards. `["done","archived"].includes(task.column)` and
    `switch (task.column) { case "todo": }` are lifecycle-column guards by any reading, and neither is
    a BinaryExpression — so the walk above could not see either. Measured with a staged probe file:
    of five guard forms injected, only the two `===`/`!==` ones moved the count.

    That mattered because the census PRINTS "a new guard cannot land silently" next to a zero. The
    claim was true only for the form it happened to parse; a worker converting a `===` chain into an
    array membership would have scored the conversion and kept the guard.

    ONE finding per site, not per legacy id: a single `.includes` over two column ids is one guard,
    and emitting two would inflate the backlog the moment this landed.

    Classification reuses the existing receiver/sibling logic, which is what keeps the one real
    membership site in the tree (`["queued","planning",...].includes(task.status ?? "")` in
    notification-service) classified as STATUS rather than a new column guard.
    */
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "includes" || node.expression.name.text === "indexOf")
      && ts.isArrayLiteralExpression(node.expression.expression)
      && node.arguments.length === 1) {
      const values = node.expression.expression.elements
        .filter((element) => ts.isStringLiteral(element))
        .map((element) => element.text);
      const legacy = values.find((value) => LEGACY_COLUMN_IDS.includes(value));
      if (legacy) {
        const receiver = receiverNameOf(node.arguments[0]);
        if (!COLUMN_RECEIVER_RE.test(receiver)) return ts.forEachChild(node, visit);
        const isRole = ROLE_RECEIVER_TOKENS.includes(receiver)
          || values.some((value) => ROLE_ONLY_VALUES.has(value));
        const isStatus = /status/i.test(receiver) || values.some((value) => STATUS_ONLY_VALUES.has(value));
        const deliberate = hasDeliberateMarker(sourceFile, node);
        findings.push({
          file: filePath,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          columnId: legacy,
          receiver,
          kind: deliberate ? "deliberate" : isRole ? "role" : isStatus ? "status" : "column",
          traitFallback: false,
        });
      }
    }

    if (ts.isSwitchStatement(node)) {
      const caseValues = node.caseBlock.clauses
        .filter((clause) => ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression))
        .map((clause) => clause.expression.text);
      const legacy = caseValues.find((value) => LEGACY_COLUMN_IDS.includes(value));
      if (legacy) {
        const receiver = receiverNameOf(node.expression);
        if (!COLUMN_RECEIVER_RE.test(receiver)) return ts.forEachChild(node, visit);
        const isRole = ROLE_RECEIVER_TOKENS.includes(receiver)
          || caseValues.some((value) => ROLE_ONLY_VALUES.has(value));
        const isStatus = /status/i.test(receiver) || caseValues.some((value) => STATUS_ONLY_VALUES.has(value));
        const deliberate = hasDeliberateMarker(sourceFile, node);
        findings.push({
          file: filePath,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          columnId: legacy,
          receiver,
          kind: deliberate ? "deliberate" : isRole ? "role" : isStatus ? "status" : "column",
          traitFallback: false,
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
        queryRole: queryPropertyRole(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return findings;
}

/** Aggregate findings into the four headline counts plus per-file and per-column breakdowns. */
export function summarize(findings) {
  /*
  FNXC:LifecycleColumnCensus 2026-08-01-01:55:
  Reported ALONGSIDE `totals`, not inside it. `totals` is the four-class contract other suites deep-equal, so
  adding a key there breaks assertions that are correctly strict about the shape — my first attempt did
  exactly that and failed two existing cases. An advisory number does not belong in the structure that
  defines the bar.
  */
  let traitFallbackCount = 0;
  const totals = { column: 0, role: 0, status: 0, deliberate: 0 };
  const byColumnId = {};
  const byFile = new Map();

  /*
  Kept OUT of `totals` on purpose. `totals` is a published shape: the baseline file, the reporter,
  and other workers' in-flight PRs all read it, and the completion bar is defined against
  `totals.column`. Growing that object would move a number people are mid-way through driving to
  zero. The property-assignment counts are a second, independent instrument and live beside it.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-09:00 (PR #2661 review — greptile P1):
  DELIBERATE counts are tracked PER FILE, not only as a repo total. A total lets an addition in one
  marked construct be offset by a removal in another and stay flat, and because deliberate findings
  are excluded from `byFile`, the newly exempt guard is invisible there too — so the gate passes with
  a new lifecycle-column guard. Per-file is the same shape `byFile` already uses for columns, and it
  makes offsetting edits visible because they land in different files.
  */
  const deliberateByFile = new Map();

  const properties = { query: 0, definition: 0, synthetic: 0 };
  const queryByFile = new Map();
  const queryByColumnId = {};
  /* Read / write / other split of the query class — reported, never ratcheted. */
  const queryRoles = { read: 0, write: 0, other: 0 };

  for (const finding of findings) {
    if (finding.kind === "query" || finding.kind === "definition" || finding.kind === "synthetic") {
      properties[finding.kind] += 1;
      if (finding.kind === "query") {
        queryByColumnId[finding.columnId] = (queryByColumnId[finding.columnId] ?? 0) + 1;
        queryByFile.set(finding.file, (queryByFile.get(finding.file) ?? 0) + 1);
        queryRoles[finding.queryRole ?? "other"] = (queryRoles[finding.queryRole ?? "other"] ?? 0) + 1;
      }
      continue;
    }
    totals[finding.kind] += 1;
    if (finding.kind === "column" && finding.traitFallback) traitFallbackCount += 1;
    if (finding.kind === "deliberate") {
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-10:00 (PR #2661 review — greptile P1, same class again):
      Keyed by FILE **and COLUMN ID**, not a per-file integer. A per-file aggregate is offset within a
      single file: remove one reviewed `todo` exemption, add a `in-review` one beside it, and the
      number never moves — so a fresh guard hides inside an existing marker.

      That is the third time this instrument has been defeated by an aggregate (repo total -> per file
      -> per file per column). Each step narrows what can offset silently. The residual is a same-file
      SAME-COLUMN swap, and that one is deliberate: two `todo` exemptions in one file are
      interchangeable by definition, so there is nothing a reviewer could act on.
      */
      const key = `${finding.file}\u0000${finding.columnId}`;
      deliberateByFile.set(key, (deliberateByFile.get(key) ?? 0) + 1);
    }
    if (finding.kind !== "column") continue;
    byColumnId[finding.columnId] = (byColumnId[finding.columnId] ?? 0) + 1;
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  }

  return {
    totals,
    /* Advisory, deliberately OUTSIDE `totals`: see the note on `summarize`. */
    traitFallbackCount,
    byColumnId,
    byFile: [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    deliberateByFile: [...deliberateByFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    properties,
    queryByColumnId,
    queryByFile: [...queryByFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    queryRoles,
  };
}

/** Read + census a list of files. Callers own enumeration so this stays pure and testable. */
export function censusFiles(files, readFile = (f) => readFileSync(f, "utf8")) {
  return files.flatMap((file) => findComparisons(file, readFile(file)));
}

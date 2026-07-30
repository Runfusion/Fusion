/*
FNXC:WorkflowCapacity 2026-07-28-22:30 (PR #2488 review — ratchet rebuilt):

WHY THIS IS AN AST CHECK AND NOT A REGEX.

The first version of this guard matched `?? DEFAULT_WORKFLOW_POOL_ID` on one line.
It therefore MISSED `?? "builtin:coding"` — the actual defect the whole change
exists to fix — and passed green on the reintroduced bug (verified, not assumed).
A guard that reports success without checking is worse than no guard, because it
stops anyone looking. The claim being made is structural ("no capacity pool id is
derived except through the resolver"), so it is checked structurally.

TWO COMPLEMENTARY RULES. Neither alone is sufficient:

  RULE 1 — THE SINK RULE (the one that catches the original defect).
  Every argument that flows into a capacity counter's `workflowId` must be
  `resolveCapacityPoolId(...)`, or a local whose initializer is that call. The
  original defect passed `effectiveWorkflowIdForMove`, a local initialized from a
  `??` literal — so this rule fires on it regardless of WHICH literal was used, on
  one line or twenty. This is the rule that expresses the real invariant: the
  banned thing is not a spelling, it is an underived value reaching the counter.

  RULE 2 — THE SENTINEL RULE (cheap, catches restatements of the convention).
  No `??` whose right-hand side is the pool sentinel — under ANY qualification
  depth (`X.Y.Z.DEFAULT_WORKFLOW_POOL_ID`) or as its raw string value
  ("__default-workflow__") — outside the module that owns the convention. Being
  AST-based, a fallback split across lines is the same node and is caught.

WHY `?? "builtin:coding"` IS NOT BANNED OUTRIGHT. That literal is the legitimate
default for a WORKFLOW id in ~8 places (scheduler's IR-resolution key,
task-creation, analytics). It is only a bug when it reaches a CAPACITY POOL, and
that distinction is exactly what Rule 1 encodes. Banning the spelling everywhere
would be cargo-culting the rule past the thing it protects, and would have to be
suppressed so often it would rot.

FAIL CLOSED. An unreadable or unparseable file is reported as a violation, never
skipped — "could not inspect" must not render as "inspected and clean", which is
the same failure shape as the regex that could not see the defect.
*/
import ts from "typescript";

/** The module that owns the convention; the resolver's own `??` lives here. */
export const CONVENTION_OWNER = "packages/core/src/workflow-capacity.ts";

/** The canonical resolver every pool-id derivation must go through. */
export const RESOLVER = "resolveCapacityPoolId";

/** Capacity counters whose `workflowId` input is a pool id. */
export const CAPACITY_SINKS = new Set([
  "countActiveInCapacitySlotAsync",
  "countActiveInCapacitySlotSync",
  "countActiveInCapacitySlot",
  "countCapacitySlot",
]);

/** `countCapacitySlot(allTasks, byTask, budgetColumns, workflowId, countPending)` */
const POSITIONAL_SINKS = { countCapacitySlot: 3 };

const SENTINEL_CONST = "DEFAULT_WORKFLOW_POOL_ID";
const SENTINEL_VALUE = "__default-workflow__";

/** Right-most name of a possibly-qualified reference, at any depth. */
function tailName(node) {
  let cur = node;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.name;
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

function isResolverCall(node) {
  return (
    node &&
    ts.isCallExpression(node) &&
    tailName(node.expression) === RESOLVER
  );
}

/** True when `expr` is the resolver call, or a local initialized from one. */
function isDerivedThroughResolver(expr, resolverLocals) {
  if (!expr) return false;
  if (isResolverCall(expr)) return true;
  if (ts.isIdentifier(expr)) return resolverLocals.has(expr.text);
  // `cond ? resolver(a) : resolver(b)` is still derived through the resolver.
  if (ts.isConditionalExpression(expr)) {
    return (
      isDerivedThroughResolver(expr.whenTrue, resolverLocals) &&
      isDerivedThroughResolver(expr.whenFalse, resolverLocals)
    );
  }
  if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isDerivedThroughResolver(expr.expression, resolverLocals);
  }
  return false;
}

/**
 * Analyse one source file.
 * @returns {Array<{file:string,line:number,rule:string,text:string}>}
 */
export function findViolationsInSource(file, text) {
  const violations = [];
  /*
  FNXC:WorkflowCapacity 2026-07-28-23:30 (PR #2488 review):
  Parse failure is detected via `parseDiagnostics`, NOT via a try/catch.
  `ts.createSourceFile` is error-TOLERANT: given `function )( {` it returns a
  source file carrying diagnostics rather than throwing, so the catch this
  replaced was unreachable and the "unparseable" rule could never fire. That made
  the guard's own fail-closed claim overstated in exactly the way this PR is
  about — a check advertising a capability it did not have. A file whose syntax
  did not parse yields a partial AST, so its `??` nodes and sink calls may simply
  be absent: reporting it clean would be reporting "not inspected" as "inspected".
  The defensive catch is kept for a genuine internal error, but detection is the
  diagnostics check.
  */
  let sf;
  try {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch (err) {
    return [{ file, line: 0, rule: "unparseable", text: `parser threw: ${String(err && err.message)}` }];
  }
  const parseErrors = sf.parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseErrors[0].messageText, " ");
    return [
      {
        file,
        line: 0,
        rule: "unparseable",
        text: `${parseErrors.length} syntax error(s), first: ${first} — a file that did not parse was NOT inspected`,
      },
    ];
  }

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const snippet = (node) => node.getText(sf).replace(/\s+/g, " ").slice(0, 140);

  // Locals whose initializer is a resolver call — collected first so a sink that
  // reads one is accepted regardless of declaration order within the file.
  const resolverLocals = new Set();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isDerivedThroughResolver(node.initializer, resolverLocals)) resolverLocals.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  // Second pass: a local initialized from another resolver local.
  collect(sf);

  const visit = (node) => {
    // ── RULE 2: sentinel restated in a `??` fallback ──────────────────────────
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      file !== CONVENTION_OWNER
    ) {
      const rhs = node.right;
      const isSentinelConst = tailName(rhs) === SENTINEL_CONST;
      const isSentinelValue = ts.isStringLiteral(rhs) && rhs.text === SENTINEL_VALUE;
      if (isSentinelConst || isSentinelValue) {
        violations.push({
          file,
          line: lineOf(node),
          rule: "sentinel-fallback",
          text: snippet(node),
        });
      }
    }

    // ── RULE 1: something underived reaching a capacity counter ───────────────
    if (ts.isCallExpression(node)) {
      const callee = tailName(node.expression);
      if (callee && CAPACITY_SINKS.has(callee)) {
        // Object-literal form: `count...({ workflowId: <expr> })`
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            if (tailName(prop.name) !== "workflowId") continue;
            if (!isDerivedThroughResolver(prop.initializer, resolverLocals)) {
              violations.push({
                file,
                line: lineOf(prop),
                rule: "unresolved-pool-into-capacity-sink",
                text: snippet(prop),
              });
            }
          }
        }
        // Positional form.
        const idx = POSITIONAL_SINKS[callee];
        if (idx !== undefined && node.arguments.length > idx) {
          const arg = node.arguments[idx];
          if (!isDerivedThroughResolver(arg, resolverLocals)) {
            violations.push({
              file,
              line: lineOf(arg),
              rule: "unresolved-pool-into-capacity-sink",
              text: snippet(arg),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return violations;
}

/**
 * @param {Array<{file:string, read:() => string}>} entries
 * @returns {Array<{file:string,line:number,rule:string,text:string}>}
 */
export function findViolations(entries) {
  const out = [];
  for (const entry of entries) {
    let text;
    try {
      text = entry.read();
    } catch (err) {
      // FAIL CLOSED: an uninspectable file is a violation, not a pass.
      out.push({
        file: entry.file,
        line: 0,
        rule: "unreadable",
        text: `could not read (${String(err && err.message)}) — a file that cannot be inspected must not report as clean`,
      });
      continue;
    }
    out.push(...findViolationsInSource(entry.file, text));
  }
  return out;
}

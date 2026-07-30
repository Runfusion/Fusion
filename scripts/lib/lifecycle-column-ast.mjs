/*
FNXC:LifecycleColumnCensus 2026-07-30-05:40 (the count dispute — a regex cannot classify):
AST-based detection and CLASSIFICATION of lifecycle-column comparisons. This replaces the regex the
comparison census used, because three independent greps produced three different numbers (6, 8, 12 for
the role bucket) and none of them was authoritative.

The reason is structural, not a matter of a better pattern: `triage` in this repo is a column id AND an
agent role AND a session purpose AND a surface name AND a prompt-template family. A regex sees
`x === "triage"` and cannot tell which. A ratchet that reports `role === "triage"` as a violation sends
the next person to convert working code — and can never reach zero, because those sites are correct.

So this walks binary expressions and classifies by the LEFT-HAND SIDE's trailing identifier:

  COLUMN        the tail is `col` or ends in `column` -> a lifecycle-column guard, the actual bar
  not-a-column  the tail names a known non-column dimension -> MUST NEVER be reported as a violation
  unknown       anything else -> reported separately for a human, never silently bucketed

`unknown` exists so the classifier cannot quietly absorb a site it does not understand. Measured today:
2 such sites (`c` in MissionControlPanel.tsx, `from` in executor.ts), both needing a human read.

Comments and string contents are handled by the parser, so no comment-stripping is needed and the
"substring matched text in a comment" defect is structurally impossible here.
*/
import ts from "typescript";

/*
HAND-RESOLVED unknowns. The classifier refuses to guess at a receiver it cannot place syntactically,
which is correct — but leaving a site permanently `unknown` means the bar has an asterisk. Each entry
here is a site someone READ, with the verdict and the reason, keyed on (file suffix, LHS text) rather
than a line number so a moved site falls back to `unknown` instead of silently keeping a stale verdict.

Measured 2026-07-30: two such sites in tree, and they went opposite ways — which is the argument for
reading them rather than picking a default.
*/
const RESOLVED_UNKNOWNS = [
  {
    file: "packages/engine/src/executor.ts",
    lhs: "from",
    kind: "COLUMN",
    reason:
      "`from` is a move's ORIGIN COLUMN. This is the planning-evacuation guard (FNXC:PlanningEvacuation) "
      + "that stops engine work when a card is pulled backward out of a planner lane. A real lifecycle "
      + "guard, so it COUNTS — the `.column`-anchored greps missed it and the bar was understated by one.",
  },
  {
    file: "packages/dashboard/app/components/command-center/MissionControlPanel.tsx",
    lhs: "c",
    kind: "not-a-column",
    reason:
      "An SDLC-funnel ALIAS TABLE: `c === \"triage\" || c === \"signal\" || c === \"backlog\"` maps many "
      + "vocabularies onto one display stage, with an explicit `other` bucket for unrecognised columns. "
      + "Presentation-layer categorisation, not a lifecycle decision — nothing branches on it, and "
      + "resolving it to a trait would drop the non-column aliases it exists to accept.",
  },
];

function resolveKnownUnknown(file, lhs) {
  return RESOLVED_UNKNOWNS.find((r) => file.endsWith(r.file) && r.lhs === lhs);
}

/** Trailing identifiers that name something OTHER than a lifecycle column. */
export const NON_COLUMN_TAILS = new Set([
  "role", "agenttype", "agent", "purpose", "sessionpurpose", "surface",
  "kind", "type", "seam", "template", "glyph", "name", "id",
]);

/** The trailing identifier of an expression: `task.column` -> "column", `cols[i]` -> "cols". */
export function tailName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isElementAccessExpression(node)) return tailName(node.expression);
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return tailName(node.expression);
  if (ts.isAsExpression(node)) return tailName(node.expression);
  return undefined;
}

export function classifyTail(tail) {
  if (!tail) return "unknown";
  const t = tail.toLowerCase();
  if (NON_COLUMN_TAILS.has(t)) return "not-a-column";
  if (t === "col" || t.endsWith("column")) return "COLUMN";
  return "unknown";
}

/**
 * Every `=== literal` / `!== literal` comparison in `source`, classified.
 * Handles either operand order, both quote styles, and any formatting — the parser does not care
 * where the newlines are, which is what made the regex version miss line-split comparisons.
 */
export function findColumnComparisons(file, source, literal) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      for (const [lhs, rhs] of [[node.left, node.right], [node.right, node.left]]) {
        if (ts.isStringLiteralLike(rhs) && rhs.text === literal) {
          const tail = tailName(lhs);
          const lhsText = lhs.getText(sf);
          let kind = classifyTail(tail);
          let resolvedReason;
          if (kind === "unknown") {
            const resolved = resolveKnownUnknown(file, lhsText);
            if (resolved) {
              kind = resolved.kind;
              resolvedReason = resolved.reason;
            }
          }
          found.push({
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            lhs: lhsText,
            tail,
            kind,
            ...(resolvedReason ? { resolvedByHand: resolvedReason } : {}),
          });
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

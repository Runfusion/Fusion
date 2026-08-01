/*
FNXC:WorkflowLifecycleColumns 2026-07-30-14:10 (Phase C convergence — the census, measured):

WHY THIS EXISTS. The workflow-owned-lifecycle program tracks its remaining work by grepping
`=== "triage"`. That number was wrong in both directions and by a wide margin, and both errors
cost real work:

  UNDER-COUNTING BY VOCABULARY. `triage` is ONE of six legacy column ids. Run this census for
  the current numbers; when it was first written it reported 1031 column guards across 1956
  source files — done 313, in-review 217, in-progress 201, archived 177, todo 83, triage 40.
  Every one is the same defect class: a lifecycle decision made by column NAME, which stops
  matching on a renamed board. Driving `triage` alone to zero addresses under 4% of it, and two
  files hold a quarter of the remainder (executor.ts 151, self-healing.ts 136).

  This tool is the authority on those numbers, not this comment: figures written into prose go
  stale silently, which is how a tracked count survived being wrong in three separate ways.

  UNDER-COUNTING BY RECEIVER. A pattern anchored on `column`/`toColumn`/`fromColumn` misses
  guards whose local was named for its role in the function. That is how three real guards in
  `executor.ts` — on `from` and `originColumn` — were absent from the tracked list while the
  card they stranded had its work already complete.

  OVER-COUNTING BY VOCABULARY COLLISION. `role === "triage"` and `agentType === "triage"`
  compare an AGENT ROLE. The planner lane is named `triage` and keeps that name; U11 removed
  only the COLUMN. Ten such sites were counted as un-migrated guards, and the "obvious" fix —
  renaming the role — silently empties the planner's prompt template.

WHAT THIS REPORTS, therefore, is four separate numbers rather than one: COLUMN guards (the real
backlog), ROLE comparisons, STATUS comparisons (step/mission/goal statuses that merely share the
names), and DELIBERATE-LITERAL sites (reviewed, with the reason recorded at the site). The last
three must NOT be converted, and each of them was silently inside the tracked figure.

REPORT-ONLY BY DEFAULT. `--strict` compares against a recorded baseline and fails when the
column-guard count RISES, which is the ratchet shape; it is not wired into the merge gate here,
because a thousand-site backlog cannot be a blocking check on the day it is first measured.
*/

import { readFileSync } from "node:fs";

/** The legacy lifecycle column vocabulary — the ids that shipped as the builtin board. */
export const LEGACY_COLUMN_IDS = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

/**
 * Receivers that name an AGENT ROLE / lane rather than a task column.
 *
 * `agent` is here because `AgentLogEntry.agent` holds the role that wrote the entry. If a
 * future field named `agent` holds a column, this classification is wrong for it — which is
 * the honest limitation of classifying by receiver name, and the reason the census reports
 * the two classes separately instead of silently netting them.
 */
export const ROLE_RECEIVER_TOKENS = [
  "role", "agentType", "agent", "lane", "capability", "sessionPurpose", "surface", "purpose", "agentRole",
];

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:30 (PR #2633 review follow-up):
A STRONGER SIGNAL THAN THE NAME LIST, because the name list is guesswork and was already wrong:
`skill-resolver.ts` compares `sessionPurpose` and `tool-availability.ts` compares `surface`, and
both were scored as column guards until they were found by hand. Names are unbounded.

The AgentRole vocabulary is `triage | executor | reviewer | merger`, and three of those four are
NEVER column ids. So an expression compared against `"executor"`, `"reviewer"` or `"merger"` in the
same neighbourhood is being matched against ROLES, whatever its variable is called. That is
structural rather than nominal, and it generalises to receivers nobody has thought of yet.

`triage` is the only member of both vocabularies, which is the entire reason this census exists.
*/
const ROLE_ONLY_SIBLING_VALUES = ["executor", "reviewer", "merger"];

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:10 (third colliding vocabulary — measured):
STATUS IS NOT A COLUMN, and this one is big: 182 of the 1030 sites this census first called column
guards compare an ENTITY STATUS. `StepStatus` is `pending | in-progress | done | skipped`; mission
features and goals carry their own `done`/`archived` statuses. So `step.status === "done"`,
`goal.status === "archived"` and `feature.status === "done"` were all counted as un-migrated
lifecycle guards, which inflated `done` (105 of 313) and `in-progress` (49 of 201) enormously.

Converting one of them would be worse than leaving it: asking "which column carries the complete
trait" about a STEP's status is a category error, and the step would stop being recognised as
finished.

Two signals, the same pair used for roles:
  - receiver NAME contains `status` (this is what `step.status` and `goal.status` look like);
  - STRUCTURAL: compared against a status-only value nearby. `pending` and `skipped` are StepStatus
    members and never column ids, so an expression matched against either is a status.
The structural half is what generalises; the name half is what catches the single-comparison sites
where no sibling value appears.
*/
const STATUS_ONLY_SIBLING_VALUES = ["pending", "skipped"];

/** Marker that records a reviewed, intentionally-unconverted literal at its own site. */
export const DELIBERATE_MARKER = "DELIBERATE-LITERAL";

/**
 * Strip comments so prose about a past bug is never counted as a live guard.
 *
 * Two of the tracked "guards" in `replan-target.ts` were comment prose describing a filter that
 * lives in another file. Line comments need the `m` flag, or a trailing `// … === "triage"` on a
 * code line survives.
 */
export function stripComments(source) {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-17:40 (PR #2633 review, greptile P1):
  BLANK the comment, keep its NEWLINES. Deleting a multi-line block comment outright shifted every
  following line, so `findComparisons` reported unrelated line numbers AND looked for the
  site-local DELIBERATE-LITERAL marker at the wrong offset — a marker could be missed and a
  reviewed literal counted as backlog, or the reverse. I had written this down as "over-counts,
  visible in the report", which was wrong in the more damaging direction: wrong line numbers send
  a reader to the wrong code.
  */
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

/** True when the marker appears within `window` lines above `index` (or on the line itself). */
function hasDeliberateMarker(originalLines, lineIndex, window = 12) {
  const start = Math.max(0, lineIndex - window);
  for (let i = start; i <= lineIndex; i += 1) {
    if (originalLines[i]?.includes(DELIBERATE_MARKER)) return true;
  }
  return false;
}

/** The receiver token immediately left of a comparison, e.g. `task.column` -> `column`. */
export function receiverOf(textBeforeOperator) {
  const match = /([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*$/.exec(textBeforeOperator.replace(/[)\]\s]+$/, ""));
  if (match) return match[1];
  const dotted = /([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(textBeforeOperator);
  return dotted ? dotted[1] : "";
}

/**
 * Classify and count every legacy-column comparison in one file's source.
 *
 * Returns findings rather than a bare count: a census that cannot say WHICH class a site
 * belongs to is the census this replaces.
 */
export function findComparisons(filePath, source) {
  const originalLines = source.split("\n");
  const stripped = stripComments(source);
  const strippedLines = stripped.split("\n");
  const findings = [];

  const pattern = new RegExp(
    `(===|!==)\\s*(["'])(${LEGACY_COLUMN_IDS.join("|")})\\2`,
    "g",
  );

  strippedLines.forEach((line, index) => {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(line)) !== null) {
      const receiver = receiverOf(line.slice(0, match.index));
      const columnId = match[3];
      /*
      `stripComments` blanks comments in place (PR #2633 review), so this index is the ORIGINAL
      line number and the marker lookup is exact. Before that fix a multi-line block comment
      shifted every following line and this lookup could miss a marker entirely.
      */
      const deliberate = hasDeliberateMarker(originalLines, index);
      const isRole = ROLE_RECEIVER_TOKENS.includes(receiver)
        || comparedAgainstSiblingValues(strippedLines, index, receiver, ROLE_ONLY_SIBLING_VALUES);
      const isStatus = /status/i.test(receiver)
        || comparedAgainstSiblingValues(strippedLines, index, receiver, STATUS_ONLY_SIBLING_VALUES);
      findings.push({
        file: filePath,
        line: index + 1,
        columnId,
        receiver,
        kind: deliberate ? "deliberate" : isRole ? "role" : isStatus ? "status" : "column",
      });
    }
  });

  return findings;
}

/**
 * True when `receiver` is compared against a role-only value (`executor`/`reviewer`/`merger`)
 * within a few lines — evidence that the expression holds an AGENT ROLE, not a column.
 *
 * A window rather than the same line, because these read as multi-line `||` chains:
 *   const purposeUsesRoleFallback = sessionPurpose === "triage"
 *     || sessionPurpose === "executor"
 */
function comparedAgainstSiblingValues(lines, lineIndex, receiver, values, window = 4) {
  if (!receiver) return false;
  const start = Math.max(0, lineIndex - window);
  const end = Math.min(lines.length - 1, lineIndex + window);
  for (let i = start; i <= end; i += 1) {
    for (const value of values) {
      const pattern = new RegExp(`\\b${receiver}\\b\\s*(?:===|!==)\\s*(["'])${value}\\1`);
      if (pattern.test(lines[i] ?? "")) return true;
    }
  }
  return false;
}

/** Aggregate findings into the three headline counts plus per-file and per-column breakdowns. */
export function summarize(findings) {
  const totals = { column: 0, role: 0, status: 0, deliberate: 0 };
  const byColumnId = {};
  const byFile = new Map();

  for (const finding of findings) {
    totals[finding.kind] += 1;
    if (finding.kind === "column") {
      byColumnId[finding.columnId] = (byColumnId[finding.columnId] ?? 0) + 1;
      const current = byFile.get(finding.file) ?? 0;
      byFile.set(finding.file, current + 1);
    }
  }

  return {
    totals,
    byColumnId,
    byFile: [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** Read + census a list of files. Callers own enumeration so this stays pure and testable. */
export function censusFiles(files, readFile = (f) => readFileSync(f, "utf8")) {
  return files.flatMap((file) => findComparisons(file, readFile(file)));
}

const ROLE_RESOLVER_NAMES = [
  "resolveLifecycleColumns", "resolveTaskLifecycleColumns", "resolveTerminalColumns", "resolveCompleteColumn",
  "resolveMergeOrchestrationColumn", "resolveReboundTarget", "columnsWithFlag", "workflowHasColumn",
  "isIntakeColumnRole", "isHoldColumnRole", "isWipColumnRole", "isReviewColumnRole", "isCompleteColumnRole",
  "isArchivedColumnRole", "isPreImplementationColumnRole", "resolveColumnFlags", "columnHasFlag",
];

/** Blank string/template literal CONTENTS, preserving quotes and newlines so offsets do not shift. */
export function stripStringLiterals(source) {
  return source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (match, quote) => {
    const inner = match.slice(1, -1).replace(/[^\n]/g, " ");
    return `${quote}${inner}${quote}`;
  });
}

/** Files where a role resolver is used AND legacy literals remain — both vocabularies live at once. */
export function mixedVocabularyFiles(byFile, readFile) {
  const mixed = [];
  for (const [file, count] of byFile) {
    if (count === 0) continue;
    let source;
    try {
      source = readFile(file);
    } catch {
      continue; // Unreadable file is not evidence of anything.
    }
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-22:10 (PR #2704 review — greptile):
    COMMENTS AND STRINGS ARE NOT USAGE. The first version searched raw source, so a resolver named
    only in a FNXC note, a doc comment, or an error message classified the file as mixed. This file
    is dense with prose that names these very functions, so the false-positive rate was structural
    rather than incidental — and a review signal that cries wolf gets ignored, which is the whole
    value gone. `stripComments` blanks comments while preserving newlines; string literals are
    blanked the same way so a message mentioning a resolver does not count as calling one.
    */
    const code = stripStringLiterals(stripComments(source));
    const resolvers = ROLE_RESOLVER_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
    if (resolvers.length > 0) mixed.push({ file, count, resolvers: resolvers.length });
  }
  return mixed.sort((a, b) => b.count - a.count);
}

/*
FNXC:LifecycleColumnCensus 2026-07-31-10:40 (u12 — extraction, no behavior change):
`FLAG_MARKERS` and the 40-line proximity window moved here VERBATIM from the CLI wrapper so the
deferral classification is reachable from `packages/engine/src/__tests__/lifecycle-column-census.test.ts`,
which imports this module. It was previously a private const plus an inline `.slice()` inside the CLI,
so the only way to exercise it was to run the whole script against the real tree — which is why the
rule had no test in either direction despite deciding what work the fleet is sent at.

Window is `[line-41, line)`: the 40 lines ABOVE the guard, excluding the guard's own line.
*/
export const FLAG_MARKERS = /FLAGGED|LEFT COUNTED|left counted|deliberately NOT converted|Recorded instead|Left as a literal|DELIBERATE-LITERAL|accurate debt|blocked on|NOT CONVERTED|not converted|do not convert|do NOT convert|STAYS INLINE|STILL A LITERAL|archived-column-gate-parity|non-renameable system column|SIZED, NOT|honest literal|honest about being one|would be inert|is inert|the two honest/;

/**
 * True when a guard at 1-indexed `line` carries a documented deferral note in the 40 lines above it.
 * `lines` is the file's source split on newlines.
 */
export function hasDeferralNote(lines, line) {
  return FLAG_MARKERS.test(lines.slice(Math.max(0, line - 41), line).join(" "));
}

/*
FNXC:LifecycleColumnCensus 2026-07-31-12:55 (u12 — the report went SILENT at the finish line):
The backlog-state verdict was two inline branches in the CLI, and neither fired at a count of ZERO —
`CONVERSION QUEUE EMPTY` required `totals.column > 0`. So the one state the whole fleet phase was
working toward printed nothing at all, which reads as a broken scan rather than the protected end
state. Reached zero on 2026-07-31 (722 at the start of the phase).

Pure and exported so all three states are unit-testable. Against the real tree only the CURRENT state
is observable, so an inline branch for zero could not be tested until the tree was already zero — and
a message nobody can test before they need it is the one that is wrong when they do.

Returns an array of lines (empty = print nothing), so the caller stays a dumb printer.
*/
export function describeBacklogState({ columnGuards, unexaminedGuards }) {
  if (columnGuards === 0) {
    return [
      "BACKLOG ZERO: no lifecycle-column guard remains.",
      "This is the protected end state, not an empty scan — `--strict` fails on any RISE, so a new",
      "guard cannot land silently. Use the role helpers (resolveLifecycleColumns / columnHasRole).",
    ];
  }
  if (unexaminedGuards === 0) {
    return [
      `CONVERSION QUEUE EMPTY: all ${columnGuards} remaining column guard(s) carry a documented deferral note.`,
      "There is no unexamined guard to claim. A nonzero backlog above is DEBT, not a work queue.",
      "Re-read the note at a site before converting it; run --claims to also check open-PR ownership.",
    ];
  }
  return [`${unexaminedGuards} unexamined guard(s) remain (no deferral note) — run --triage to list them by file.`];
}

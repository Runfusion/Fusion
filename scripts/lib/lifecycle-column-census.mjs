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

WHAT THIS REPORTS, therefore, is three separate numbers rather than one: COLUMN guards (the
real backlog), ROLE comparisons (not in scope, and must not be converted), and
DELIBERATE-LITERAL sites (reviewed, with the reason recorded at the site).

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
export const ROLE_RECEIVER_TOKENS = ["role", "agentType", "agent", "lane", "capability"];

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
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
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
      The comment-stripped text keeps line numbers only if block comments spanned whole lines,
      which is not guaranteed — so the DELIBERATE marker is looked up in the ORIGINAL lines at
      the same index, and the window is generous. A missed marker over-counts (visible in the
      report) rather than silently excusing a live guard.
      */
      const deliberate = hasDeliberateMarker(originalLines, index);
      const isRole = ROLE_RECEIVER_TOKENS.includes(receiver);
      findings.push({
        file: filePath,
        line: index + 1,
        columnId,
        receiver,
        kind: deliberate ? "deliberate" : isRole ? "role" : "column",
      });
    }
  });

  return findings;
}

/** Aggregate findings into the three headline counts plus per-file and per-column breakdowns. */
export function summarize(findings) {
  const totals = { column: 0, role: 0, deliberate: 0 };
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

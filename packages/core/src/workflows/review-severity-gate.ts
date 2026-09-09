/*
FNXC:ReviewSeverityGate 2026-08-10-17:33:
Review remediation loops were the dominant cost of task wall-clock: measured over 14 days, tasks with
>=5 post-review fix rounds were 22% of tasks but consumed 78% of all task active time, and 311 of 331
recorded review findings were spec-internal-consistency complaints ("Step 4 says X but Step 5 says Y",
"Surface Enumeration claims 13 but lists 15") rather than defects that change delivered behavior.
Every such finding forced a full REVISE bounce because the verdict token was taken at face value.

The fix is to make the ALREADY-PERSISTED `WorkflowReviewFinding.severity` field load-bearing instead of
decorative: a REVISE only blocks when it carries at least one finding at or above the review kind's
blocking threshold. Non-blocking findings are still parsed, persisted, and handed to the implementer —
they simply stop bouncing the task. This reduces churn at its source rather than truncating it with a
revision cap, which only converts a runaway loop into a hard stop.

Severity is mapped onto operator-facing priority labels (P0=critical, P1=high, P2=medium/low) so prompts
can speak in priorities without introducing a third severity vocabulary alongside this one and the
Compound Engineering skill's P0-P3 table.

FNXC:ReviewSeverityGate 2026-08-28-07:48:
A REVISE has blocking power only when it carries at least one actionable (open) finding. A finding-less
or all-resolved rejection cannot produce a remediation step, so blocking it would create an
unrepairable review loop. Open findings remain fail-closed on severity: an unclassified open finding
still blocks, while classified findings continue to respect the configured threshold.
*/

import type { WorkflowReviewFinding, WorkflowReviewFindingSeverity, WorkflowReviewKind } from "../types.js";
import { isOpenWorkflowReviewFinding } from "./workflow-step-results.js";

/**
 * Blocking threshold for a review gate. A severity value blocks at that level and above;
 * `"any"` restores the pre-gate behavior where every REVISE blocks regardless of severity.
 */
export type ReviewBlockingSeverity = WorkflowReviewFindingSeverity | "any";

export const REVIEW_BLOCKING_SEVERITIES = ["any", "low", "medium", "high", "critical"] as const;

export const PLAN_REVIEW_BLOCKING_SEVERITY_SETTING_ID = "planReviewBlockingSeverity";
export const CODE_REVIEW_BLOCKING_SEVERITY_SETTING_ID = "codeReviewBlockingSeverity";

/*
FNXC:ReviewSeverityGate 2026-08-10-17:33:
Defaults are asymmetric because the measured churn is asymmetric. Plan Review accounted for 185 recorded
prior attempts across 117 tasks in 14 days while Code Review recorded 0, so Plan Review blocks on P0+P1
(a plan defect that reaches implementation is expensive) while Code Review blocks on P0 only (its
findings land against real code the implementer can address inline or in a follow-up).
*/
export const DEFAULT_PLAN_REVIEW_BLOCKING_SEVERITY: ReviewBlockingSeverity = "high";
export const DEFAULT_CODE_REVIEW_BLOCKING_SEVERITY: ReviewBlockingSeverity = "critical";

const SEVERITY_RANK: Record<WorkflowReviewFindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Operator/prompt-facing priority label for a persisted severity. */
export const SEVERITY_PRIORITY_LABEL: Record<WorkflowReviewFindingSeverity, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P2",
};

const BLOCKING_SEVERITY_SETTING_BY_REVIEW_KIND: Record<WorkflowReviewKind, string> = {
  plan: PLAN_REVIEW_BLOCKING_SEVERITY_SETTING_ID,
  code: CODE_REVIEW_BLOCKING_SEVERITY_SETTING_ID,
};

const DEFAULT_BLOCKING_SEVERITY_BY_REVIEW_KIND: Record<WorkflowReviewKind, ReviewBlockingSeverity> = {
  plan: DEFAULT_PLAN_REVIEW_BLOCKING_SEVERITY,
  code: DEFAULT_CODE_REVIEW_BLOCKING_SEVERITY,
};

export function isReviewBlockingSeverity(value: unknown): value is ReviewBlockingSeverity {
  return typeof value === "string" && (REVIEW_BLOCKING_SEVERITIES as readonly string[]).includes(value);
}

export interface ResolveReviewBlockingSeverityInput {
  reviewKind: WorkflowReviewKind;
  /** Effective per-task workflow settings map (stored value ?? declaration default). */
  workflowSettings?: Record<string, unknown>;
  /** Authored node override, read from the review group's config. */
  nodeBlockingSeverity?: unknown;
}

/**
 * Resolve the blocking threshold for a review gate.
 *
 * Precedence mirrors {@link resolveOptionalReviewRevisionBudget}: a stored workflow setting wins first
 * so an operator can restore `"any"` per workflow, then an authored node value keeps custom-workflow
 * semantics, then the review kind's built-in default.
 */
export function resolveReviewBlockingSeverity({
  reviewKind,
  workflowSettings,
  nodeBlockingSeverity,
}: ResolveReviewBlockingSeverityInput): ReviewBlockingSeverity {
  const settingId = BLOCKING_SEVERITY_SETTING_BY_REVIEW_KIND[reviewKind];
  const stored = workflowSettings?.[settingId];
  if (isReviewBlockingSeverity(stored)) return stored;
  if (isReviewBlockingSeverity(nodeBlockingSeverity)) return nodeBlockingSeverity;
  return DEFAULT_BLOCKING_SEVERITY_BY_REVIEW_KIND[reviewKind];
}

/** True when a persisted review finding can produce remediation work. */
export function isActionableReviewFinding(finding: WorkflowReviewFinding): boolean {
  return isOpenWorkflowReviewFinding(finding);
}

/**
 * Whether a single finding blocks at the given threshold.
 *
 * An UNCLASSIFIED actionable finding always blocks — see the contract in the module header.
 */
export function isBlockingFinding(finding: WorkflowReviewFinding, threshold: ReviewBlockingSeverity): boolean {
  if (!isActionableReviewFinding(finding)) return false;
  if (threshold === "any") return true;
  if (!finding.severity) return true;
  return SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold];
}

export interface ReviewSeverityGateInput {
  verdict: string | undefined;
  findings: WorkflowReviewFinding[] | undefined;
  threshold: ReviewBlockingSeverity;
  /**
   * True when the finding list could not be read from the reviewer's response (for example a verdict
   * recovered from a malformed payload). An empty list then means "unknown", not "nothing blocking",
   * and a REVISE must never be downgraded on it.
   */
  findingsUnreadable?: boolean;
}

export interface ReviewSeverityGateResult<V = string | undefined> {
  /** The effective verdict after the gate. `REVISE` becomes `APPROVE_WITH_NOTES` when nothing blocks. */
  verdict: V;
  /** True only when a REVISE was downgraded by this gate. */
  downgraded: boolean;
  /** Findings at or above the threshold (empty on a downgrade, by construction). */
  blocking: WorkflowReviewFinding[];
  /** Findings below the threshold. Still persisted and still handed to the implementer. */
  advisory: WorkflowReviewFinding[];
  /** Audit-only receipts and superseded findings; never actionable. */
  resolved: WorkflowReviewFinding[];
}

/**
 * Apply the severity gate to a parsed review verdict.
 *
 * Only ever RELAXES a REVISE; it never promotes an APPROVE into a block, so a reviewer that approves
 * while attaching a critical finding is left alone (that combination is a reviewer contradiction the
 * gate has no authority to resolve, and escalating it here would make approval non-deterministic).
 */
export function applyReviewSeverityGate({ verdict, findings, threshold, findingsUnreadable }: ReviewSeverityGateInput): ReviewSeverityGateResult {
  const all = findings ?? [];
  const open = all.filter(isActionableReviewFinding);
  const resolved = all.filter((finding) => !isActionableReviewFinding(finding));
  const blocking = open.filter((finding) => isBlockingFinding(finding, threshold));
  const advisory = open.filter((finding) => !isBlockingFinding(finding, threshold));

  if (verdict !== "REVISE") return { verdict, downgraded: false, blocking, advisory, resolved };
  if (blocking.length > 0) return { verdict, downgraded: false, blocking, advisory, resolved };
  /*
  FNXC:ReviewSeverityGate 2026-09-05-22:54:
  FN-295: "no blocking finding" may only downgrade a REVISE when the finding list was actually READ.
  A verdict recovered from a malformed reviewer payload carries no findings because they could not be
  parsed — not because the reviewer raised none. Measured: a Plan Review returned REVISE with three
  `high` findings in a payload whose JSON was broken; the repair round replied `{"verdict":"REVISE"}`
  alone, the empty list read as "nothing blocking", and the card entered execution on a plan the
  reviewer had just rejected. Absent evidence is not evidence of absence: fail closed.
  */
  if (findingsUnreadable) return { verdict, downgraded: false, blocking, advisory, resolved };

  return { verdict: "APPROVE_WITH_NOTES", downgraded: true, blocking, advisory, resolved };
}

/**
 * Render findings for an agent-facing prompt, grouped by priority with explicit obligations.
 *
 * Shared by the remediation injection and the advisory carry-forward so the implementer sees one
 * consistent shape whether the review blocked or was downgraded.
 */
export function formatFindingsByPriority(findings: WorkflowReviewFinding[]): string {
  findings = findings.filter(isOpenWorkflowReviewFinding);
  if (findings.length === 0) return "";
  const groups: Array<{ label: string; obligation: string; severities: WorkflowReviewFindingSeverity[] }> = [
    { label: "P0 — must fix", obligation: "Fix every item in this group before returning.", severities: ["critical"] },
    {
      label: "P1 — should fix",
      obligation: "Fix these unless you have a concrete reason not to. If you decline one, say which and why.",
      severities: ["high"],
    },
    {
      label: "P2 — optional",
      obligation: "Address only if cheap and clearly correct. Skipping these is expected and requires no justification.",
      severities: ["medium", "low"],
    },
  ];

  const sections: string[] = [];
  for (const group of groups) {
    const matching = findings.filter((finding) => finding.severity && group.severities.includes(finding.severity));
    if (matching.length === 0) continue;
    const items = matching.map((finding) => {
      const location = finding.filePath ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})` : "";
      return `- **${finding.title}**${location}\n  ${finding.body}`;
    });
    sections.push(`### ${group.label}\n${group.obligation}\n\n${items.join("\n")}`);
  }

  // Unclassified findings block (fail-closed), so present them with the strongest obligation.
  const unclassified = findings.filter((finding) => !finding.severity);
  if (unclassified.length > 0) {
    const items = unclassified.map((finding) => `- **${finding.title}**\n  ${finding.body}`);
    sections.push(`### Unclassified — treat as must fix\n${items.join("\n")}`);
  }

  return sections.join("\n\n");
}

/** Render audit receipts separately so implementers do not redo completed review work. */
export function formatResolvedFindings(findings: WorkflowReviewFinding[]): string {
  const resolved = findings.filter((finding) => !isOpenWorkflowReviewFinding(finding));
  if (resolved.length === 0) return "";
  const lines = resolved.map((finding) => {
    const location = finding.filePath ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})` : "";
    return `- **${finding.title}**${location} [${finding.resolution}]\n  ${finding.body}`;
  });
  return `### Already resolved during this review pass — do NOT redo\n\n${lines.join("\n")}`;
}

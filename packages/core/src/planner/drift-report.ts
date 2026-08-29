import { createHash } from "node:crypto";
import { isSpecLockActive, type CurrentPlanEvidence, type SpecLock, type SpecLockSection } from "./spec-lock.js";

export type DriftAlignment = "on-plan" | "diverged-needs-review" | "diverged-relocked-approved" | "unavailable";
export type DriftFindingKind = "scope-creep" | "silent-expansion" | "plan-deviation";
export type DriftFindingCategory = SpecLockSection | "mission-statement";

export interface DriftFinding {
  kind: DriftFindingKind;
  category: DriftFindingCategory;
  priorHash?: string;
  currentHash?: string;
  path?: string;
}
export interface DriftReport {
  lockVersion?: number;
  currentPlanVersion?: number;
  /** Canonical content hash fences a report to the precise plan revision evaluated. */
  currentPlanHash?: string;
  /**
   * FNXC:SpecDrift 2026-08-09-08:25:
   * Approval state is an independent stale fence: a report cannot call a lock active after an
   * approval invalidation races its evaluation.
   */
  approvedPlanFingerprint?: string;
  status: "available" | "unavailable";
  reason?: string;
  findings: DriftFinding[];
  alignment: DriftAlignment;
  executionHash: string;
  reportHash: string;
}

/**
 * FNXC:SpecDrift 2026-08-10-09:28:
 * Re-locking a plan must retain divergence from any earlier immutable lock. Derive this from the
 * append-only report history, never only the newest report, so core storage and engine snapshots
 * use exactly one predicate and cannot disagree about alignment.
 */
export function hasPriorLockDivergence(reports: readonly DriftReport[], latestLockVersion: number | undefined): boolean {
  return reports.some((entry) => entry.alignment === "diverged-needs-review" && entry.lockVersion !== latestLockVersion);
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "");
const matchesScope = (path: string, scope: string): boolean => {
  // Preserve glob tokens while escaping literals: replacing `**` first and then `*` corrupts it.
  const glob = normalizePath(scope);
  let expression = "";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] === "*" && glob[index + 1] === "*") {
      // `**/` admits files directly below the preceding segment as well as nested paths.
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (glob[index] === "*") {
      expression += "[^/]*";
    } else {
      expression += glob[index]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(path);
};

/**
 * FNXC:SpecDrift 2026-08-09-07:06:
 * FN-8845 must make current-plan changes visible even after they invalidate approval. This pure
 * evaluator never uses an LLM and reports unavailable rather than declaring malformed evidence clean.
 */
export function evaluateSpecDrift(input: { latestLock?: SpecLock; currentPlan?: CurrentPlanEvidence; approvedPlanFingerprint?: string; modifiedFiles?: string[]; priorDivergence?: boolean }): DriftReport {
  const execution = [...new Set((input.modifiedFiles ?? []).map(normalizePath))].sort();
  const executionHash = hash(execution);
  if (!input.latestLock || !input.currentPlan || input.latestLock.plan.status !== "available" || input.currentPlan.plan.status !== "available") {
    const reason = input.currentPlan?.plan.reason ?? input.latestLock?.plan.reason ?? "lock-or-current-plan-missing";
    return report({ lockVersion: input.latestLock?.version, currentPlanVersion: input.currentPlan?.version, currentPlanHash: input.currentPlan?.plan.contentHash, approvedPlanFingerprint: input.approvedPlanFingerprint?.trim() || undefined, status: "unavailable", reason, findings: [], alignment: "unavailable", executionHash });
  }
  /*
  FNXC:SpecDrift 2026-08-09-19:01:
  Retained snapshots are durable input, not trusted runtime objects. A partial/old row must produce
  a fixed unavailable result rather than throw or accidentally omit a scope-bearing section.
  */
  if (!hasComparableSections(input.latestLock) || !hasComparableSections(input.currentPlan)) {
    return report({ lockVersion: input.latestLock.version, currentPlanVersion: input.currentPlan.version, currentPlanHash: input.currentPlan.plan.contentHash, approvedPlanFingerprint: input.approvedPlanFingerprint?.trim() || undefined, status: "unavailable", reason: "malformed-plan-evidence", findings: [], alignment: "unavailable", executionHash });
  }
  const findings: DriftFinding[] = [];
  for (const key of Object.keys(input.latestLock.plan.sections) as SpecLockSection[]) {
    const prior = input.latestLock.plan.sections[key];
    const current = input.currentPlan.plan.sections[key];
    if (prior.hash === current.hash) continue;
    const expanded = isStructuralExpansion(key, prior.canonical, current.canonical);
    findings.push({ kind: expanded ? "silent-expansion" : "plan-deviation", category: key === "mission" ? "mission-statement" : key, priorHash: prior.hash, currentHash: current.hash });
  }
  const scope = input.latestLock.plan.sections["file-scope"].canonical.split("\n").filter(Boolean);
  for (const path of execution) if (scope.length > 0 && !scope.some((entry) => matchesScope(path, entry))) findings.push({ kind: "scope-creep", category: "file-scope", path });
  const active = isSpecLockActive(input.latestLock, input.currentPlan, input.approvedPlanFingerprint);
  const alignment: DriftAlignment = findings.length > 0 ? "diverged-needs-review" : active ? (input.priorDivergence ? "diverged-relocked-approved" : "on-plan") : "unavailable";
  return report({ lockVersion: input.latestLock.version, currentPlanVersion: input.currentPlan.version, currentPlanHash: input.currentPlan.plan.contentHash, approvedPlanFingerprint: input.approvedPlanFingerprint?.trim() || undefined, status: "available", findings, alignment, executionHash });
}

/**
 * FNXC:SpecDrift 2026-08-09-18:17:
 * Added boundaries, goals, steps, and acceptance criteria are scope expansion even when the
 * mutable prompt invalidated approval. Ordered steps stay strict: a reorder changes approach.
 */
function hasComparableSections(value: SpecLock | CurrentPlanEvidence): boolean {
  const sections = value.plan.sections;
  return ["mission", "file-scope", "steps", "acceptance-criteria", "non-goals", "dependencies", "lineage"].every((key) => {
    const section = sections[key as SpecLockSection];
    /* FNXC:SpecDrift 2026-08-09-19:01: Optional absent sections canonicalize as an empty available
       boundary and intentionally have no per-section hash; only non-empty sections need one. */
    return section?.status === "available"
      && typeof section.canonical === "string"
      && (section.canonical.length === 0 || typeof section.hash === "string");
  });
}

function isStructuralExpansion(key: SpecLockSection, prior: string, current: string): boolean {
  if (!(key === "file-scope" || key === "dependencies" || key === "lineage" || key === "steps" || key === "acceptance-criteria")) return false;
  const priorItems = prior.split("\n").filter(Boolean);
  const currentItems = current.split("\n").filter(Boolean);
  return currentItems.length > priorItems.length && priorItems.every((item, index) => key === "steps" ? currentItems[index] === item : currentItems.includes(item));
}

/**
 * FNXC:SpecDrift 2026-08-09-19:19:
 * Readers must not reuse an older clean report after a re-lock or prompt evidence revision. A
 * report is current only when both retained identities still name the latest snapshots.
 */
export function isCurrentSpecDriftReport(
  report: DriftReport | undefined,
  latestLock: SpecLock | undefined,
  currentPlan: CurrentPlanEvidence | undefined,
  approvedPlanFingerprint?: string,
): report is DriftReport {
  /*
  FNXC:SpecDrift 2026-08-09-20:21:
  Approval invalidation does not necessarily create a new current-plan revision (dependency and
  lineage mutations retain the same prompt). Fence the approval fingerprint too, so readers never
  present the prior active on-plan report after that acceptance evidence has been superseded.
  */
  return report !== undefined
    && report.lockVersion === latestLock?.version
    && report.currentPlanVersion === currentPlan?.version
    && report.currentPlanHash === currentPlan?.plan.contentHash
    && report.approvedPlanFingerprint === (approvedPlanFingerprint?.trim() || undefined);
}

function report(value: Omit<DriftReport, "reportHash">): DriftReport { return { ...value, reportHash: hash(value) }; }

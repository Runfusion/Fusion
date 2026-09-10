import { createHash } from "node:crypto";
import type { MergeDetails, Task } from "@fusion/core";

export type LandedPathStatus = "added" | "modified" | "deleted" | "renamed";
export interface OverlapLandedPath {
  repository: string;
  path: string;
  previousPath?: string;
  status: LandedPathStatus;
  diff?: string;
}
export interface OverlapDeliveryEvidence {
  blockerTaskId: string;
  blockerLineageId?: string;
  repository: string;
  target?: string;
  landedSha?: string;
  summary?: string;
  paths?: OverlapLandedPath[];
  noOp?: boolean;
  evidence: "merge-details" | "workspace-landing" | "git-recapture" | "unavailable";
}
export type OverlapResumeDecision = "resume" | "briefing" | "revalidate" | "freshness-pending";
export interface OverlapResumeAnalysis {
  decision: OverlapResumeDecision;
  reason: "no-common-files" | "non-structural-overlap" | "structural-contract-change" | "contract-evidence-unavailable" | "delivery-evidence-unavailable";
  commonFiles: string[];
  deliveries: OverlapDeliveryEvidence[];
  decisionFingerprint: string;
  structuralAnchors: string[];
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function qualify(repository: string, path: string): string {
  const repo = normalizePath(repository || ".");
  const normalized = normalizePath(path);
  return repo === "." ? normalized : `${repo}:${normalized}`;
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern).replace(/^([^:]+):/, "$1:");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function parsePlanFileTargets(prompt: string): string[] {
  const section = prompt.match(/^##\s+File Scope\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? "";
  const paths = Array.from(section.matchAll(/`([^`]+)`/g), (match) => normalizePath(match[1]!.trim()))
    .filter((value) => value.length > 0 && !value.includes("\n"));
  return [...new Set(paths)].sort();
}

function taskTargets(task: Pick<Task, "prompt" | "modifiedFiles">): string[] {
  return [...new Set([
    ...parsePlanFileTargets(task.prompt ?? ""),
    ...(task.modifiedFiles ?? []).map(normalizePath),
  ])];
}

function targetMatches(target: string, repository: string, path: string): boolean {
  const qualified = qualify(repository, path);
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget.includes(":")) return globRegex(normalizedTarget).test(qualified);
  return globRegex(normalizedTarget).test(normalizePath(path));
}

function extractPlanSymbols(task: Pick<Task, "prompt" | "declaredSymbols">): string[] {
  const declared = task.declaredSymbols ?? [];
  const inline = Array.from((task.prompt ?? "").matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/g), (match) => match[1]!);
  return [...new Set([...declared, ...inline])];
}

function structuralAnchors(task: Pick<Task, "prompt" | "declaredSymbols">, common: OverlapLandedPath[]): string[] {
  const symbols = extractPlanSymbols(task);
  const anchors = new Set<string>();
  for (const change of common) {
    const qualified = qualify(change.repository, change.path);
    if (change.status === "deleted" || change.status === "renamed") anchors.add(`${qualified}:${change.status}`);
    if (!change.diff) continue;
    for (const symbol of symbols) {
      const leaf = symbol.split(".").at(-1)!;
      const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const contractLine = new RegExp(`^[+-].*\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)?\\s*${escaped}\\b`, "m");
      if (contractLine.test(change.diff)) anchors.add(`${qualified}:${symbol}`);
    }
  }
  return [...anchors].sort();
}

export function deliveryEvidenceFromTask(task: Pick<Task, "id" | "lineageId" | "summary" | "mergeDetails">): OverlapDeliveryEvidence[] {
  const details: MergeDetails | undefined = task.mergeDetails;
  if (!details) return [{ blockerTaskId: task.id, blockerLineageId: task.lineageId, repository: ".", evidence: "unavailable" }];
  if (details.workspaceLandedShas && Object.keys(details.workspaceLandedShas).length > 0) {
    return Object.entries(details.workspaceLandedShas).sort(([a], [b]) => a.localeCompare(b)).map(([repository, landedSha]) => ({
      blockerTaskId: task.id, blockerLineageId: task.lineageId, repository, landedSha,
      target: details.mergeTargetBranch, summary: task.summary, evidence: "workspace-landing",
    }));
  }
  if (details.landedFilesCaptureFallback === "attribution-failed" || details.landedFiles === undefined) {
    return [{ blockerTaskId: task.id, blockerLineageId: task.lineageId, repository: ".", landedSha: details.commitSha, target: details.mergeTargetBranch, summary: task.summary, evidence: "unavailable" }];
  }
  return [{
    blockerTaskId: task.id, blockerLineageId: task.lineageId, repository: ".", landedSha: details.commitSha,
    target: details.mergeTargetBranch, summary: task.summary,
    paths: details.landedFiles.map((path) => ({ repository: ".", path: normalizePath(path), status: "modified" })),
    noOp: details.noOpVerifiedShortCircuit === true || details.noOpMerge === true,
    evidence: "merge-details",
  }];
}

/**
 * Deterministic overlap analysis: only concrete delivered paths are matched against B's current
 * plan/work. Unknown delivery evidence never collapses to an empty delivery, and no model is used.
 */
export function analyzeOverlapResume(input: {
  task: Pick<Task, "prompt" | "modifiedFiles" | "declaredSymbols" | "lineageId">;
  deliveries: OverlapDeliveryEvidence[];
}): OverlapResumeAnalysis {
  const targets = taskTargets(input.task);
  const unknown = input.deliveries.some((delivery) => delivery.evidence === "unavailable" || (!delivery.noOp && delivery.paths === undefined));
  const landed = input.deliveries.flatMap((delivery) => delivery.paths ?? []);
  const common = landed.filter((change) => targets.some((target) => targetMatches(target, change.repository, change.path)
    || (change.previousPath ? targetMatches(target, change.repository, change.previousPath) : false)));
  const commonFiles = [...new Set(common.flatMap((change) => [qualify(change.repository, change.path), ...(change.previousPath ? [qualify(change.repository, change.previousPath)] : [])]))].sort();
  const anchors = structuralAnchors(input.task, common);
  let decision: OverlapResumeDecision;
  let reason: OverlapResumeAnalysis["reason"];
  if (unknown) { decision = "freshness-pending"; reason = "delivery-evidence-unavailable"; }
  else if (commonFiles.length === 0) { decision = "resume"; reason = "no-common-files"; }
  else if (anchors.length > 0) { decision = "revalidate"; reason = "structural-contract-change"; }
  else if (common.some((change) => change.diff === undefined)) { decision = "revalidate"; reason = "contract-evidence-unavailable"; }
  else { decision = "briefing"; reason = "non-structural-overlap"; }
  const identity = JSON.stringify({ lineageId: input.task.lineageId ?? null, targets: [...targets].sort(), deliveries: input.deliveries, decision, commonFiles, anchors });
  return { decision, reason, commonFiles, deliveries: input.deliveries, decisionFingerprint: createHash("sha256").update(identity).digest("hex"), structuralAnchors: anchors };
}

import { formatRemediationStepName, isBlockingFinding, type ReviewBlockingSeverity, type TaskStep, type WorkflowReviewFinding } from "@fusion/core";
import { extractFileScope, matchesScope } from "../merge/merger-file-scope.js";

export interface DeriveRemediationStepsInput {
  gate: "Code Review" | "Verification";
  gateStepId: string;
  wave: number;
  findings?: WorkflowReviewFinding[];
  blockingSeverity?: ReviewBlockingSeverity;
  verificationOutput?: string;
  verificationCommandLabel?: string;
  prompt?: string;
  changedFiles?: readonly string[];
}

export interface DerivedRemediationSteps {
  steps: TaskStep[];
  outOfScope: Array<{ filePath?: string; detail: string }>;
  reason?: "upstream-out-of-scope";
}

const fileReference = /(?:^|[\s(])([\w@./-]+\.(?:[cm]?[jt]sx?|json|md|css|html|yml|yaml))(?::(\d+))?/gm;
const normalized = (value: string) => value.replace(/\\/g, "/").trim();

function verificationCandidates(input: DeriveRemediationStepsInput): Array<{ filePath?: string; line?: number; detail: string }> {
  const detail = input.verificationCommandLabel ?? "verification command";
  const seen = new Set<string>();
  const candidates: Array<{ filePath?: string; line?: number; detail: string }> = [];
  for (const match of input.verificationOutput?.matchAll(fileReference) ?? []) {
    const filePath = normalized(match[1]);
    if (!seen.has(filePath)) {
      seen.add(filePath);
      candidates.push({ filePath, ...(match[2] ? { line: Number(match[2]) } : {}), detail: `Fix failing ${detail}: ${filePath}` });
    }
  }
  return candidates.length > 0 ? candidates : [{ detail: `Fix failing ${detail}` }];
}

/**
 * FNXC:ReviewGatedRemediation 2026-08-23-05:06:
 * Gate findings become explicit append-only steps with provenance. Scope filtering happens before
 * append: an unrelated failure is upstream work, never invented remediation for this task.
 */
export function deriveRemediationSteps(input: DeriveRemediationStepsInput): DerivedRemediationSteps {
  const candidates: Array<{ filePath?: string; line?: number; detail: string; findingId?: string }> = input.gate === "Code Review"
    ? (input.findings ?? [])
      .filter((finding) => isBlockingFinding(finding, input.blockingSeverity ?? "critical"))
      .map((finding) => ({ filePath: finding.filePath, line: finding.line, detail: finding.body || finding.title, findingId: finding.id }))
    : verificationCandidates(input);
  const declaredScope = extractFileScope(input.prompt ?? "");
  const changedFiles = new Set((input.changedFiles ?? []).map(normalized));
  const steps: TaskStep[] = [];
  const outOfScope: Array<{ filePath?: string; detail: string }> = [];
  for (const candidate of candidates) {
    const filePath = candidate.filePath ? normalized(candidate.filePath) : undefined;
    const allowed = !filePath || matchesScope(filePath, declaredScope) || changedFiles.has(filePath);
    if (!allowed) {
      outOfScope.push({ filePath, detail: candidate.detail });
      continue;
    }
    steps.push({
      name: formatRemediationStepName({ detail: candidate.detail }),
      status: "pending",
      remediation: {
        wave: input.wave,
        gate: input.gate,
        gateStepId: input.gateStepId,
        ...(candidate.findingId ? { findingId: candidate.findingId } : {}),
        ...(filePath ? { filePath, declaredFiles: [filePath] } : {}),
        ...(candidate.line ? { line: candidate.line } : {}),
        detail: candidate.detail,
      },
    });
  }
  return { steps, outOfScope, ...(candidates.length > 0 && steps.length === 0 ? { reason: "upstream-out-of-scope" } : {}) };
}

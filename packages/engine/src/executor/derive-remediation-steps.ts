import { createHash } from "node:crypto";
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
  confirmedRepositories?: readonly string[];
}

export interface DerivedRemediationSteps {
  steps: TaskStep[];
  outOfScope: Array<{ filePath?: string; detail: string }>;
  reason?: "upstream-out-of-scope";
}

const fileReference = /(?:^|[\s(])([\w@./-]+\.(?:[cm]?[jt]sx?|json|md|css|html|yml|yaml))(?::(\d+))?/gm;
const ansiEscapeSequence = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const isoTimestamp = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const bareTimestamp = /\b\d{2}:\d{2}:\d{2}\b/g;
const elapsedDuration = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
const normalized = (value: string) => value.replace(/\\/g, "/").trim();

/**
 * FNXC:VerificationRemediation 2026-08-28-16:10:
 * Verification has no review-input fingerprint, so repeat detection uses the failing output rather
 * than derived candidate tuples: file dedupe and the fileless fallback intentionally collapse
 * distinct failures. Only ANSI paint, whitespace, elapsed durations, and timestamps are volatile.
 * A false change costs one permitted extra wave; a false unchanged verdict strands a card, so file
 * locations, counts, exit codes, assertions, and error text remain part of the identity.
 */
export function normalizeVerificationEvidence(output: string | undefined): string {
  if (!output?.trim()) return "";
  return output
    .replace(ansiEscapeSequence, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line
      .trim()
      .replace(isoTimestamp, "<timestamp>")
      .replace(bareTimestamp, "<timestamp>")
      .replace(elapsedDuration, "<duration>")
      .replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

export function verificationEvidenceDigest(output: string | undefined): string | undefined {
  const evidence = normalizeVerificationEvidence(output);
  return evidence ? createHash("sha256").update(evidence).digest("hex").slice(0, 16) : undefined;
}

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
 *
 * FNXC:WorkspaceReviewRemediation 2026-08-28-12:16:
 * Confirmed repository scope is the workspace task's intent boundary. A not-yet-declared file inside
 * that boundary is remediable because the appender immediately widens PROMPT.md File Scope for every
 * accepted fix step; rejecting it first would contradict the persistence operation that follows.
 */
export function deriveRemediationSteps(input: DeriveRemediationStepsInput): DerivedRemediationSteps {
  const evidenceDigest = input.gate === "Verification"
    ? verificationEvidenceDigest(input.verificationOutput)
    : undefined;
  const candidates: Array<{ filePath?: string; line?: number; title?: string; detail: string; findingId?: string }> = input.gate === "Code Review"
    ? (input.findings ?? [])
      .filter((finding) => isBlockingFinding(finding, input.blockingSeverity ?? "critical"))
      .map((finding) => {
        /*
         * FNXC:ReviewRemediationLabels 2026-08-28-23:08:
         * The title labels operator-visible task cards, list rows, and detail progress. Keep the
         * body in durable detail because hasOpenEquivalentRemediationStep, convergence signatures,
         * and the executor's **Required fix:** instruction use that provenance.
         */
        return {
          filePath: finding.filePath,
          line: finding.line,
          title: finding.title,
          detail: finding.body || finding.title,
          findingId: finding.id,
        };
      })
    : verificationCandidates(input);
  const declaredScope = extractFileScope(input.prompt ?? "");
  const changedFiles = new Set((input.changedFiles ?? []).map(normalized));
  const confirmedRepositories = (input.confirmedRepositories ?? []).map(normalized).filter(Boolean);
  const steps: TaskStep[] = [];
  const outOfScope: Array<{ filePath?: string; detail: string }> = [];
  for (const candidate of candidates) {
    const filePath = candidate.filePath ? normalized(candidate.filePath) : undefined;
    const insideConfirmedRepository = Boolean(filePath) && confirmedRepositories.some((repository) =>
      filePath === repository || filePath?.startsWith(`${repository}/`));
    const allowed = !filePath || matchesScope(filePath, declaredScope) || changedFiles.has(filePath) || insideConfirmedRepository;
    if (!allowed) {
      outOfScope.push({ filePath, detail: candidate.detail });
      continue;
    }
    steps.push({
      name: formatRemediationStepName({ title: candidate.title, detail: candidate.detail }),
      status: "pending",
      remediation: {
        wave: input.wave,
        gate: input.gate,
        gateStepId: input.gateStepId,
        ...(candidate.findingId ? { findingId: candidate.findingId } : {}),
        ...(filePath ? { filePath, declaredFiles: [filePath] } : {}),
        ...(candidate.line ? { line: candidate.line } : {}),
        ...(evidenceDigest ? { evidenceDigest } : {}),
        detail: candidate.detail,
      },
    });
  }
  return { steps, outOfScope, ...(candidates.length > 0 && steps.length === 0 ? { reason: "upstream-out-of-scope" } : {}) };
}

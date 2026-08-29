/**
 * FNXC:CodeOrganization 2026-08-03-18:50:
 * injectWorkflowStepFailureInstructions peeled from TaskExecutor (U4).
 * Writes/replaces the "## Workflow Step Failure" section in PROMPT.md for hard-failed steps.
 */
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Task, TaskStore, WorkflowReviewFinding } from "@fusion/core";
import { formatFindingsByPriority, formatResolvedFindings, isOpenWorkflowReviewFinding } from "@fusion/core";
import { executorLog } from "../logger.js";
import { buildWorkflowFailureScopeGuard } from "./workflow-failure-scope-guard.js";

export type WorkflowStepFailureInjectionStore = Pick<TaskStore, "getFusionDir">;

/*
FNXC:ReviewSeverityGate 2026-08-10-17:33:
Structured findings are rendered grouped by priority with an EXPLICIT obligation per group, replacing a
flat prose blob that gave the implementer no way to tell a blocking defect from an optional note. The
implementer needs the distinction to converge: without it, every remediation round tried to satisfy every
observation, which is what turned a single REVISE into a multi-round negotiation. `findings` is optional
so prose-only reviewers (custom nodes, older workflows) keep working unchanged.
*/
const ADVISORY_SECTION_HEADER = "## Review Advisory Notes";

/**
 * Write non-blocking review findings into PROMPT.md.
 *
 * FNXC:ReviewSeverityGate 2026-08-10-17:33:
 * When the severity gate downgrades a REVISE, the task proceeds — but the findings must not silently
 * vanish into the Review tab, or the gate would trade churn for lost signal. Plan Review is the
 * load-bearing case: its downgrade happens BEFORE implementation, so these notes reach the implementer
 * as optional context on the very next run. The section is replaced (not appended) on each write so
 * repeated reviews cannot grow PROMPT.md without bound, and it is explicitly labeled non-blocking so
 * the implementer does not treat it as a remediation obligation.
 */
export async function injectReviewAdvisoryNotes(
  store: WorkflowStepFailureInjectionStore,
  task: Task,
  stepName: string,
  findings: WorkflowReviewFinding[],
): Promise<void> {
  findings = findings.filter(isOpenWorkflowReviewFinding);
  if (findings.length === 0) return;
  const promptPath = join(store.getFusionDir(), "tasks", task.id, "PROMPT.md");
  let content: string;
  try {
    content = await readFile(promptPath, "utf-8");
  } catch {
    executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping review advisory injection`);
    return;
  }

  const section = `${ADVISORY_SECTION_HEADER}

${stepName} raised the following NON-BLOCKING observations. They did not block this task and require no remediation round. Address them only if cheap and clearly correct while doing the work you were already going to do; skipping them is expected and needs no justification.

${formatFindingsByPriority(findings)}

`;

  const sectionRegex = new RegExp(`${ADVISORY_SECTION_HEADER}[\\s\\S]*?(?=\\n## |\\n# |$)`, "i");
  const newContent = sectionRegex.test(content) ? content.replace(sectionRegex, section) : `${content}\n${section}`;

  try {
    await writeFile(promptPath, newContent);
    executorLog.log(`${task.id}: injected ${findings.length} advisory review finding(s) into PROMPT.md`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`${task.id}: failed to inject review advisory notes: ${errorMessage}`);
  }
}

export async function injectWorkflowStepFailureInstructions(
  store: WorkflowStepFailureInjectionStore,
  task: Task,
  failureFeedback: string,
  stepName: string,
  retry: { attempt: number; max?: number },
  findings?: WorkflowReviewFinding[],
): Promise<void> {
  const promptPath = join(store.getFusionDir(), "tasks", task.id, "PROMPT.md");

  // Read existing PROMPT.md
  let content: string;
  try {
    content = await readFile(promptPath, "utf-8");
  } catch {
    executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping workflow failure injection`);
    return;
  }

  const retryLabel = retry.max === undefined ? "unbounded" : String(retry.max);
  const remainingRetries = retry.max === undefined ? "unlimited" : String(Math.max(0, retry.max - retry.attempt));
  const failureSectionHeader = "## Workflow Step Failure";
  const scopeGuard = buildWorkflowFailureScopeGuard(task, content);
  const prioritized = findings?.length ? formatFindingsByPriority(findings) : "";
  const resolved = findings?.length ? formatResolvedFindings(findings) : "";
  const disputed = task.workflowStepResults?.flatMap((result) => result.priorAttempts?.flatMap((attempt) => attempt.findings ?? []) ?? [])
    .filter((finding) => finding.disputedAt != null && isOpenWorkflowReviewFinding(finding)) ?? [];
  const disputedBlock = disputed.length > 0
    ? `\n\n**You disputed these — still open until the reviewer rules:**\n\n${disputed.map((finding) => `- ${finding.id}: ${finding.disputeRationale ?? "No rationale recorded."}`).join("\n")}`
    : "";
  const feedbackBlock = prioritized
    ? `**Findings:**\n\n${prioritized}${resolved ? `\n\n${resolved}` : ""}${disputedBlock}`
    : `**Failure Feedback:**\n${failureFeedback}${resolved ? `\n\n${resolved}` : ""}${disputedBlock}`;
  /*
   * FNXC:ReviewConvergence 2026-08-22-05:20:
   * FN-149 replaces an inert prose decline with fn_review_dispute. A dispute remains an open,
   * blocking obligation; it records the implementer's position for the next reviewer rather than
   * allowing the implementer to close its own finding.
   */
  const failureSectionContent = `${failureSectionHeader}

The following workflow step returned findings that require implementation fixes:

**Step:** ${stepName}

${feedbackBlock}

${scopeGuard}

**Retry:** ${retry.attempt}/${retryLabel} (${remainingRetries} remaining)

**Important:** This is a workflow step failure — address the findings above by making the necessary code changes. The task has been sent back to in-progress for remediation. Fix every P0. Fix P1 unless you have a concrete reason not to; if you disagree with a finding, call fn_review_dispute(findingId, rationale). A dispute remains open and blocking until the reviewer rules, so do not silently decline a finding. P2 items are optional and need no justification if skipped. Do not make unrelated changes while remediating.

`;

  let newContent: string;
  if (content.includes(failureSectionHeader)) {
    // Replace existing section
    const sectionRegex = new RegExp(
      `${failureSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
      "i"
    );
    if (sectionRegex.test(content)) {
      newContent = content.replace(sectionRegex, failureSectionContent);
    } else {
      // Fallback: append at end
      newContent = content + "\n" + failureSectionContent;
    }
  } else {
    // Remove any existing Workflow Revision Instructions section first (conflicting state)
    const revisionSectionHeader = "## Workflow Revision Instructions";
    if (content.includes(revisionSectionHeader)) {
      const revisionRegex = new RegExp(
        `${revisionSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
        "i"
      );
      content = content.replace(revisionRegex, "");
    }

    // Append new section before any closing markers or at end
    const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);
    if (acceptanceCriteriaMatch) {
      const insertIdx = acceptanceCriteriaMatch.index!;
      newContent = content.slice(0, insertIdx) + "\n" + failureSectionContent + content.slice(insertIdx);
    } else {
      newContent = content + "\n" + failureSectionContent;
    }
  }

  // Write updated content
  try {
    await writeFile(promptPath, newContent);
    executorLog.log(`${task.id}: injected workflow step failure instructions into PROMPT.md (retry ${retry.attempt}/${retryLabel})`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`${task.id}: failed to inject workflow step failure instructions: ${errorMessage}`);
  }
}

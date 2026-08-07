/**
 * FNXC:CodeOrganization 2026-08-03-18:50:
 * injectWorkflowStepFailureInstructions peeled from TaskExecutor (U4).
 * Writes/replaces the "## Workflow Step Failure" section in PROMPT.md for hard-failed steps.
 */
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { buildWorkflowFailureScopeGuard } from "./workflow-failure-scope-guard.js";

export type WorkflowStepFailureInjectionStore = Pick<TaskStore, "getFusionDir">;

export async function injectWorkflowStepFailureInstructions(
  store: WorkflowStepFailureInjectionStore,
  task: Task,
  failureFeedback: string,
  stepName: string,
  retry: { attempt: number; max?: number },
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
  const failureSectionContent = `${failureSectionHeader}

The following workflow step failed and requires implementation fixes:

**Step:** ${stepName}

**Failure Feedback:**
${failureFeedback}

${scopeGuard}

**Retry:** ${retry.attempt}/${retryLabel} (${remainingRetries} remaining)

**Important:** This is a workflow step failure — fix the issues above by making the necessary code changes. The task has been sent back to in-progress for remediation. The executor will attempt to fix the issues on the next pass.

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

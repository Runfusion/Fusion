/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * Pure workflow remediation scope-guard builder peeled from TaskExecutor (U4).
 */
import type { Task } from "@fusion/core";
import {
  extractPromptListEntries,
  extractPromptSection,
} from "./prompt-derived-eligibility.js";

export function buildWorkflowFailureScopeGuard(task: Task, promptContent: string): string {
  const promptScopeEntries = extractPromptListEntries(extractPromptSection(promptContent, "File Scope"));
  const metadataScope = Array.isArray(task.sourceMetadata?.fileScope)
    ? task.sourceMetadata.fileScope.filter((entry): entry is string => typeof entry === "string")
    : [];
  const declaredScope = Array.from(new Set([...promptScopeEntries, ...metadataScope].map((entry) => entry.trim()).filter(Boolean)));
  /*
   * FNXC:WorkflowRemediationScope 2026-06-29-13:56:
   * Review remediation must not let one task silently implement unrelated behavior. If reviewer feedback points outside the declared File Scope, the executor should remove/split the unrelated work instead of expanding the task, while still allowing already-scoped fixes to proceed automatically.
   */
  if (declaredScope.length === 0) {
    return "**Scope Guard:** Keep remediation limited to this task's stated mission and existing implementation surface. If the feedback requires unrelated behavior, remove or split that work instead of implementing it here.";
  }
  return [
    "**Scope Guard:** Treat the declared File Scope as the remediation boundary. Fix only the scoped files unless PROMPT.md already authorizes a scope expansion. If the feedback requires unrelated behavior outside this scope, remove those unrelated changes or split them into a separate task instead of implementing them here.",
    "",
    "**Declared File Scope:**",
    ...declaredScope.map((entry) => `- ${entry}`),
  ].join("\n");
}

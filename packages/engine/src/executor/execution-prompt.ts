/**
 * FNXC:CodeOrganization 2026-08-03-12:45:
 * Execution prompt builders peeled from executor.ts (U4 Slice A pure helpers).
 * Public API stays re-exported from executor.ts for deep import/mock stability.
 */
import type {
  AgentMemoryInclusionMode,
  Settings,
  TaskDetail,
  WorkflowFieldDefinition,
} from "@fusion/core";
import { buildExecutionMemoryInstructions, buildMemoryPreSteeringNudge, isFastExecutionMode, resolveTaskOutputLanguage, type WorkspaceConfig } from "@fusion/core";
import { buildFastLanePrompt } from "../execution/step-session-executor.js";
import { executorLog } from "../logger.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { parseReviewLevelFromPrompt } from "./prompt-derived-eligibility.js";

/**
 * Format a timestamp for display in steering comments.
 * Returns relative time for recent comments, absolute date for older ones.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// Project commands are injected here (for reliability) and also in the PROMPT.md (by triage).
// This ensures the executor agent always sees the authoritative commands from settings,
// even if the PROMPT.md was written manually or before commands were configured.
export function scopePromptToWorktree(
  prompt: string | undefined,
  rootDir?: string,
  worktreePath?: string,
  workspaceConfig?: WorkspaceConfig | null,
): string {
  /*
   * FNXC:ExecutorPrompts 2026-06-29-13:55:
   * Some legacy direct-dispatch tests and recovered task rows can lack a persisted prompt. Treat a missing prompt as empty before worktree path scoping so prompt construction cannot fail before pause-abort and graph-path recovery code handles the task state.
   */
  const promptText = prompt ?? "";
  // FNXC:Workspace 2026-06-21-12:00: KTD1 — in workspace mode the session is rooted at the workspace root itself (worktreePath === rootDir) and path rewriting to a per-task root worktree is meaningless: edits happen in per-sub-repo worktrees the agent acquires, not at the root. No-op the rewrite. (The rootDir === worktreePath guard below already covers this, but gate explicitly so intent survives future refactors.)
  if (workspaceConfig) {
    return promptText;
  }
  if (!rootDir || !worktreePath || rootDir === worktreePath || !promptText.includes(rootDir)) {
    return promptText;
  }

  return promptText
    .replaceAll(`${rootDir}/`, `${worktreePath}/`)
    .replaceAll(`${worktreePath}/.fusion/`, `${rootDir}/.fusion/`);
}

export function buildSourceIssueRef(sourceIssue: TaskDetail["sourceIssue"]): string {
  if (!sourceIssue || sourceIssue.provider !== "github" || !sourceIssue.repository) {
    return "";
  }

  const issueNumber = sourceIssue.issueNumber
    ?? Number.parseInt(sourceIssue.externalIssueId ?? "", 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return "";
  }

  return `${sourceIssue.repository}#${issueNumber}`;
}

export function buildExecutionPrompt(
  task: TaskDetail,
  rootDir?: string,
  settings?: Settings,
  worktreePath?: string,
  _pluginRunner?: PluginRunner,
  customFieldDefs?: WorkflowFieldDefinition[],
  workspaceConfig?: WorkspaceConfig | null,
  options?: { pluginTaskContributions?: string },
): string {
  if (isFastExecutionMode(task)) return buildFastLanePrompt(task, rootDir, settings, worktreePath);
  const prompt = scopePromptToWorktree(task.prompt, rootDir, worktreePath, workspaceConfig);
  const reviewLevel = parseReviewLevelFromPrompt(prompt);
  /*
   * FNXC:WorkflowReviewGates 2026-06-29-20:41:
   * Default Coding and other workflow-graph tasks run review gates as graph nodes, so the executor prompt must not ask implementation agents to call legacy per-step review tools. This keeps Plan Review once-before-execution and Code Review once-before-merge unless a workflow explicitly adds a step-review node.
   */

  // Build co-author trailer arg for git commits based on settings. The user's
  // configured git identity remains the primary author; Fusion is appended as
  // a `Co-authored-by` trailer for shared credit (recognized by GitHub).
  // FNXC:CommitAttribution 2026-06-26-12:48: this prompt hint is best-effort for humans/agents reading commit examples; the worktree commit-msg hook is the authoritative deterministic source for the co-author trailer.
  const authorArg = settings?.commitAuthorEnabled !== false
    ? ` -m "Co-authored-by: ${settings?.commitAuthorName || "Fusion"} <${settings?.commitAuthorEmail || "noreply@runfusion.ai"}>"`
    : "";

  const sourceIssueRef = buildSourceIssueRef(task.sourceIssue);

  // Build step progress for resume
  const hasProgress = task.steps.length > 0 && task.steps.some((s) => s.status !== "pending");
  let progressSection = "";
  if (hasProgress) {
    const doneSteps = task.steps
      .map((s, i) => ({ ...s, index: i }))
      .filter((s) => s.status === "done");
    const currentStep = task.currentStep;
    const currentStepInfo = task.steps[currentStep];

    progressSection = `
## ⚠️ RESUMING — Previous progress exists

This task was already partially executed. DO NOT redo completed steps.

### Step status:
${task.steps.map((s, i) => `- Step ${i} (${s.name}): **${s.status}**`).join("\n")}

### Resume from: Step ${currentStep}${currentStepInfo ? ` (${currentStepInfo.name})` : ""}

${doneSteps.length > 0 ? `Steps ${doneSteps.map((s) => s.index).join(", ")} are already complete — skip them entirely.` : ""}
Check the git log to understand what was already implemented:
\`\`\`bash
git log --oneline
\`\`\`
`;
  }

  // Build attachments section
  let attachmentsSection = "";
  if (task.attachments && task.attachments.length > 0 && rootDir) {
    const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const lines = ["## Attachments", ""];
    for (const att of task.attachments) {
      const absPath = `${rootDir}/.fusion/tasks/${task.id}/attachments/${att.filename}`;
      if (IMAGE_MIMES.has(att.mimeType)) {
        lines.push(`- **${att.originalName}** (screenshot): \`${absPath}\``);
      } else {
        lines.push(`- **${att.originalName}** (${att.mimeType}): \`${absPath}\` — read for context`);
      }
    }
    attachmentsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project commands section from settings
  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand) lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand) lines.push(`- **Build:** \`${settings.buildCommand}\``);
    commandsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project memory section from settings
  // When enabled, agents consult and update project memory for durable project learnings.
  // Backend-aware: instructions branch based on memoryBackendType (file, readonly, qmd)
  const memoryEnabled = settings?.memoryEnabled !== false;
  const memoryMode: AgentMemoryInclusionMode = settings?.agentMemoryInclusionMode ?? "full";
  let memorySection = "";
  if (memoryEnabled && rootDir && memoryMode !== "off") {
    memorySection = memoryMode === "index"
      ? `\n## Project Memory (Index Only)\n\n${buildMemoryPreSteeringNudge("index")}\n`
      : "\n" + buildExecutionMemoryInstructions(rootDir, settings, undefined, memoryMode);
  }

  // Build steering comments section (last 10 comments only to avoid context bloat)
  let steeringSection = "";
  if (task.steeringComments && task.steeringComments.length > 0) {
    const recentComments = [...task.steeringComments].slice(-10);
    const lines = [
      "",
      "## Steering Comments",
      "",
      "The following comments were added by the user during execution. Consider adjusting your approach or replanning remaining steps based on this feedback.",
      "",
    ];
    for (const comment of recentComments) {
      const timestamp = formatTimestamp(comment.createdAt);
      lines.push(`**${comment.author}** — ${timestamp}`);
      lines.push(`> ${comment.text}`);
      lines.push("");
    }
    steeringSection = lines.join("\n");
  }

  // Build custom fields section (KTD-13): when the task's workflow declares
  // custom fields, the executor agent can write them via fn_task_update
  // (custom_fields) — but without the schema it is writing blind. List each
  // field's id/name/type, enum options, required flag, and current value so
  // the write is informed and self-correcting. Compact: one line per field.
  let customFieldsSection = "";
  if (customFieldDefs && customFieldDefs.length > 0) {
    const current = task.customFields ?? {};
    const lines = [
      "",
      "## Custom fields",
      "",
      "This task's workflow declares custom fields. Set them with `fn_task_update(custom_fields={...})` keyed by field id (pass null to clear).",
      "",
    ];
    for (const f of customFieldDefs) {
      const parts = [`- \`${f.id}\` (${f.name}) — type: ${f.type}`];
      if ((f.type === "enum" || f.type === "multi-enum") && f.options && f.options.length > 0) {
        const opts = f.options.map((o) => (o.label && o.label !== o.value ? `${o.value} (${o.label})` : o.value)).join(", ");
        parts.push(`options: [${opts}]`);
      }
      if (f.required) parts.push("required");
      const hasValue = Object.prototype.hasOwnProperty.call(current, f.id) && current[f.id] !== null && current[f.id] !== undefined;
      parts.push(`current: ${hasValue ? JSON.stringify(current[f.id]) : "unset"}`);
      lines.push(parts.join("; "));
    }
    customFieldsSection = lines.join("\n") + "\n";
  }

  const pluginTaskContributions = options?.pluginTaskContributions ?? "";
  if (pluginTaskContributions) {
    executorLog.debug(`${task.id}: applied plugin prompt contributions for executor-task surface`);
  }

  /* FNXC:TaskOutputLanguage 2026-08-19-14:56: Executor settings are captured by the run before this prompt is built, so summary and recommendation prose do not drift mid-session. */
  const outputLanguageInstruction = resolveTaskOutputLanguage(settings, task.description).instruction;
  const executionPrompt = `## Task Output Language
${outputLanguageInstruction}
Apply this to fn_task_done summary and populated recommendation title/description only; keep recommendation schema, ids, categories, tools, code, and task syntax canonical.

Execute this task.

## Task: ${task.id}
${task.title ? `**${task.title}**` : ""}
${task.dependencies.length > 0 ? `Dependencies: ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${prompt}
${attachmentsSection}${commandsSection}${memorySection}${progressSection}${steeringSection}${customFieldsSection}
## Review level: ${reviewLevel}

Workflow review gates are handled by the workflow graph outside this implementation session. Do not request per-step plan review or per-step code review from inside execution; complete the implementation steps and let the graph run enabled Plan Review, Browser Verification, and Code Review nodes at their configured positions.
${pluginTaskContributions ? `

${pluginTaskContributions}
` : ""}

## Worktree Boundaries

You are running in an **isolated git worktree**. This means:

- **All code changes must be made inside the current worktree directory.** Do not modify files outside the worktree.
- **Exception — Project memory:** You MAY read and write to files under \`.fusion/memory/\` at the project root to save durable project learnings.
- **Exception — Task attachments:** You MAY read files under \`.fusion/tasks/{taskId}/attachments/\` at the project root for context.
- **Exception — Sibling task specs:** You MAY read \`.fusion/tasks/{taskId}/PROMPT.md\` and \`.fusion/tasks/{taskId}/task.json\` at the project root (read-only) to consult dependency tasks' specifications. If those files do not exist, call \`fn_task_show\` with the dependency ID; deleted tasks remain unavailable.
- **Shell commands** run inside the worktree by default. Avoid using \`cd\` to navigate outside the worktree.

## Begin

${hasProgress
    ? `Resume from Step ${task.currentStep}. Do NOT redo completed steps.`
    : "Start with Step 0 (Preflight). Work through each step in order."}
Use \`fn_task_update\` to report progress on every step transition; its \`step\` value is 0-based and equals the \`### Step N:\` number in PROMPT.md. When marking a step done, include the \`summary\` argument with 2–4 plain-language sentences describing what that step delivered and verified.
Use \`fn_task_log\` for important actions and decisions.
Use \`fn_task_create\` for truly separate follow-up work, including unrelated/pre-existing broad-suite failures.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — <short summary>"${sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : ""}${authorArg}\`
The \`<short summary>\` is required — replace it with a concrete 5–10 word description of what the step changed.
When all steps are complete: call \`fn_task_done()\`
For \`fn_task_done(outcome="blocked")\`, reserve \`obstacle:"outside-worktree"\` for host-resource, network, model-provider, and credential failures. An unavailable command, interpreter, optional service, or unrunnable test is never a blocked exit: resolve it with project tooling or an available equivalent, substitute a runnable automated check, or—when it does not prevent the task objective—complete the achievable work and record the deferred verification. If PROMPT.md has an \`## Environment Constraints\` section, its substitute is the sanctioned verification path and must not be re-litigated as a blocker. Set \`obstacle:"inside-worktree"\` for code, tests, lint, types, plan, merge, or review failures so AI self-repair remains active.

If a build command is configured, run that exact command in this worktree before calling \`fn_task_done()\`.
Treat a non-zero exit code as a blocking failure. Do not claim success without a real passing run.
Run impacted/package-scoped tests before completion. Run the configured workspace test command only when the task/workflow explicitly requires it or after impacted checks pass for final integration. If any broad command fails, classify the failure before editing: caused-by-this-task failures are blocking; unrelated or pre-existing failures should be logged and split into a follow-up instead of expanding this task.
If the repo has a lint command (e.g. \`pnpm lint\`, \`npm run lint\`), run it before \`fn_task_done()\` and fix any failures it reports.
If the repo has a typecheck command, run it before \`fn_task_done()\` and fix any failures it reports.
Use \`fn_task_create\` for truly separate follow-up work, including unrelated/pre-existing broad-suite failures.
If lint is configured and failing, fix that too before completion.
Do not repeatedly rerun a broad failing or hanging workspace command without a new hypothesis and a narrower confirming command.`;

  if (workspaceConfig && workspaceConfig.repos.length > 0) {
    return executionPrompt + `\n\n## Workspace mode\n` +
      `This project is a workspace containing multiple git repositories.\n` +
      `Available repos:\n` +
      workspaceConfig.repos.map((r: string) => `- \`${r}\``).join("\n") +
      `\n\nEvery configured repository is already checked out beneath this task's workspace directory at its repository-relative path. ` +
      /* FNXC:WorkspaceFinalization 2026-08-27-08:42: Completion refuses main-checkout COMMITS (they reach the shared branch unreviewed). Uncommitted main-checkout edits only warn — the merger already stashes/restores a dirty checkout — but they deliver nothing, so the acquired-worktree commit invariant still fails work that lives only there. */
      `Work exclusively inside those task-owned paths — never edit a repository's main checkout directly. Committing in a sub-repo main checkout refuses completion at \`fn_task_done\`: that commit would reach the shared branch without review. Uncommitted edits left in a main checkout are reported but deliver nothing — completion still requires commits in the task worktrees. Leave each main checkout as you found it.\n`;
  }

  return executionPrompt;
}

/**
 * Format a comment for injection into a running agent session.
 * Used for real-time steering during task execution.
 */
export function formatCommentForInjection(comment: import("@fusion/core").SteeringComment): string {
  const timestamp = formatTimestamp(comment.createdAt);
  return `📣 **New feedback** — ${timestamp} (${comment.author}):\n\n${comment.text}\n\nPlease adjust your approach based on this feedback.`;
}

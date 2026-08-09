/**
 * FNXC:CodeOrganization 2026-08-03-12:55:
 * attemptExecutorVerificationFix peeled from TaskExecutor (U4).
 *
 * Spawns a dedicated coding session to repair failing deterministic test/build
 * verification mid-execution, then re-runs full verification. Mirrors the merger
 * in-merge verification-fix pattern.
 *
 * FNXC:SessionRouting 2026-06-24-11:20:
 * Propagate task id so verification-fix requests share session affinity.
 *
 * FNXC:PluginSkills 2026-07-12-00:00:
 * Verification-fix sessions inherit plugin skill body dirs from task skill context.
 */
import type { Settings, Task, TaskStore } from "@fusion/core";
import { resolveExecutorFallbackModel, resolvePersistAgentThinkingLog } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";
import {
  createResolvedAgentSession,
  resolveExecutorSessionModel,
  resolveExecutorFallbackThinkingLevel,
  resolveExecutorThinkingLevel,
} from "../agents/agent-session-helpers.js";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import { accumulateSessionTokenUsage } from "../execution/session-token-usage.js";
import { VERIFICATION_LOG_MAX_CHARS } from "../execution/verification-utils.js";
import { withRateLimitRetry } from "../errors/rate-limit-retry.js";
import { describeModel, promptWithFallback } from "../pi.js";
import { executorLog } from "../logger.js";
import { createRunAuditor, type EngineRunContext } from "../util/run-audit.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import type { AgentStore } from "@fusion/core";

export type AttemptExecutorVerificationFixDeps = {
  store: TaskStore;
  agentStore?: AgentStore | null;
  pluginRunner?: PluginRunner;
  onAgentText?: ConstructorParameters<typeof AgentLogger>[0]["onAgentText"];
  onAgentTool?: ConstructorParameters<typeof AgentLogger>[0]["onAgentTool"];
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  getAssignedAgentRuntimeConfig: (agentId: string | null | undefined) => Promise<Record<string, unknown> | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP map shape owned by session helpers
  resolveMcpServers: (agentId?: string | null) => Promise<any>;
  runExecutorDeterministicVerification: (
    task: Task,
    worktreePath: string,
    settings: Settings,
    extraEnv?: NodeJS.ProcessEnv,
  ) => Promise<{ allPassed: boolean }>;
};

/**
 * Attempt to fix verification failures by spawning a dedicated AI fix agent.
 * Follows the pattern established by the merger's attemptInMergeVerificationFix.
 * Returns true if verification passes after the fix attempt, false otherwise.
 */
export async function attemptExecutorVerificationFix(
  deps: AttemptExecutorVerificationFixDeps,
  task: Task,
  worktreePath: string,
  failureContext: {
    command: string;
    exitCode: number | null;
    output: string;
    type: "test" | "build";
  },
  settings: Settings,
  retryNumber: number,
  maxRetries: number,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    executorLog.log(`${task.id}: spawning executor verification fix agent (attempt ${retryNumber}/${maxRetries})`);

    const logger = new AgentLogger({
      store: deps.store,
      taskId: task.id,
      agent: "executor",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      // Executor sessions are task-scoped ephemeral workers.
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: deps.onAgentText,
      onAgentTool: deps.onAgentTool,
    });

    // Build skill selection context
    let skillContext: Awaited<ReturnType<typeof buildSessionSkillContext>> | undefined;
    if (deps.agentStore) {
      try {
        skillContext = await buildSessionSkillContext({
          agentStore: deps.agentStore,
          task,
          sessionPurpose: "executor",
          projectRootDir: worktreePath,
          pluginRunner: deps.pluginRunner,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    // Resolve model using the executor's model hierarchy
    const assignedRuntimeConfig = await deps.getAssignedAgentRuntimeConfig(task.assignedAgentId);
    const executorSessionModel = resolveExecutorSessionModel(
      task.modelProvider,
      task.modelId,
      settings,
      assignedRuntimeConfig,
      task.credentialInstanceId,
    );
    const { provider: executorProvider, modelId: executorModelId } = executorSessionModel;

    const executorFallback = resolveExecutorFallbackModel(settings);

    // Create the fix agent session
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner: deps.pluginRunner,
      cwd: worktreePath, // Run in the task's worktree
      systemPrompt: `You are a verification fix agent running during task execution in a worktree.

All step-session steps completed successfully but the deterministic verification command failed. Your job is to fix the failing code directly in the working directory.

## Scope
Only fix what is required to make the failing verification pass.
Do not refactor, rename broadly, or make opportunistic improvements.

## Rules
1. Read the error output carefully to understand what is failing before editing anything
2. Before assuming a code fix is needed, check whether the failure is caused by stale/missing build artifacts in a sibling workspace package — typical signatures: \`Failed to resolve import "./X.js"\` pointing into another package's \`dist/\`, \`Cannot find module\`, or \`ERR_MODULE_NOT_FOUND\` referencing a workspace-internal path. In that case, rebuild the affected package(s) (e.g. \`pnpm --filter <pkg> build\`, or \`pnpm --filter "<scope>/*" build\` for a group) and re-run verification before editing source files.
3. Make targeted fixes to the failing code path
4. After fixing, run the verification command to confirm the fix works
5. Do NOT make any git commits — just fix the code
6. You MAY modify any files needed to make the verification pass, including files unrelated to this task's original change. Pre-existing build/test breakage is in scope: fix it. Prefer the smallest change that makes verification green.
7. If you cannot fix the issue within scope, explain why and what evidence indicates a deeper/root problem`,
      tools: "coding",
      onText: logger.onText,
      onThinking: logger.onThinking,
      onToolStart: logger.onToolStart,
      onToolEnd: logger.onToolEnd,
      defaultProvider: executorProvider,
      defaultModelId: executorModelId,
      ...(executorSessionModel.credentialInstanceId ? { credentialInstanceId: executorSessionModel.credentialInstanceId } : {}),
      fallbackProvider: executorFallback.provider,
      fallbackModelId: executorFallback.modelId,
      fallbackThinkingLevel: resolveExecutorFallbackThinkingLevel(task.thinkingLevel, settings),
      defaultThinkingLevel: resolveExecutorThinkingLevel(task.thinkingLevel, settings),
      runAuditor: createRunAuditor(deps.store, deps.getRunContextFor(task.id)),
      settings,
      taskEnv: extraEnv,
      mcpServers: await deps.resolveMcpServers(undefined),
      // FNXC:SessionRouting 2026-06-24-11:20:
      // #1675: propagate task id so verification-fix requests carry the same
      // X-Session-Id/X-Session-Affinity as the primary session.
      taskId: task.id,
      // FNXC:PluginSkills 2026-07-12-00:00: Verification-fix sessions share task skill selection; include plugin skill body dirs so fixes can use plugin-authored guidance.
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
    });

    await deps.store.logEntry(
      task.id,
      `Executor verification fix agent started (model: ${describeModel(session)}, attempt ${retryNumber}/${maxRetries})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
    await deps.store.appendAgentLog(
      task.id,
      `Fix agent started (model: ${describeModel(session)}, attempt ${retryNumber}/${maxRetries})`,
      "status",
      undefined,
      "executor",
    );

    try {
      // Build the fix prompt
      const fixPrompt = `Fix the failing ${failureContext.type} verification for task ${task.id}.

## Failed command
Command: \`${failureContext.command}\`
Exit code: ${failureContext.exitCode}

## Error output
${failureContext.output.slice(0, VERIFICATION_LOG_MAX_CHARS)}

## Instructions
1. Read the error output and identify the root cause
2. Make targeted fixes to resolve the failure
3. Run the verification command \`${failureContext.command}\` to confirm your fix works
4. If the fix doesn't work, try a different approach
5. Do NOT make any git commits`;

      // Run the agent with rate limit retry
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, fixPrompt);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} executor fix agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
      });
      await accumulateSessionTokenUsage(deps.store, task.id, session, {
        agentId: task.assignedAgentId ?? undefined,
        role: "executor",
      });

      // Re-run full deterministic verification (test AND build) after the fix attempt
      executorLog.log(`${task.id}: re-running deterministic verification after fix attempt ${retryNumber}/${maxRetries}`);
      await deps.store.logEntry(
        task.id,
        `Re-running deterministic verification (attempt ${retryNumber}/${maxRetries})`,
        undefined,
        deps.getRunContextFor(task.id),
      );
      await deps.store.appendAgentLog(
        task.id,
        `Re-running verification (attempt ${retryNumber}/${maxRetries})`,
        "status",
        undefined,
        "executor",
      );
      const reRunResult = await deps.runExecutorDeterministicVerification(task, worktreePath, settings, extraEnv);

      return reRunResult.allPassed;
    } finally {
      await logger.flush();
      session.dispose();
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.warn(`${task.id}: executor verification fix agent error: ${errorMessage}`);
    await deps.store.logEntry(
      task.id,
      `Executor verification fix agent encountered an error`,
      errorMessage,
      deps.getRunContextFor(task.id),
    );
    await deps.store.appendAgentLog(
      task.id,
      "Fix agent encountered an error",
      "tool_error",
      errorMessage,
      "executor",
    );
    return false;
  }
}

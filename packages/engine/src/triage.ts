/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskAttachment,
  Settings,
} from "@fusion/core";
import { buildTriageMemoryInstructions, resolveAgentPrompt } from "@fusion/core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { Type, type Static } from "@mariozechner/pi-ai";
import type {
  ToolDefinition,
  AgentSession,
} from "@mariozechner/pi-coding-agent";
import { createKbAgent, describeModel, promptWithFallback } from "./pi.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { PRIORITY_SPECIFY, type AgentSemaphore } from "./concurrency.js";
import { AgentLogger } from "./agent-logger.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import { triageLog, reviewerLog } from "./logger.js";
import {
  isUsageLimitError,
  checkSessionError,
  type UsageLimitPauser,
} from "./usage-limit-detector.js";
import { isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector } from "./stuck-task-detector.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryTools,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
} from "./agent-tools.js";

export const TRIAGE_SYSTEM_PROMPT = `You are a task specification agent for "fn", an AI-orchestrated task board.

Your job: take a rough task description and produce a fully specified PROMPT.md that another AI agent can execute autonomously in a fresh context with zero memory of this conversation.

## What you receive
- A raw task title and optional description (the user's rough idea)
- Access to the project's files so you can understand context

## What you produce
Write a complete PROMPT.md specification to the given path using the write tool.

## PROMPT.md Format

Follow this structure exactly:

\`\`\`markdown
# Task: {ID} - {Name}

**Created:** {YYYY-MM-DD}
**Size:** {S | M | L}

## Review Level: {0-3} ({None | Plan Only | Plan and Code | Full})

**Assessment:** {1-2 sentences explaining the score}
**Score:** {N}/8 — Blast radius: {N}, Pattern novelty: {N}, Security: {N}, Reversibility: {N}

## Mission

{One paragraph: what you're building and why it matters}

## Dependencies

- **None**
{OR}
- **Task:** {ID} ({what must be complete})

## Context to Read First

{List specific files the worker should read before starting — only what's needed}

## File Scope

{List files/directories the task will create or modify — be specific}

- \`path/to/file.ext\`
- \`path/to/directory/*\`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: {Name}

- [ ] {Specific, verifiable outcome}
- [ ] {Specific, verifiable outcome}
- [ ] Run targeted tests for changed files

**Artifacts:**
- \`path/to/file\` (new | modified)

### Step {N-1}: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.
> If keeping lint/tests/build/typecheck green requires edits outside the initial File Scope, make those fixes as part of this task.

- [ ] Run lint check (\`pnpm lint\`)
- [ ] Run full test suite
- [ ] Run project typecheck if available
- [ ] Fix all failures
- [ ] Build passes

### Step {N}: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Save documentation deliverables as task documents via \`task_document_write\` (key="docs", content=...)
- [ ] Out-of-scope findings created as new tasks via \`task_create\` tool

## Documentation Requirements

**Must Update:**
- \`path/to/doc.md\` — {what to add/change}

**Check If Affected:**
- \`path/to/doc.md\` — {update if relevant}

## Completion Criteria

- [ ] All steps complete
- [ ] Lint passing
- [ ] All tests passing
- [ ] Typecheck passing (if available)
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** \`feat({ID}): complete Step N — description\`
- **Bug fixes:** \`fix({ID}): description\`
- **Tests:** \`test({ID}): description\`

## Do NOT

- Expand task scope
- Skip tests
- Refuse necessary fixes just because they touch files outside the initial File Scope
- Commit without the task ID prefix
- Remove, delete, or gut modules, settings, interfaces, exports, or test files outside the File Scope
- Remove features as "cleanup" — if something seems unused, create a task via \`task_create\`

## Changeset Requirements

If this task REMOVES existing functionality (deleting modules, settings, API endpoints, or exports), a changeset file is REQUIRED:
- Create \`.changeset/{task-id}-removal.md\` explaining what was removed and why
- This is mandatory for any net-negative change (more deletions than additions to existing files)
\`\`\`

## Testing requirements

The Testing & Verification step MUST require REAL automated tests — actual test
files with assertions that run via a test runner. Typechecks and builds are NOT
tests. Manual verification is NOT a test.

- Each implementation step should include writing tests for the code being changed
- The final Testing step runs lint, the FULL test suite, and project typecheck when the repo exposes one
- Specs must instruct executors to fix lint failures and quality-gate failures directly, even when the required edits extend beyond the original File Scope
- If the project has no test framework, the Testing step must include setting one up
  as part of this task (not just skipping tests)

## Duplicate check
Before writing a spec, call \`task_list\` to see existing tasks.
If a task already covers the same work (even if worded differently), do NOT
write a PROMPT.md. Instead, write a single line to the output file:
\`DUPLICATE: {existing-task-id}\`

## Dependency awareness
When you plan to list a task in the \`## Dependencies\` section, first call \`task_get\` on that task ID to read its PROMPT.md.
Use what you learn — file scope, APIs, patterns, completion criteria — to make the new spec accurate: reference the right paths, avoid conflicting assumptions, and describe what the dependency must deliver before this task starts.
If the dependency task has no PROMPT.md yet (not yet specified), note that in the Dependencies section.

## Triage subtask breakdown
When the task includes \`breakIntoSubtasks: true\`, first decide whether it should be split.

- Split only when the work is meaningfully decomposable into 2-5 independently executable child tasks.
- If splitting: use the \`task_create\` tool to create child tasks in triage, include clear descriptions and dependencies between them, then stop. Do NOT write a PROMPT.md for the parent task.
- If not splitting: proceed with a normal PROMPT.md specification.

## Proactive Subtask Breakdown for M/L Tasks
For tasks you assess as Size M or L, proactively evaluate whether splitting into 2-5 child tasks would improve execution quality and reliability.

**Strongly recommend splitting when ANY of these apply:**
- The task will require MORE THAN 7 implementation steps
- The task affects MORE THAN 3 different packages/modules
- Any single step would take more than 1-2 hours to complete
- The task has multiple independent deliverables that could be developed in parallel

**ANTI-PATTERN:** Avoid writing single tasks with 10+ steps. If you find yourself planning more than 7 steps, STOP and create 2-5 child tasks instead.

**Splitting guidance:**
- Even when \`breakIntoSubtasks\` is not set to \`true\`, apply these thresholds proactively
- Keep explicit user intent first: when \`breakIntoSubtasks: true\`, follow the mandatory breakdown flow above
- Size S tasks should generally NOT be split because the overhead usually outweighs the benefit
- Only keep a task as one unit if it genuinely has 5 or fewer focused steps with a clear scope
- If you decide not to split an M/L task, proceed with a normal PROMPT.md specification

## Triage tools
You have these extra tools during triage:
- \`task_list\` — list existing active tasks
- \`task_get\` — inspect a task and its PROMPT.md
- \`task_create\` — create a child/follow-up task while triaging
- \`task_document_write\` — save a planning document (e.g., key="plan")
- \`task_document_read\` — read back a previously saved document

When the planning conversation produces a structured plan, save it as a document with \`task_document_write(key='plan', content='...')\` so the executor can reference it during implementation.

## Guidelines
- Read the project structure and relevant source files to understand context BEFORE writing
- Be specific — name actual files, functions, and patterns from the codebase
- Steps should express OUTCOMES, not micro-instructions (2-5 checkboxes per step)
- Always include a testing step and a documentation step
- For tasks whose primary deliverable is documentation (updating docs, writing README, API references), include an explicit step or checkbox instructing the executor to save the final documentation content via \`task_document_write\`
- Include a "Do NOT" section with project-appropriate guardrails
- Size assessment: S (<2h), M (2-4h), L (4-8h). Split if XL (8h+)
- Review level scoring: Blast radius (0-2), Pattern novelty (0-2), Security (0-2), Reversibility (0-2)
  - 0-1 → Level 0, 2-3 → Level 1, 4-5 → Level 2, 6-8 → Level 3

## Project commands
When the user prompt includes a "Project Commands" section with test and/or build
commands, use those EXACT commands in the testing/verification steps and anywhere
the spec references running tests or builds. Do NOT guess or infer commands from
package.json when explicit commands are provided.

## Spec Review

After writing the PROMPT.md, call \`review_spec()\` to get an independent quality review.

- **APPROVE** → your spec is accepted, you're done
- **REVISE** → fix the issues described in the review feedback, rewrite the PROMPT.md, and call \`review_spec()\` again. Repeat until approved.
- **RETHINK** → your approach was fundamentally rejected. The conversation will rewind. Read the feedback carefully and take a completely different approach. Do NOT repeat the rejected strategy.

You MUST call \`review_spec()\` after writing the PROMPT.md. Do not finish without getting an APPROVE verdict.

## Output
Write the PROMPT.md directly using the write tool, then call \`review_spec()\` for review.`;

export interface TriageProcessorOptions {
  pollIntervalMs?: number;
  semaphore?: AgentSemaphore;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Stuck task detector — monitors triage sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  onSpecifyStart?: (task: Task) => void;
  onSpecifyComplete?: (task: Task) => void;
  onSpecifyError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
}

/**
 * Processes tasks in the triage column by running an AI agent to generate
 * a full PROMPT.md specification.
 *
 * **Dynamic poll interval:** On every `poll()` call the processor reads
 * `pollIntervalMs` from the persisted store settings (`store.getSettings()`).
 * If the value has changed since the last cycle the `setInterval` timer is
 * transparently restarted, so dashboard setting changes take effect without
 * an engine restart.
 */
export class TriageProcessor {
  private running = false;
  private polling = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** The interval (ms) of the currently active `setInterval` timer. */
  private activePollMs: number | null = null;
  private processing = new Set<string>();
  /** Timestamps when tasks entered the `processing` set, for staleness detection. */
  private processingSince = new Map<string, number>();
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  /** Active agent sessions per task, used to terminate on pause. */
  private activeSessions = new Map<string, { dispose: () => void }>();
  /** Tasks aborted due to globalPause (to avoid reporting as errors). */
  private pauseAborted = new Set<string>();
  /** Tasks killed by the stuck task detector (to avoid reporting as errors). */
  private stuckAborted = new Set<string>();

  /**
   * @param store — Task store instance (also used to listen for `settings:updated` events)
   * @param rootDir — Project root directory
   * @param options — Processor configuration
   *
   * Listens for `settings:updated` events: when `globalPause` transitions from
   * `false` to `true`, all active triage specification sessions are immediately
   * terminated. When `enginePaused` transitions, only new work dispatch is
   * affected — running sessions continue to completion.
   */
  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TriageProcessorOptions = {},
  ) {
    // When globalPause transitions from false → true, terminate all active triage sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        for (const [taskId, session] of this.activeSessions) {
          triageLog.log(
            `Global pause — terminating triage session for ${taskId}`,
          );
          this.pauseAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          session.dispose();
        }
      }
    });

    /**
     * Immediate unpause resume: when `globalPause` transitions from `true`
     * to `false`, trigger a triage poll right away instead of waiting for
     * the next poll interval (up to 15 s). Only reacts to true→false
     * transitions — no-ops on false→false and true→true.
     *
     * The re-entrance guard (`this.polling`) inside `poll()` safely drops
     * the call if a poll-based pass is already in flight.
     */
    store.on("settings:updated", ({ settings, previous }) => {
      if (previous.globalPause && !settings.globalPause && this.running) {
        this.poll();
      }
    });

    /**
     * Immediate engine-unpause resume: when `enginePaused` transitions from
     * `true` to `false`, trigger a triage poll right away instead of
     * waiting for the next poll interval. Same pattern as the globalPause
     * unpause handler above.
     */
    store.on("settings:updated", ({ settings, previous }) => {
      if (previous.enginePaused && !settings.enginePaused && this.running) {
        this.poll();
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Clear stale "specifying" statuses left by a prior crash/restart.
    // No triage agent is actually running at startup, so any task still
    // marked as "specifying" is a leftover from a previous engine lifecycle.
    // Without this, stale statuses consume concurrency slots and block
    // new triage work indefinitely.
    this.clearStaleSpecifyingStatuses().catch((err) => {
      triageLog.error("Failed to clear stale specifying statuses:", err);
    });

    const interval = this.options.pollIntervalMs ?? 10_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.poll();
    triageLog.log("Processor started");
  }

  private async clearStaleSpecifyingStatuses(): Promise<void> {
    const tasks = await this.store.listTasks({ column: "triage", slim: true });
    const stale = tasks.filter(
      (t) => t.status === "specifying" && !this.processing.has(t.id),
    );
    for (const t of stale) {
      triageLog.log(`Startup sweep: clearing stale 'specifying' status on ${t.id}`);
      await this.store.updateTask(t.id, { status: null });
    }
    if (stale.length > 0) {
      triageLog.log(`Startup sweep: cleared ${stale.length} stale specifying task(s)`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.activePollMs = null;
    }
    triageLog.log("Processor stopped");
  }

  /**
   * Mark a task as stuck-aborted so the catch block knows not to treat
   * the disposed session as a genuine failure.
   * Called by the stuck task detector's onStuck callback.
   */
  markStuckAborted(taskId: string): void {
    this.stuckAborted.add(taskId);
  }

  /**
   * Return a snapshot of tasks currently being specified by this processor.
   * Used by self-healing maintenance to avoid recovering live sessions.
   */
  getProcessingTaskIds(): Set<string> {
    return new Set(this.processing);
  }

  /**
   * Maximum time a task can remain in the `processing` set before it's
   * considered stale (30 minutes). By this point the stuck detector
   * (default 20-min timeout) should have already killed the session
   * and the `finally` block should have cleaned up. If it hasn't,
   * the promise is hung (e.g., `promptWithFallback` never settled
   * after dispose) and self-healing recovery needs to force-evict it.
   */
  private static readonly STALE_PROCESSING_THRESHOLD_MS = 30 * 60 * 1000;

  /**
   * Evict tasks from the `processing` set that have been there longer than
   * the staleness threshold. This handles the case where a stuck-kill
   * disposes the session but the `specifyTask` promise never settles
   * (hung `promptWithFallback`), leaving the task in `processing` forever
   * and blocking self-healing recovery.
   *
   * @returns the set of evicted task IDs
   */
  evictStaleProcessing(): Set<string> {
    const now = Date.now();
    const threshold = TriageProcessor.STALE_PROCESSING_THRESHOLD_MS;
    const evicted = new Set<string>();

    for (const [taskId, since] of this.processingSince) {
      if (now - since >= threshold) {
        triageLog.warn(
          `${taskId} has been in processing for ${Math.round((now - since) / 60_000)}min ` +
          `(threshold: ${Math.round(threshold / 60_000)}min) — evicting (likely hung promise)`,
        );
        this.processing.delete(taskId);
        this.processingSince.delete(taskId);
        this.activeSessions.delete(taskId);
        this.stuckAborted.delete(taskId);
        evicted.add(taskId);
      }
    }

    return evicted;
  }

  /**
   * Recover a triage task whose spec was already approved but the final
   * handoff out of `status: "specifying"` never completed.
   */
  async recoverApprovedTask(task: Task): Promise<boolean> {
    if (task.column !== "triage" || task.status !== "specifying") {
      return false;
    }

    if (!hasLatestSpecReviewApproval(task)) {
      return false;
    }

    const settings = await this.store.getSettings();
    const promptPath = join(this.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    const written = await readFile(promptPath, "utf-8").catch(() => "");

    if (!written.trim()) {
      triageLog.warn(`${task.id} approved-spec recovery skipped — PROMPT.md missing or empty`);
      return false;
    }

    await this.finalizeApprovedTask(task, written, settings, {
      recoveryLogAction: settings.requirePlanApproval
        ? "Auto-recovered approved specification stuck in specifying — awaiting manual approval"
        : "Auto-recovered approved specification stuck in specifying — moved to todo",
    });

    return true;
  }

  /**
   * If `newIntervalMs` differs from the currently active timer, restart
   * the `setInterval` so the new cadence takes effect immediately.
   */
  private refreshPollInterval(newIntervalMs?: number): void {
    if (!this.running || !newIntervalMs) return;
    if (newIntervalMs === this.activePollMs) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.activePollMs = newIntervalMs;
    this.pollInterval = setInterval(() => this.poll(), newIntervalMs);
    triageLog.log(`Poll interval updated to ${newIntervalMs}ms`);
  }

  /**
   * Discover triage tasks and dispatch `specifyTask()` for each one.
   *
   * **Concurrent dispatch:** `specifyTask()` calls are fired without awaiting,
   * so multiple triage tasks can be specified concurrently (bounded by the
   * shared `AgentSemaphore`). The `polling` re-entrance guard prevents
   * overlapping discovery cycles, but resets as soon as dispatch completes —
   * well before the dispatched tasks finish — so subsequent polls can discover
   * newly arrived triage tasks promptly.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;
    if (this.polling) return;
    this.polling = true;

    try {
      const settings = await this.store.getSettings();
      this.refreshPollInterval(settings.pollIntervalMs);

      // Global pause (hard stop): halt all triage activity
      if (settings.globalPause) {
        if (!this.wasGlobalPaused) {
          triageLog.log("Global pause active — triage halted");
          this.wasGlobalPaused = true;
        }
        return;
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new triage work, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          triageLog.log(
            "Engine paused — triage halted (in-flight agents continue)",
          );
          this.wasEnginePaused = true;
        }
        return;
      }
      this.wasEnginePaused = false;

      // Fetch all tasks (not just triage) to count active agents across columns.
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const now = Date.now();
      const triageTasks = allTasks.filter(
        (t) => t.column === "triage" && !this.processing.has(t.id) && !t.paused
          // Skip tasks awaiting manual plan approval — they should not be auto-discovered
          && t.status !== "awaiting-approval"
          // Skip failed specifications until the user explicitly retries them.
          && t.status !== "failed"
          && t.status !== "stuck-killed"
          // Skip tasks with a recovery backoff that hasn't elapsed yet
          && !(t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now),
      );

      // Respect both per-project maxTriageConcurrent and the global semaphore.
      // Only specifying tasks count against the triage limit; execution is governed by maxConcurrent.
      const maxTriageConcurrent = settings.maxTriageConcurrent ?? settings.maxConcurrent ?? 2;
      const specifying = allTasks.filter(
        (t) => t.column === "triage" && t.status === "specifying" && !t.paused,
      ).length;
      const activeAgents = specifying;

      const perProjectAvailable = Math.max(0, maxTriageConcurrent - activeAgents);
      const semaphoreAvailable = this.options.semaphore
        ? Math.max(0, this.options.semaphore.availableCount)
        : Infinity;
      const maxToStart = Math.min(perProjectAvailable, semaphoreAvailable);

      if (maxToStart <= 0 && triageTasks.length > 0) {
        triageLog.log(
          `Triage throttled: ${activeAgents} specifying agents, limit ${maxTriageConcurrent}`,
        );
      }

      for (let i = 0; i < Math.min(triageTasks.length, maxToStart); i++) {
        void this.specifyTask(triageTasks[i]);
      }
    } catch (err) {
      triageLog.error("Poll error:", err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Specify a triage task by spawning an AI agent to generate a PROMPT.md.
   *
   * After the agent writes the PROMPT.md, it calls `review_spec()` to spawn
   * an independent reviewer agent that evaluates the specification quality.
   * The review loop works as follows:
   * - **APPROVE**: the spec is accepted and the task moves to `todo`
   * - **REVISE**: the agent revises the spec and calls `review_spec()` again.
   *   If the agent finishes without getting APPROVE, the task is NOT moved to
   *   `todo` — a post-session gate requires an explicit APPROVE verdict.
   * - **RETHINK**: the conversation rewinds to a pre-specification checkpoint
   *   and the agent starts over with a fundamentally different approach.
   */
  async specifyTask(task: Task): Promise<void> {
    if (this.processing.has(task.id)) return;
    this.processing.add(task.id);
    this.processingSince.set(task.id, Date.now());

    triageLog.log(
      `Specifying ${task.id}: ${task.title || task.description.slice(0, 60)}`,
    );
    this.options.onSpecifyStart?.(task);

    try {
      const detail = await this.store.getTask(task.id);
      const settings = await this.store.getSettings();
      const promptPath = `.fusion/tasks/${task.id}/PROMPT.md`;

      const agentWork = async () => {
        // Set status only after the semaphore slot has been acquired, so
        // tasks waiting in the queue don't appear as "specifying".
        await this.store.updateTask(task.id, { status: "specifying" });

        const stuckDetector = this.options.stuckTaskDetector;

        const agentLogger = new AgentLogger({
          store: this.store,
          taskId: task.id,
          agent: "triage",
          onAgentText: (id, delta) => {
            stuckDetector?.recordActivity(task.id);
            this.options.onAgentText?.(id, delta);
          },
          onAgentTool: (_id, _name) => {
            stuckDetector?.recordActivity(task.id);
            // Tool events are persisted via AgentLogger (tool/tool_result/tool_error)
            // for fn task logs and agent log history — no stdout spam
          },
        });

        // Mutable ref — populated after createKbAgent, tools access lazily via closure
        const sessionRef: { current: AgentSession | null } = { current: null };
        // Checkpoint for RETHINK rewind — captured lazily on first review_spec call
        const checkpointRef: { current: string | null } = { current: null };
        // Track the last spec review verdict for post-session enforcement
        const specReviewVerdictRef: { current: ReviewVerdict | null } = {
          current: null,
        };
        // Track the user-comment fingerprint at the time of APPROVE for stale-approval detection
        const approvedCommentFingerprintRef: { current: string } = {
          current: "",
        };
        // Track subtasks created during triage when breakIntoSubtasks was requested.
        const createdSubtasksRef: { current: string[] } = { current: [] };

        const customTools = [
          ...this.createTriageTools({
            parentTaskId: task.id,
            allowTaskCreate: true,
            createdSubtasksRef,
          }),
          createTaskDocumentWriteTool(this.store, task.id),
          createTaskDocumentReadTool(this.store, task.id),
          ...createMemoryTools(this.rootDir, settings),
          this.createReviewSpecTool(
            task.id,
            promptPath,
            sessionRef,
            checkpointRef,
            specReviewVerdictRef,
            approvedCommentFingerprintRef,
            settings,
          ),
        ];

        // Resolve per-agent custom instructions for the triage role
        let triageInstructions = "";
        if (this.options.agentStore) {
          try {
            const agents = await this.options.agentStore.listAgents({ role: "triage" });
            for (const agent of agents) {
              if (agent.instructionsText || agent.instructionsPath) {
                triageInstructions = await resolveAgentInstructions(agent, this.rootDir);
                break;
              }
            }
          } catch {
            // Graceful fallback
          }
        }
        const triageSystemPrompt = buildSystemPromptWithInstructions(
          resolveAgentPrompt("triage", settings.agentPrompts) || TRIAGE_SYSTEM_PROMPT,
          triageInstructions,
        );

        // Build skill selection context (assigned agent skills take precedence over role fallback)
        const skillContext = await buildSessionSkillContext({
          agentStore: this.options.agentStore!,
          task,
          sessionPurpose: "triage",
          projectRootDir: this.rootDir,
        });

        let { session } = await createKbAgent({
          cwd: this.rootDir,
          systemPrompt: triageSystemPrompt,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onThinking: agentLogger.onThinking,
          onToolStart: agentLogger.onToolStart,
          onToolEnd: agentLogger.onToolEnd,
          // Resolve planning model using canonical lane hierarchy:
          // 1. Task planning override pair (planningModelProvider + planningModelId)
          // 2. Project planning override pair (planningProvider + planningModelId)
          // 3. Global planning lane pair (planningGlobalProvider + planningGlobalModelId)
          // 4. Default pair (defaultProvider + defaultModelId)
          defaultProvider: task.planningModelProvider && task.planningModelId
            ? task.planningModelProvider
            : (settings.planningProvider && settings.planningModelId
                ? settings.planningProvider
                : (settings.planningGlobalProvider && settings.planningGlobalModelId
                    ? settings.planningGlobalProvider
                    : settings.defaultProvider)),
          defaultModelId: task.planningModelProvider && task.planningModelId
            ? task.planningModelId
            : (settings.planningProvider && settings.planningModelId
                ? settings.planningModelId
                : (settings.planningGlobalProvider && settings.planningGlobalModelId
                    ? settings.planningGlobalModelId
                    : settings.defaultModelId)),
          fallbackProvider: settings.planningFallbackProvider && settings.planningFallbackModelId
            ? settings.planningFallbackProvider
            : settings.fallbackProvider,
          fallbackModelId: settings.planningFallbackProvider && settings.planningFallbackModelId
            ? settings.planningFallbackModelId
            : settings.fallbackModelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
          // Skill selection: use assigned agent skills if available, otherwise role fallback
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
        });

        const modelDesc = describeModel(session);
        triageLog.log(`${task.id}: using model ${modelDesc}`);
        await this.store.logEntry(task.id, `Triage using model: ${modelDesc}`);
        await this.store.appendAgentLog(
          task.id,
          `Triage using model: ${modelDesc}`,
          "text",
          undefined,
          "triage",
        );

        // Make session available to review_spec tool (for RETHINK rewind)
        sessionRef.current = session;

        // Register session so the global pause listener can terminate it
        this.activeSessions.set(task.id, session);

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        stuckDetector?.recordActivity(task.id);

        try {
          // Read attachment contents for inlining in prompt
          const { attachmentContents, imageContents } =
            await readAttachmentContents(
              this.rootDir,
              detail.id,
              detail.attachments,
            );

          // Check if this is a re-specification request
          const isRespecify = task.status === "needs-respecify";
          let existingPrompt: string | undefined;
          let feedback: string | undefined;

          if (isRespecify) {
            // Extract feedback from the most recent "AI spec revision requested" log entry
            const revisionLogEntry = [...task.log]
              .reverse()
              .find((entry) => entry.action === "AI spec revision requested");
            feedback = revisionLogEntry?.outcome;

            triageLog.log(
              `${task.id} re-specifying with feedback: ${feedback?.slice(0, 100)}...`,
            );
          }

          const agentPrompt = buildSpecificationPrompt(
            detail,
            promptPath,
            settings,
            attachmentContents,
            existingPrompt,
            feedback,
          );
          await promptWithFallback(
            session,
            agentPrompt,
            imageContents.length > 0 ? { images: imageContents } : undefined,
          );

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          checkSessionError(session);

          if (this.pauseAborted.has(task.id)) {
            this.pauseAborted.delete(task.id);
            triageLog.log(`${task.id} aborted by pause — clearing status`);
            const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
            await this.store.updateTask(task.id, { status: restoreStatus }).catch(() => {});
            return;
          }

          if (this.stuckAborted.has(task.id)) {
            this.stuckAborted.delete(task.id);
            triageLog.log(`${task.id} killed by stuck detector — clearing status for retry`);
            const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
            await this.store.updateTask(task.id, { status: restoreStatus }).catch(() => {});
            return;
          }

          if (createdSubtasksRef.current.length > 0) {
            const childTaskIds = createdSubtasksRef.current.join(", ");
            await this.store.logEntry(
              task.id,
              `Converted into subtasks: ${childTaskIds}`,
            );
            await this.store.deleteTask(task.id);
            triageLog.log(`✓ ${task.id} split into subtasks (${childTaskIds}) and closed`);
            return;
          }

          const planningFallbackProvider = settings.planningFallbackProvider;
          const planningFallbackModelId = settings.planningFallbackModelId;
          const canRetryWithPlanningFallback =
            specReviewVerdictRef.current !== "APPROVE" &&
            planningFallbackProvider &&
            planningFallbackModelId &&
            modelDesc !== `${planningFallbackProvider}/${planningFallbackModelId}`;

          if (canRetryWithPlanningFallback) {
            const verdictDesc =
              specReviewVerdictRef.current === null
                ? "review_spec was never called"
                : `verdict was ${specReviewVerdictRef.current}`;
            const fallbackDesc = `${planningFallbackProvider}/${planningFallbackModelId}`;
            triageLog.warn(
              `${task.id} primary planning model produced no approved spec (${verdictDesc}) — retrying with fallback ${fallbackDesc}`,
            );
            await this.store.logEntry(
              task.id,
              `Primary planning model produced no approved spec (${verdictDesc}) — retrying with fallback ${fallbackDesc}`,
            );

            session.dispose();
            this.activeSessions.delete(task.id);
            stuckDetector?.untrackTask(task.id);
            specReviewVerdictRef.current = null;
            approvedCommentFingerprintRef.current = "";

            const fallbackResult = await createKbAgent({
              cwd: this.rootDir,
              systemPrompt: triageSystemPrompt,
              tools: "coding",
              customTools,
              onText: agentLogger.onText,
              onThinking: agentLogger.onThinking,
              onToolStart: agentLogger.onToolStart,
              onToolEnd: agentLogger.onToolEnd,
              defaultProvider: planningFallbackProvider,
              defaultModelId: planningFallbackModelId,
              defaultThinkingLevel: settings.defaultThinkingLevel,
              ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            });

            session = fallbackResult.session;
            const fallbackModelDesc = describeModel(session);
            triageLog.log(`${task.id}: using fallback model ${fallbackModelDesc}`);
            await this.store.logEntry(task.id, `Triage using fallback model: ${fallbackModelDesc}`);
            await this.store.appendAgentLog(
              task.id,
              `Triage using fallback model: ${fallbackModelDesc}`,
              "text",
              undefined,
              "triage",
            );

            sessionRef.current = session;
            this.activeSessions.set(task.id, session);
            stuckDetector?.trackTask(task.id, session);
            stuckDetector?.recordActivity(task.id);

            await promptWithFallback(
              session,
              agentPrompt,
              imageContents.length > 0 ? { images: imageContents } : undefined,
            );
            checkSessionError(session);

            if (createdSubtasksRef.current.length > 0) {
              const childTaskIds = createdSubtasksRef.current.join(", ");
              await this.store.logEntry(
                task.id,
                `Converted into subtasks: ${childTaskIds}`,
              );
              await this.store.deleteTask(task.id);
              triageLog.log(`✓ ${task.id} split into subtasks (${childTaskIds}) and closed`);
              return;
            }
          }

          // Post-session APPROVE gate: only advance to todo when the spec
          // reviewer explicitly approved.  Any other verdict (REVISE,
          // RETHINK, UNAVAILABLE) or a missing review (null) keeps the task
          // in triage so unreviewed / rejected specs never reach execution.
          if (specReviewVerdictRef.current !== "APPROVE") {
            const verdictDesc =
              specReviewVerdictRef.current === null
                ? "review_spec was never called"
                : `verdict was ${specReviewVerdictRef.current}`;
            const failureMessage =
              `Specification failed: spec review not approved (${verdictDesc}). ` +
              "Retry after adjusting the task prompt or model.";
            triageLog.log(
              `${task.id} spec review not approved (${verdictDesc}) — marking specification failed`,
            );
            await this.store.logEntry(
              task.id,
              failureMessage,
            );
            await this.store.updateTask(task.id, {
              status: "failed",
              error: failureMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            return;
          }

          // Stale-approval detection: re-read the task to check if new user
          // comments arrived after the spec was approved.  If the comment
          // fingerprint changed, the approval is stale and the task needs
          // re-specification.
          const latestTask = await this.store.getTask(task.id);
          const currentFingerprint = computeUserCommentFingerprint(latestTask.comments);
          if (currentFingerprint !== approvedCommentFingerprintRef.current) {
            triageLog.log(
              `${task.id} stale approval detected — user comments changed after approval, triggering re-specification`,
            );
            await this.store.logEntry(
              task.id,
              "Spec approval invalidated — new user comments arrived after approval. Task needs re-specification.",
            );
            await this.store.updateTask(task.id, { status: "needs-respecify" });
            return;
          }

          const written = await readFile(
            join(this.rootDir, promptPath),
            "utf-8",
          ).catch(() => "");

          await this.finalizeApprovedTask(task, written, settings, {
            isRespecify,
            feedback,
          });
          this.options.onSpecifyComplete?.(task);
        } finally {
          this.activeSessions.delete(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          session.dispose();
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          triageLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`).catch(() => {});
        },
      });

      if (this.options.semaphore) {
        await this.options.semaphore.run(retryableWork, PRIORITY_SPECIFY);
      } else {
        await retryableWork();
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Race condition: task was deleted (e.g. as a duplicate) between listTasks()
      // and specifyTask(). The file is gone, so just log and skip — no point retrying.
      if ((err as Record<string, unknown>).code === "ENOENT") {
        triageLog.log(`${task.id} no longer exists — skipping`);
      } else if (this.pauseAborted.has(task.id)) {
        // Pause (global or engine) — clear specifying status without reporting an error
        this.pauseAborted.delete(task.id);
        triageLog.log(`${task.id} aborted by pause — clearing status`);
        // For re-specification, restore needs-respecify status; otherwise clear to null
        // so the next poll can re-pick this task up.
        const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch(() => {});
      } else if (this.stuckAborted.has(task.id)) {
        // Stuck task detector killed this session — clear specifying status so the
        // next poll retries the task from scratch without reporting an error.
        this.stuckAborted.delete(task.id);
        triageLog.log(`${task.id} killed by stuck detector — clearing status for retry`);
        const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch(() => {});
      } else {
        // Check if the error is a usage-limit error and trigger global pause
        if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit(
            "triage",
            task.id,
            errorMessage,
          );
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              triageLog.warn(`⚡ ${task.id} transient error during triage — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await this.store.logEntry(task.id, `Transient error during specification (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`).catch(() => {});
            }
            const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
            await this.store.updateTask(task.id, {
              status: restoreStatus,
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
            }).catch(() => {});
            return;
          }

          // Recovery budget exhausted — freeze in triage with error for manual intervention
          triageLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(task.id, `Specification failed after ${MAX_RECOVERY_RETRIES} transient errors: ${errorMessage}`).catch(() => {});
          await this.store.updateTask(task.id, {
            error: `Specification failed after ${MAX_RECOVERY_RETRIES} transient errors: ${errorMessage}`,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          }).catch(() => {});
          this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        // For re-specification, restore needs-respecify status so it can be retried;
        // otherwise clear to null so the next poll can re-pick the task up.
        const restoreStatus = task.status === "needs-respecify" ? "needs-respecify" : null;
        await this.store.updateTask(task.id, { status: restoreStatus }).catch(() => {});
        triageLog.error(`✗ ${task.id} specification failed:`, errorMessage);
        this.options.onSpecifyError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      this.processing.delete(task.id);
      this.processingSince.delete(task.id);
    }
  }

  private createTriageTools(options: {
    parentTaskId: string;
    allowTaskCreate: boolean;
    createdSubtasksRef: { current: string[] };
  }): ToolDefinition[] {
    const store = this.store;

    const taskGetParams = Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    });
    const taskCreateParams = Type.Object({
      title: Type.Optional(Type.String({ description: "Short child task title" })),
      description: Type.String({ description: "Child task description/mission" }),
      dependencies: Type.Optional(
        Type.Array(Type.String({ description: "Task ID dependency (e.g. KB-001)" })),
      ),
    });

    const taskList: ToolDefinition = {
      name: "task_list",
      label: "List Tasks",
      description:
        "List all tasks that aren't done. Returns ID, description, column, " +
        "and dependencies for each. Use to check for duplicates before specifying.",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = await store.listTasks({ slim: true, includeArchived: false });
        const active = tasks.filter((t) => t.column !== "done");
        if (active.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active tasks." }],
            details: {},
          };
        }
        const lines = active.map((t) => {
          const desc = t.title || t.description.slice(0, 80);
          const deps = t.dependencies.length
            ? ` [deps: ${t.dependencies.join(", ")}]`
            : "";
          return `${t.id} (${t.column}): ${desc}${deps}`;
        });
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {},
        };
      },
    };

    const taskGet: ToolDefinition = {
      name: "task_get",
      label: "Get Task",
      description:
        "Get full details of a specific task including its PROMPT.md content. " +
        "Use to verify duplicates and to read dependency task specs before writing a new PROMPT.md.",
      parameters: taskGetParams,
      execute: async (
        _callId: string,
        params: Static<typeof taskGetParams>,
      ) => {
        try {
          const task = await store.getTask(params.id);
          const parts = [
            `ID: ${task.id}`,
            `Column: ${task.column}`,
            `Description: ${task.description}`,
            task.dependencies.length
              ? `Dependencies: ${task.dependencies.join(", ")}`
              : null,
            "",
            "PROMPT.md:",
            task.prompt || "(not yet specified)",
          ].filter(Boolean);
          return {
            content: [{ type: "text" as const, text: parts.join("\n") }],
            details: {},
          };
        } catch {
          return {
            content: [
              { type: "text" as const, text: `Task ${params.id} not found.` },
            ],
            details: {},
          };
        }
      },
    };

    const taskCreate: ToolDefinition = {
      name: "task_create",
      label: "Create Child Task",
      description:
        "Create a child task (subtask) while breaking a larger task into smaller pieces. " +
        "Use this when the work can be split into 2-5 independently executable tasks, " +
        "either because the user requested subtask breakdown or because the task is " +
        "oversized (8+ steps, 3+ packages, multiple independent deliverables). " +
        "The created task will be a child of the current task being triaged.",
      parameters: taskCreateParams,
      execute: async (
        _callId: string,
        params: Static<typeof taskCreateParams>,
      ) => {
        // task_create is always available during triage to support both
        // explicit breakIntoSubtasks and proactive splitting of oversized tasks.
        try {
          // Fetch parent task to inherit model settings
          let parentTask: Awaited<ReturnType<typeof store.getTask>> | undefined;
          try {
            parentTask = await store.getTask(options.parentTaskId);
          } catch {
            // Parent task not found or error - proceed without inheritance
            parentTask = undefined;
          }

          const newTask = await store.createTask({
            title: params.title,
            description: params.description,
            dependencies: params.dependencies || [],
            column: "triage",
            // Inherit parent's model settings if available
            modelProvider: parentTask?.modelProvider,
            modelId: parentTask?.modelId,
            validatorModelProvider: parentTask?.validatorModelProvider,
            validatorModelId: parentTask?.validatorModelId,
          });

          // Track the created subtask
          options.createdSubtasksRef.current.push(newTask.id);

          return {
            content: [
              {
                type: "text" as const,
                text: `Created child task ${newTask.id}: ${params.title || params.description.slice(0, 60)}`,
              },
            ],
            details: { taskId: newTask.id },
          };
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `ERROR: Failed to create task: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    };

    return [taskList, taskGet, taskCreate];
  }

  /**
   * Create the `review_spec` tool for the triage agent.
   *
   * Spawns an independent reviewer agent to evaluate the generated PROMPT.md.
   * Verdict handling:
   * - **APPROVE**: returns "APPROVE" — the triage agent's work is done.
   * - **REVISE**: returns the review feedback. The triage agent must fix the
   *   PROMPT.md and call `review_spec` again. A post-session gate in
   *   `specifyTask()` prevents moving to `todo` if the last verdict is REVISE.
   * - **RETHINK**: rewinds the conversation to a pre-specification checkpoint
   *   using `session.navigateTree()`. Returns a re-prompt instructing the agent
   *   to take a fundamentally different approach.
   */
  private createReviewSpecTool(
    taskId: string,
    promptPath: string,
    sessionRef: { current: AgentSession | null },
    checkpointRef: { current: string | null },
    specReviewVerdictRef: { current: ReviewVerdict | null },
    approvedCommentFingerprintRef: { current: string },
    _settings: {
      defaultProvider?: string;
      defaultModelId?: string;
      defaultThinkingLevel?: string;
      validatorProvider?: string;
      validatorModelId?: string;
    },
  ): ToolDefinition {
    const store = this.store;
    const rootDir = this.rootDir;
    const options = this.options;

    return {
      name: "review_spec",
      label: "Review Specification",
      description:
        "Spawn a reviewer agent to evaluate the generated PROMPT.md specification. " +
        "Returns APPROVE, REVISE, RETHINK, or UNAVAILABLE. " +
        "Call after writing the PROMPT.md.",
      parameters: Type.Object({}),
      execute: async () => {
        reviewerLog.log(`${taskId}: spec review requested`);
        await store.logEntry(taskId, "Spec review requested");

        // Capture checkpoint lazily on first call — at this point the session
        // has already started and has a valid conversation state to rewind to.
        if (!checkpointRef.current && sessionRef.current) {
          checkpointRef.current =
            sessionRef.current.sessionManager.getLeafId() ?? null;
        }

        try {
          // Read the generated PROMPT.md from disk
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const promptContent = await readFile(
            join(rootDir, promptPath),
            "utf-8",
          ).catch(() => "");

          if (!promptContent) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "UNAVAILABLE — PROMPT.md file not found or empty. Write the specification first, then call review_spec.",
                },
              ],
              details: {},
            };
          }

          // Re-read settings at review time so long-lived triage sessions pick up
          // model changes made after the session started.
          const currentSettings = await store.getSettings();

          // Re-read task detail to get latest user comments for the reviewer
          const currentDetail = await store.getTask(taskId);
          const currentUserComments = (currentDetail.comments || []).filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c: any) => c.author === "user",
          );

          const result = await reviewStep(
            rootDir,
            taskId,
            0,
            "Specification",
            "spec",
            promptContent,
            undefined,
            {
              onText: (delta) => options.onAgentText?.(taskId, delta),
              // Execution defaults as final fallback
              defaultProvider: currentSettings.defaultProvider,
              defaultModelId: currentSettings.defaultModelId,
              // Project-level validator override
              projectValidatorProvider: currentSettings.validatorProvider,
              projectValidatorModelId: currentSettings.validatorModelId,
              // Project-level validator fallback
              projectValidatorFallbackProvider: currentSettings.validatorFallbackProvider,
              projectValidatorFallbackModelId: currentSettings.validatorFallbackModelId,
              // Global validator lane
              globalValidatorProvider: currentSettings.validatorGlobalProvider,
              globalValidatorModelId: currentSettings.validatorGlobalModelId,
              defaultThinkingLevel: currentSettings.defaultThinkingLevel,
              store,
              taskId,
              task: currentDetail,
              userComments: currentUserComments.length > 0 ? currentUserComments : undefined,
              agentStore: this.options.agentStore,
              rootDir,
            },
          );

          // Track verdict for post-session enforcement
          specReviewVerdictRef.current = result.verdict;

          await store.logEntry(
            taskId,
            `Spec review: ${result.verdict}`,
            result.summary,
          );
          reviewerLog.log(`${taskId}: spec review → ${result.verdict}`);

          let text: string;
          switch (result.verdict) {
            case "APPROVE":
              // Capture the user-comment fingerprint at approval time for stale-approval detection
              approvedCommentFingerprintRef.current = computeUserCommentFingerprint(currentUserComments);
              text = "APPROVE";
              break;
            case "REVISE":
              text = `REVISE — fix the issues below, rewrite the PROMPT.md, and call review_spec() again.\n\n${result.review}`;
              break;
            case "RETHINK": {
              // Rewind conversation to pre-specification checkpoint
              const checkpointId = checkpointRef.current;
              if (checkpointId && sessionRef.current) {
                try {
                  await sessionRef.current.navigateTree(checkpointId, {
                    summarize: false,
                  });
                  triageLog.log(
                    `${taskId}: RETHINK — session rewound to checkpoint ${checkpointId}`,
                  );
                } catch {
                  // Fallback to branchWithSummary
                  try {
                    sessionRef.current.sessionManager.branchWithSummary(
                      checkpointId,
                      `RETHINK: ${result.summary || "Approach rejected by reviewer"}`,
                    );
                    triageLog.log(
                      `${taskId}: RETHINK — branched from checkpoint ${checkpointId}`,
                    );
                  } catch (branchErr: unknown) {
                    const branchErrMessage = branchErr instanceof Error ? branchErr.message : String(branchErr);
                    triageLog.error(
                      `${taskId}: RETHINK session rewind failed: ${branchErrMessage}`,
                    );
                  }
                }
              } else {
                triageLog.log(
                  `${taskId}: RETHINK — no session checkpoint, skipping rewind`,
                );
              }

              await store.logEntry(
                taskId,
                `RETHINK: spec rewound — session checkpoint ${checkpointId || "N/A"}`,
                result.summary,
              );
              text = `RETHINK\n\nYour specification was rejected. Here is why:\n\n${result.review}\n\nTake a completely different approach to writing this specification. Do NOT repeat the rejected strategy.`;
              break;
            }
            default:
              text = "UNAVAILABLE — reviewer did not produce a usable verdict.";
          }

          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${taskId}: spec review failed: ${errorMessage}`);
          await store.logEntry(taskId, `Spec review failed: ${errorMessage}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `UNAVAILABLE — reviewer error: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    };
  }

  private async finalizeApprovedTask(
    task: Task,
    written: string,
    settings: Settings,
    options: {
      isRespecify?: boolean;
      feedback?: string;
      recoveryLogAction?: string;
    } = {},
  ): Promise<void> {
    const dupMatch = written.match(/^DUPLICATE:\s*([A-Z]+-\d+)/i);

    if (dupMatch) {
      const dupId = dupMatch[1];
      triageLog.log(`${task.id} is a duplicate of ${dupId} — closing`);
      await this.store.logEntry(
        task.id,
        `Duplicate of ${dupId} — closed`,
      );
      await this.store.deleteTask(task.id);
      return;
    }

    const parsedDeps = await this.store.parseDependenciesFromPrompt(task.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskUpdates: Record<string, any> = { status: null, error: null };

    if (parsedDeps.length > 0) {
      taskUpdates.dependencies = parsedDeps;
      triageLog.log(`${task.id} dependencies: ${parsedDeps.join(", ")}`);
    }

    const parsedSteps = await this.store.parseStepsFromPrompt(task.id);
    if (parsedSteps.length > 0) {
      taskUpdates.steps = parsedSteps;
    }

    const sizeMatch = written.match(/^\*\*Size:\*\*\s+(S|M|L)\b/m);
    if (sizeMatch) {
      taskUpdates.size = sizeMatch[1] as "S" | "M" | "L";
    }

    const reviewMatch = written.match(/^##\s+Review\s+Level:\s+(\d+)/m);
    if (reviewMatch) {
      taskUpdates.reviewLevel = parseInt(reviewMatch[1], 10);
    }

    await this.store.updateTask(task.id, taskUpdates);

    if (settings.requirePlanApproval) {
      await this.store.updateTask(task.id, { status: "awaiting-approval" });
      await this.store.logEntry(
        task.id,
        options.recoveryLogAction ?? "Specification approved by AI — awaiting manual approval",
      );
      triageLog.log(`✓ ${task.id} specified and awaiting manual approval`);
      return;
    }

    await this.store.moveTask(task.id, "todo");

    if (options.recoveryLogAction) {
      await this.store.logEntry(task.id, options.recoveryLogAction);
      triageLog.log(`✓ ${task.id} recovered and moved to todo`);
      return;
    }

    if (options.isRespecify) {
      await this.store.logEntry(task.id, "Spec revised by AI", options.feedback);
      triageLog.log(`✓ ${task.id} re-specified and moved to todo`);
    } else {
      triageLog.log(`✓ ${task.id} specified and moved to todo`);
    }
  }
}

function hasLatestSpecReviewApproval(task: Task): boolean {
  for (let i = task.log.length - 1; i >= 0; i--) {
    const action = task.log[i]?.action ?? "";
    if (action.startsWith("Spec review: ")) {
      return action === "Spec review: APPROVE";
    }
  }
  return false;
}

/** Content read from an attachment file for inlining in the prompt. */
export interface AttachmentContent {
  originalName: string;
  mimeType: string;
  /** Text content for text files, null for images (handled via image content blocks). */
  text: string | null;
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_INLINE_LIMIT = 50 * 1024; // 50KB

/**
 * Read attachment files from disk, returning text contents for inlining
 * and image contents for pi image content blocks.
 */
export async function readAttachmentContents(
  rootDir: string,
  taskId: string,
  attachments?: TaskAttachment[],
): Promise<{
  attachmentContents: AttachmentContent[];
  imageContents: ImageContent[];
}> {
  const attachmentContents: AttachmentContent[] = [];
  const imageContents: ImageContent[] = [];

  if (!attachments || attachments.length === 0) {
    return { attachmentContents, imageContents };
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const att of attachments) {
    const filePath = join(
      rootDir,
      ".fusion",
      "tasks",
      taskId,
      "attachments",
      att.filename,
    );

    try {
      if (IMAGE_MIME_TYPES.has(att.mimeType)) {
        const data = await readFile(filePath);
        imageContents.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: att.mimeType,
        });
        attachmentContents.push({
          originalName: att.originalName,
          mimeType: att.mimeType,
          text: null,
        });
      } else {
        const data = await readFile(filePath, "utf-8");
        const text =
          data.length > TEXT_INLINE_LIMIT
            ? data.slice(0, TEXT_INLINE_LIMIT) + "\n... (truncated at 50KB)"
            : data;
        attachmentContents.push({
          originalName: att.originalName,
          mimeType: att.mimeType,
          text,
        });
      }
    } catch {
      // Skip unreadable attachments
      continue;
    }
  }

  return { attachmentContents, imageContents };
}

/**
 * Compute a deterministic fingerprint from user comments on a task.
 * Returns a sorted, semicolon-joined string of comment IDs (user-authored only).
 * Used to detect whether user comments changed after spec approval.
 */
export function computeUserCommentFingerprint(
  comments?: import("@fusion/core").TaskComment[],
): string {
  if (!comments || comments.length === 0) return "";
  const userIds = comments
    .filter((c) => c.author === "user")
    .map((c) => c.id)
    .sort();
  return userIds.join(";");
}

export function buildSpecificationPrompt(
  task: TaskDetail,
  promptPath: string,
  settings?: Settings,
  attachmentContents?: AttachmentContent[],
  existingPrompt?: string,
  feedback?: string,
): string {
  const hasFeedback = Boolean(feedback?.trim());
  const isRevision = Boolean(existingPrompt && hasFeedback);
  const isFreshRespecification = Boolean(!existingPrompt && hasFeedback);

  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand)
      lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand)
      lines.push(`- **Build:** \`${settings.buildCommand}\``);
    lines.push("Use these exact commands in testing/verification steps.");
    commandsSection = "\n\n" + lines.join("\n");
  }

  // Build project memory section from settings.
  // When enabled, agents consult project memory for durable project learnings.
  // Backend-aware: instructions branch based on memoryBackendType (file, readonly, qmd)
  const memoryEnabled = settings?.memoryEnabled !== false;
  let memorySection = "";
  if (memoryEnabled) {
    memorySection = "\n\n" + buildTriageMemoryInstructions("", settings);
  }

  let attachmentsSection = "";
  if (attachmentContents && attachmentContents.length > 0) {
    const parts = ["## Attachments", ""];
    for (const att of attachmentContents) {
      if (att.text === null) {
        // Image — will be passed via image content blocks
        parts.push(
          `- **${att.originalName}** (${att.mimeType}) — included as image below`,
        );
      } else {
        parts.push(
          `### ${att.originalName} (${att.mimeType})\n\n\`\`\`\n${att.text}\n\`\`\``,
        );
      }
    }
    attachmentsSection = "\n\n" + parts.join("\n");
  }

  // Include user comments as context for the triage agent
  let userCommentsSection = "";
  const userComments = (task.comments || []).filter(
    (c) => c.author === "user",
  );
  if (userComments.length > 0) {
    const parts = [
      "## User Comments",
      "",
      "The following user comments have been posted on this task. **Address every comment** in the specification — each comment represents explicit user feedback or requirements that must be reflected in the PROMPT.md.",
      "",
    ];
    for (const comment of userComments) {
      const date = comment.updatedAt || comment.createdAt;
      parts.push(
        `- **[${date}]** ${comment.text}`,
      );
    }
    parts.push(
      "",
      "Ensure the specification addresses all of the above comments. Missing comment coverage is a spec quality failure.",
    );
    userCommentsSection = "\n\n" + parts.join("\n");
  }

  let revisionSection = "";
  if (isRevision) {
    revisionSection = `

## Revision Instructions
You are revising an existing task specification based on user feedback.

**Important:** Keep the same overall PROMPT.md structure (headings, sections, format) but improve the content to address the feedback below. Do not drastically change the file structure unless necessary.

## Existing Specification
\`\`\`markdown
${existingPrompt}
\`\`\`

## User Feedback
${feedback}

Please revise the specification above to address this feedback. Write the complete revised PROMPT.md to \`${promptPath}\`.`;
  } else if (isFreshRespecification) {
    revisionSection = `

## Re-specification Instructions
You are creating a fresh replacement specification based on user feedback.

**Important:** Do not reuse stale PROMPT.md content. Start from the current task description, inspect the codebase, and write a complete new specification that addresses the feedback below.

## User Feedback
${feedback}

Please write the complete fresh PROMPT.md to \`${promptPath}\`.`;
  }

  let subtaskSection = "";
  if (task.breakIntoSubtasks) {
    subtaskSection = `

## Subtask Breakdown Requested
The user has requested that this task be broken into smaller subtasks if it is complex enough to warrant splitting.

**When to split:**
- Only split when the work is meaningfully decomposable into 2-5 independently executable child tasks
- Each child task should be completable on its own with a clear scope and acceptance criteria
- Child tasks should have logical dependencies between them if order matters

**How to split:**
1. First, analyze the task to determine if it should be split
2. If splitting: use the \\\`task_create\\\` tool to create child tasks in order, setting up dependencies as needed
3. Include clear descriptions and acceptance criteria for each child task
4. After creating all subtasks, stop — do NOT write a PROMPT.md for the parent task
5. If NOT splitting: proceed with a normal PROMPT.md specification for this task

**Important:** If you create subtasks, this parent task will be closed and replaced by the children. Make sure each child is a complete, executable task.`;
  } else {
    subtaskSection = `

## Subtask Consideration
The user did not explicitly request subtask breakdown, so you should first assess the likely task size and complexity.

**Split into 2-5 child tasks when ANY of these apply:**
- The task will require MORE THAN 7 implementation steps
- The task affects MORE THAN 3 different packages/modules
- Any single step would take more than 1-2 hours to complete
- The task has multiple independent deliverables that could be developed in parallel

**GOOD TO SPLIT:**
- A task that would require 8+ implementation steps across multiple packages
- A feature involving backend API changes, frontend UI, and database migrations
- A refactor touching 4+ modules with different concerns

**NOT NECESSARY TO SPLIT:**
- A 3-step bug fix with clear scope
- A single-file refactor with 4 focused steps
- Adding a small feature to one module with 5 steps

**How to decide:**
- If you choose to split: use the \\\`task_create\\\` tool to create the child tasks, set dependencies where needed, and then stop without writing a PROMPT.md for the parent task.
- If the work appears to be Size S, or if an M/L task genuinely has 5 or fewer focused steps with a clear scope, proceed with a normal PROMPT.md specification.
- If size is uncertain at first, make a quick assessment from the available context before deciding.`;
  }

  return `${isRevision ? "Revise" : isFreshRespecification ? "Re-specify" : "Specify"} this task and write the result to \`${promptPath}\`.

## Task
- **ID:** ${task.id}
- **Title:** ${task.title || "(none)"}
- **Description:** ${task.description}
${task.breakIntoSubtasks ? "- **Break into subtasks:** Yes (user requested)" : ""}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}${revisionSection}${subtaskSection}

## Instructions
${isRevision ? "1. Review the existing specification and user feedback carefully\n2. Revise the PROMPT.md to address the feedback while maintaining the structure\n3. Ensure the specification is detailed enough for an AI agent to execute" : isFreshRespecification ? "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Write a fresh complete PROMPT.md specification to the given path following the format in your system prompt\n3. Address the user feedback without carrying forward stale assumptions from the old spec\n4. Name actual files, functions, and patterns from the codebase — be specific" : "1. Read the project structure to understand context (package.json, source files, etc.)\n2. Write a complete PROMPT.md specification to the given path following the format in your system prompt\n3. The specification must be detailed enough for an autonomous AI agent to implement without asking questions\n4. Name actual files, functions, and patterns from the codebase — be specific"}

Use the write tool to write the specification file.${commandsSection}${memorySection}${attachmentsSection}${userCommentsSection}`;
}

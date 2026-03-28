import type { TaskStore, Task, TaskDetail, TaskAttachment, Settings } from "@kb/core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { ToolDefinition, AgentSession } from "@mariozechner/pi-coding-agent";
import { createKbAgent } from "./pi.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { PRIORITY_SPECIFY, type AgentSemaphore } from "./concurrency.js";
import { AgentLogger } from "./agent-logger.js";
import { triageLog, reviewerLog } from "./logger.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";

const TRIAGE_SYSTEM_PROMPT = `You are a task specification agent for "kb", an AI-orchestrated task board.

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

- [ ] Run full test suite
- [ ] Fix all failures
- [ ] Build passes

### Step {N}: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Out-of-scope findings created as new tasks via \`kb task create\`

## Documentation Requirements

**Must Update:**
- \`path/to/doc.md\` — {what to add/change}

**Check If Affected:**
- \`path/to/doc.md\` — {update if relevant}

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** \`feat({ID}): complete Step N — description\`
- **Bug fixes:** \`fix({ID}): description\`
- **Tests:** \`test({ID}): description\`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
\`\`\`

## Testing requirements

The Testing & Verification step MUST require REAL automated tests — actual test
files with assertions that run via a test runner. Typechecks and builds are NOT
tests. Manual verification is NOT a test.

- Each implementation step should include writing tests for the code being changed
- The final Testing step runs the FULL test suite
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

## Guidelines
- Read the project structure and relevant source files to understand context BEFORE writing
- Be specific — name actual files, functions, and patterns from the codebase
- Steps should express OUTCOMES, not micro-instructions (2-5 checkboxes per step)
- Always include a testing step and a documentation step
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
  onSpecifyStart?: (task: Task) => void;
  onSpecifyComplete?: (task: Task) => void;
  onSpecifyError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
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
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  /** Active agent sessions per task, used to terminate on pause. */
  private activeSessions = new Map<string, { dispose: () => void }>();
  /** Tasks aborted due to globalPause or enginePaused (to avoid reporting as errors). */
  private pauseAborted = new Set<string>();

  /**
   * @param store — Task store instance (also used to listen for `settings:updated` events)
   * @param rootDir — Project root directory
   * @param options — Processor configuration
   *
   * Listens for `settings:updated` events: when `globalPause` or `enginePaused`
   * transitions from `false` to `true`, all active triage specification sessions
   * are immediately terminated so the engine stops all AI activity.
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
          triageLog.log(`Global pause — terminating triage session for ${taskId}`);
          this.pauseAborted.add(taskId);
          session.dispose();
        }
      }
    });

    // When enginePaused transitions from false → true, terminate all active triage sessions.
    // Same pattern as globalPause: agents are killed, status cleared (not reported as error).
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.enginePaused && !previous.enginePaused) {
        for (const [taskId, session] of this.activeSessions) {
          triageLog.log(`Engine pause — terminating triage session for ${taskId}`);
          this.pauseAborted.add(taskId);
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

    const interval = this.options.pollIntervalMs ?? 10_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.poll();
    triageLog.log("Processor started");
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
          triageLog.log("Engine paused — triage halted (in-flight agents continue)");
          this.wasEnginePaused = true;
        }
        return;
      }
      this.wasEnginePaused = false;

      const tasks = await this.store.listTasks();
      const triageTasks = tasks.filter(
        (t) => t.column === "triage" && !this.processing.has(t.id) && !t.paused,
      );

      for (const task of triageTasks) {
        void this.specifyTask(task);
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
   *   `todo` — a post-session gate checks the last verdict.
   * - **RETHINK**: the conversation rewinds to a pre-specification checkpoint
   *   and the agent starts over with a fundamentally different approach.
   */
  async specifyTask(task: Task): Promise<void> {
    if (this.processing.has(task.id)) return;
    this.processing.add(task.id);

    triageLog.log(`Specifying ${task.id}: ${task.title || task.description.slice(0, 60)}`);
    this.options.onSpecifyStart?.(task);

    try {
      const detail = await this.store.getTask(task.id);
      const settings = await this.store.getSettings();
      const promptPath = `.kb/tasks/${task.id}/PROMPT.md`;

      const agentWork = async () => {
        // Set status only after the semaphore slot has been acquired, so
        // tasks waiting in the queue don't appear as "specifying".
        await this.store.updateTask(task.id, { status: "specifying" });

        const agentLogger = new AgentLogger({
          store: this.store,
          taskId: task.id,
          agent: "triage",
          onAgentText: this.options.onAgentText
            ? (id, delta) => this.options.onAgentText!(id, delta)
            : undefined,
          onAgentTool: (_id, name) => {
            triageLog.log(`${task.id} tool: ${name}`);
          },
        });

        // Mutable ref — populated after createKbAgent, tools access lazily via closure
        const sessionRef: { current: AgentSession | null } = { current: null };
        // Checkpoint for RETHINK rewind — captured lazily on first review_spec call
        const checkpointRef: { current: string | null } = { current: null };
        // Track the last spec review verdict for post-session enforcement
        const specReviewVerdictRef: { current: ReviewVerdict | null } = { current: null };

        const customTools = [
          ...this.createTriageTools(),
          this.createReviewSpecTool(
            task.id, promptPath, sessionRef, checkpointRef, specReviewVerdictRef, settings,
          ),
        ];

        const { session } = await createKbAgent({
          cwd: this.rootDir,
          systemPrompt: TRIAGE_SYSTEM_PROMPT,
          tools: "coding",
          customTools,
          onText: agentLogger.onText,
          onThinking: agentLogger.onThinking,
          onToolStart: agentLogger.onToolStart,
          onToolEnd: agentLogger.onToolEnd,
          defaultProvider: settings.defaultProvider,
          defaultModelId: settings.defaultModelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
        });

        // Make session available to review_spec tool (for RETHINK rewind)
        sessionRef.current = session;

        // Register session so the global pause listener can terminate it
        this.activeSessions.set(task.id, session);

        try {
          // Read attachment contents for inlining in prompt
          const { attachmentContents, imageContents } = await readAttachmentContents(
            this.rootDir, detail.id, detail.attachments,
          );

          const agentPrompt = buildSpecificationPrompt(detail, promptPath, settings, attachmentContents);
          await session.prompt(agentPrompt, imageContents.length > 0 ? { images: imageContents } : undefined);

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          checkSessionError(session);

          // Post-session REVISE gate: if the last review_spec verdict was REVISE
          // and the agent finished without getting APPROVE, don't move to todo.
          if (specReviewVerdictRef.current === "REVISE") {
            triageLog.log(`${task.id} spec review ended with REVISE — not moving to todo`);
            await this.store.logEntry(task.id, "Spec review ended with REVISE verdict — specification not approved");
            await this.store.updateTask(task.id, { status: null });
            return;
          }

          // Check if the agent flagged a duplicate
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const written = await readFile(
            join(this.rootDir, promptPath), "utf-8",
          ).catch(() => "");
          const dupMatch = written.match(/^DUPLICATE:\s*([A-Z]+-\d+)/i);

          if (dupMatch) {
            const dupId = dupMatch[1];
            triageLog.log(`${task.id} is a duplicate of ${dupId} — closing`);
            await this.store.logEntry(task.id, `Duplicate of ${dupId} — closed`);
            await this.store.deleteTask(task.id);
          } else {
            // Parse dependencies, size, and review level from the generated PROMPT.md
            const parsedDeps = await this.store.parseDependenciesFromPrompt(task.id);
            const taskUpdates: Record<string, any> = { status: null };

            if (parsedDeps.length > 0) {
              taskUpdates.dependencies = parsedDeps;
              triageLog.log(`${task.id} dependencies: ${parsedDeps.join(", ")}`);
            }

            // Extract size (S|M|L) from front-matter
            const sizeMatch = written.match(/^\*\*Size:\*\*\s+(S|M|L)\b/m);
            if (sizeMatch) {
              taskUpdates.size = sizeMatch[1] as "S" | "M" | "L";
            }

            // Extract review level from heading
            const reviewMatch = written.match(/^##\s+Review\s+Level:\s+(\d+)/m);
            if (reviewMatch) {
              taskUpdates.reviewLevel = parseInt(reviewMatch[1], 10);
            }

            await this.store.updateTask(task.id, taskUpdates);
            await this.store.moveTask(task.id, "todo");
            triageLog.log(`✓ ${task.id} specified and moved to todo`);
            this.options.onSpecifyComplete?.(task);
          }
        } finally {
          this.activeSessions.delete(task.id);
          await agentLogger.flush();
          session.dispose();
        }
      };

      if (this.options.semaphore) {
        await this.options.semaphore.run(agentWork, PRIORITY_SPECIFY);
      } else {
        await agentWork();
      }
    } catch (err: any) {
      // Race condition: task was deleted (e.g. as a duplicate) between listTasks()
      // and specifyTask(). The file is gone, so just log and skip — no point retrying.
      if (err.code === "ENOENT") {
        triageLog.log(`${task.id} no longer exists — skipping`);
      } else if (this.pauseAborted.has(task.id)) {
        // Pause (global or engine) — clear specifying status without reporting an error
        this.pauseAborted.delete(task.id);
        triageLog.log(`${task.id} aborted by pause — clearing status`);
        await this.store.updateTask(task.id, { status: null }).catch(() => {});
      } else {
        // Check if the error is a usage-limit error and trigger global pause
        if (this.options.usageLimitPauser && isUsageLimitError(err.message)) {
          await this.options.usageLimitPauser.onUsageLimitHit("triage", task.id, err.message);
        }
        await this.store.updateTask(task.id, { status: null }).catch(() => {});
        triageLog.error(`✗ ${task.id} specification failed:`, err.message);
        this.options.onSpecifyError?.(task, err);
      }
    } finally {
      this.processing.delete(task.id);
    }
  }

  private createTriageTools(): ToolDefinition[] {
    const store = this.store;

    const taskGetParams = Type.Object({
      id: Type.String({ description: "Task ID (e.g. KB-001)" }),
    });

    const taskList: ToolDefinition = {
      name: "task_list",
      label: "List Tasks",
      description:
        "List all tasks that aren't done. Returns ID, description, column, " +
        "and dependencies for each. Use to check for duplicates before specifying.",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = await store.listTasks();
        const active = tasks.filter((t) => t.column !== "done");
        if (active.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active tasks." }],
            details: {},
          };
        }
        const lines = active.map((t) => {
          const desc = t.title || t.description.slice(0, 80);
          const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
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
      execute: async (_callId: string, params: Static<typeof taskGetParams>) => {
        try {
          const task = await store.getTask(params.id);
          const parts = [
            `ID: ${task.id}`,
            `Column: ${task.column}`,
            `Description: ${task.description}`,
            task.dependencies.length ? `Dependencies: ${task.dependencies.join(", ")}` : null,
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
            content: [{ type: "text" as const, text: `Task ${params.id} not found.` }],
            details: {},
          };
        }
      },
    };

    return [taskList, taskGet];
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
    settings: { defaultProvider?: string; defaultModelId?: string; defaultThinkingLevel?: string },
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
          checkpointRef.current = sessionRef.current.sessionManager.getLeafId() ?? null;
        }

        try {
          // Read the generated PROMPT.md from disk
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const promptContent = await readFile(
            join(rootDir, promptPath), "utf-8",
          ).catch(() => "");

          if (!promptContent) {
            return {
              content: [{
                type: "text" as const,
                text: "UNAVAILABLE — PROMPT.md file not found or empty. Write the specification first, then call review_spec.",
              }],
              details: {},
            };
          }

          const result = await reviewStep(
            rootDir, taskId, 0, "Specification",
            "spec", promptContent, undefined,
            {
              onText: (delta) => options.onAgentText?.(taskId, delta),
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              defaultThinkingLevel: settings.defaultThinkingLevel,
              store,
              taskId,
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
                  await sessionRef.current.navigateTree(checkpointId, { summarize: false });
                  triageLog.log(`${taskId}: RETHINK — session rewound to checkpoint ${checkpointId}`);
                } catch {
                  // Fallback to branchWithSummary
                  try {
                    sessionRef.current.sessionManager.branchWithSummary(
                      checkpointId,
                      `RETHINK: ${result.summary || "Approach rejected by reviewer"}`,
                    );
                    triageLog.log(`${taskId}: RETHINK — branched from checkpoint ${checkpointId}`);
                  } catch (branchErr: any) {
                    triageLog.error(`${taskId}: RETHINK session rewind failed: ${branchErr.message}`);
                  }
                }
              } else {
                triageLog.log(`${taskId}: RETHINK — no session checkpoint, skipping rewind`);
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
        } catch (err: any) {
          reviewerLog.error(`${taskId}: spec review failed: ${err.message}`);
          await store.logEntry(taskId, `Spec review failed: ${err.message}`);
          return {
            content: [{ type: "text" as const, text: `UNAVAILABLE — reviewer error: ${err.message}` }],
            details: {},
          };
        }
      },
    };
  }
}

/** Content read from an attachment file for inlining in the prompt. */
export interface AttachmentContent {
  originalName: string;
  mimeType: string;
  /** Text content for text files, null for images (handled via image content blocks). */
  text: string | null;
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_INLINE_LIMIT = 50 * 1024; // 50KB

/**
 * Read attachment files from disk, returning text contents for inlining
 * and image contents for pi image content blocks.
 */
export async function readAttachmentContents(
  rootDir: string,
  taskId: string,
  attachments?: TaskAttachment[],
): Promise<{ attachmentContents: AttachmentContent[]; imageContents: ImageContent[] }> {
  const attachmentContents: AttachmentContent[] = [];
  const imageContents: ImageContent[] = [];

  if (!attachments || attachments.length === 0) {
    return { attachmentContents, imageContents };
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const att of attachments) {
    const filePath = join(rootDir, ".kb", "tasks", taskId, "attachments", att.filename);

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
        const text = data.length > TEXT_INLINE_LIMIT
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

export function buildSpecificationPrompt(task: TaskDetail, promptPath: string, settings?: Settings, attachmentContents?: AttachmentContent[]): string {
  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand) lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand) lines.push(`- **Build:** \`${settings.buildCommand}\``);
    lines.push("Use these exact commands in testing/verification steps.");
    commandsSection = "\n\n" + lines.join("\n");
  }

  let attachmentsSection = "";
  if (attachmentContents && attachmentContents.length > 0) {
    const parts = ["## Attachments", ""];
    for (const att of attachmentContents) {
      if (att.text === null) {
        // Image — will be passed via image content blocks
        parts.push(`- **${att.originalName}** (${att.mimeType}) — included as image below`);
      } else {
        parts.push(`### ${att.originalName} (${att.mimeType})\n\n\`\`\`\n${att.text}\n\`\`\``);
      }
    }
    attachmentsSection = "\n\n" + parts.join("\n");
  }

  return `Specify this task and write the result to \`${promptPath}\`.

## Task
- **ID:** ${task.id}
- **Title:** ${task.title || "(none)"}
- **Description:** ${task.description}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}

## Instructions
1. Read the project structure to understand context (package.json, source files, etc.)
2. Write a complete PROMPT.md specification to \`${promptPath}\` following the format in your system prompt
3. The specification must be detailed enough for an autonomous AI agent to implement without asking questions
4. Name actual files, functions, and patterns from the codebase — be specific

Use the write tool to write the specification file.${commandsSection}${attachmentsSection}`;
}

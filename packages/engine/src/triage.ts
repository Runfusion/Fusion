import type { TaskStore, Task, TaskDetail } from "@hai/core";
import { createHaiAgent } from "./pi.js";
import type { AgentSemaphore } from "./concurrency.js";

const TRIAGE_SYSTEM_PROMPT = `You are a task specification agent for "hai", an AI-orchestrated task board.

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
- [ ] Out-of-scope findings created as new tasks via \`hai task create\`

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

## Guidelines
- Read the project structure and relevant source files to understand context BEFORE writing
- Be specific — name actual files, functions, and patterns from the codebase
- Steps should express OUTCOMES, not micro-instructions (2-5 checkboxes per step)
- Always include a testing step and a documentation step
- Include a "Do NOT" section with project-appropriate guardrails
- Size assessment: S (<2h), M (2-4h), L (4-8h). Split if XL (8h+)
- Review level scoring: Blast radius (0-2), Pattern novelty (0-2), Security (0-2), Reversibility (0-2)
  - 0-1 → Level 0, 2-3 → Level 1, 4-5 → Level 2, 6-8 → Level 3

## Output
Write the PROMPT.md directly using the write tool. Nothing else.`;

export interface TriageProcessorOptions {
  pollIntervalMs?: number;
  semaphore?: AgentSemaphore;
  onSpecifyStart?: (task: Task) => void;
  onSpecifyComplete?: (task: Task) => void;
  onSpecifyError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
}

export class TriageProcessor {
  private running = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private processing = new Set<string>();

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TriageProcessorOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const interval = this.options.pollIntervalMs ?? 10_000;
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.poll();
    console.log("[triage] Processor started");
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("[triage] Processor stopped");
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const tasks = await this.store.listTasks();
      const triageTasks = tasks.filter(
        (t) => t.column === "triage" && !this.processing.has(t.id),
      );

      for (const task of triageTasks) {
        await this.specifyTask(task);
      }
    } catch (err) {
      console.error("[triage] Poll error:", err);
    }
  }

  async specifyTask(task: Task): Promise<void> {
    if (this.processing.has(task.id)) return;
    this.processing.add(task.id);

    console.log(`[triage] Specifying ${task.id}: ${task.title || task.description.slice(0, 60)}`);
    this.options.onSpecifyStart?.(task);
    await this.store.updateTask(task.id, { status: "specifying" });

    try {
      const detail = await this.store.getTask(task.id);
      const promptPath = `.hai/tasks/${task.id}/PROMPT.md`;

      const agentWork = async () => {
        const { session } = await createHaiAgent({
          cwd: this.rootDir,
          systemPrompt: TRIAGE_SYSTEM_PROMPT,
          tools: "coding",
          onText: (delta) => this.options.onAgentText?.(task.id, delta),
          onToolStart: (name) =>
            console.log(`[triage] ${task.id} tool: ${name}`),
        });

        try {
          const agentPrompt = buildSpecificationPrompt(detail, promptPath);
          await session.prompt(agentPrompt);

          // Move to todo
          await this.store.updateTask(task.id, { status: null });
          await this.store.moveTask(task.id, "todo");
          console.log(`[triage] ✓ ${task.id} specified and moved to todo`);
          this.options.onSpecifyComplete?.(task);
        } finally {
          session.dispose();
        }
      };

      if (this.options.semaphore) {
        await this.options.semaphore.run(agentWork);
      } else {
        await agentWork();
      }
    } catch (err: any) {
      await this.store.updateTask(task.id, { status: null }).catch(() => {});
      console.error(`[triage] ✗ ${task.id} specification failed:`, err.message);
      this.options.onSpecifyError?.(task, err);
    } finally {
      this.processing.delete(task.id);
    }
  }
}

function buildSpecificationPrompt(task: TaskDetail, promptPath: string): string {
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

Use the write tool to write the specification file.`;
}

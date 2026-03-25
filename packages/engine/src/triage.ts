import type { TaskStore, Task, TaskDetail } from "@hai/core";
import { createHaiAgent } from "./pi.js";

const TRIAGE_SYSTEM_PROMPT = `You are a task specification agent for "hai", an AI-orchestrated task board.

Your job: take a rough task description and produce a fully specified PROMPT.md that another AI agent can execute autonomously.

## What you receive
- A raw task title and optional description (the user's rough idea)
- Access to the project's files so you can understand context

## What you produce
Write a complete PROMPT.md specification using the write tool. The specification must include:

1. **Mission** — One paragraph: what to build and why it matters
2. **Steps** — Numbered implementation steps, each with:
   - Specific, verifiable checkbox items
   - Expected artifacts (files created/modified)
3. **File Scope** — Which files/directories will be touched
4. **Acceptance Criteria** — How to verify the task is complete
5. **Do NOT** — Guardrails to prevent scope creep

## Guidelines
- Read the project structure and relevant source files to understand context before writing the spec
- Be specific — name actual files, functions, and patterns from the codebase
- Keep steps focused and achievable (2-5 checkboxes per step)
- Include a testing step
- If the task is vague, make reasonable assumptions and document them
- Write the spec directly to the file path you're given — do not ask for clarification

## Output format
Write the PROMPT.md content directly using the write tool. Nothing else.`;

export interface TriageProcessorOptions {
  /** Milliseconds between polls. Default: 10000 */
  pollIntervalMs?: number;
  /** Called when a task starts being specified */
  onSpecifyStart?: (task: Task) => void;
  /** Called when a task is successfully specified */
  onSpecifyComplete?: (task: Task) => void;
  /** Called on specification failure */
  onSpecifyError?: (task: Task, error: Error) => void;
  /** Called with agent text output */
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
        // Process one at a time to avoid overwhelming the API
        await this.specifyTask(task);
      }
    } catch (err) {
      console.error("[triage] Poll error:", err);
    }
  }

  async specifyTask(task: Task): Promise<void> {
    if (this.processing.has(task.id)) return;
    this.processing.add(task.id);

    console.log(`[triage] Specifying ${task.id}: ${task.title || task.id}`);
    this.options.onSpecifyStart?.(task);


    try {
      // Get the full task detail including current prompt
      const detail = await this.store.getTask(task.id);
      const promptPath = `.hai/tasks/${task.id}/PROMPT.md`;

      // Create a pi agent session for specification
      const { session } = await createHaiAgent({
        cwd: this.rootDir,
        systemPrompt: TRIAGE_SYSTEM_PROMPT,
        tools: "coding",
        onText: (delta) => this.options.onAgentText?.(task.id, delta),
        onToolStart: (name) =>
          console.log(`[triage] ${task.id} tool: ${name}`),
      });

      try {
        // Build the prompt for the agent
        const agentPrompt = buildSpecificationPrompt(detail, promptPath);

        // Run the agent
        await session.prompt(agentPrompt);

        // Move to todo
        await this.store.moveTask(task.id, "todo");
        console.log(`[triage] ✓ ${task.id} specified and moved to todo`);
        this.options.onSpecifyComplete?.(task);
      } finally {
        session.dispose();
      }
    } catch (err: any) {
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
- **Title:** ${task.title || task.id}
- **Description:** ${task.description}
${task.dependencies.length > 0 ? `- **Dependencies:** ${task.dependencies.join(", ")}` : ""}

## Current rough prompt
\`\`\`
${task.prompt}
\`\`\`

## Instructions
1. Read the project structure to understand context (look at package.json, source files, etc.)
2. Write a complete PROMPT.md specification to \`${promptPath}\`
3. The specification must be detailed enough for an autonomous AI agent to implement without asking questions

Use the write tool to write the specification file.`;
}

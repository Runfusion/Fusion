/**
 * createReviewerEvaluator — the production AI-judge seam for the ReviewerGate (U6).
 *
 * The ReviewerGate (`reviewer-gate.ts`) is intentionally evaluator-agnostic: it
 * owns the run lifecycle (start → verdict → fail-backward / budget / recovery)
 * and delegates the actual judgment to an injected {@link ReviewerEvaluator}.
 * Tests pass a deterministic stub; production wires this factory.
 *
 * This mirrors the mission Validator's evaluation shape
 * (`MissionExecutionLoop.runValidation`): a readonly agent session whose system
 * prompt frames a single "is this task done?" judgment, prompted to return a
 * structured JSON verdict that we parse into a {@link ReviewerEvaluation}. It is
 * deliberately self-contained and task-keyed — it shares no rows or FKs with the
 * mission machinery — so mission flows stay byte-identical.
 *
 * When the task carries no explicit Contract Assertion, the judgment derives one
 * lazily from the task description / PROMPT.md (the prompt frames the description
 * as the acceptance bar) — mirroring how mission features lazily link assertions,
 * and giving non-coding boards (R6) something concrete to judge.
 */

import type { TaskStore, Settings } from "@fusion/core";
import { isTestModeActive, TEST_MODE_RESOLVED } from "@fusion/core";
import { promptWithFallback } from "./pi.js";
import { createResolvedAgentSession, extractRuntimeHint } from "./agent-session-helpers.js";
import { createLogger } from "./logger.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import type { PluginRunner } from "./plugin-runner.js";
import type { AgentStore } from "@fusion/core";
import type { ReviewerEvaluation, ReviewerEvaluator } from "./reviewer-gate.js";

const evalLog = createLogger("reviewer-evaluator");

/** Maximum time (ms) to wait for a Reviewer evaluation session. Mirrors the
 *  mission validator timeout. */
const REVIEWER_EVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ReviewerEvaluatorDeps {
  taskStore: TaskStore;
  /** Working directory the readonly judge session runs in. */
  rootDir: string;
  pluginRunner?: PluginRunner;
  agentStore?: AgentStore;
}

/**
 * Build the production {@link ReviewerEvaluator}. The returned evaluator runs a
 * readonly judge session as the Reviewer and parses a structured verdict.
 */
export function createReviewerEvaluator(deps: ReviewerEvaluatorDeps): ReviewerEvaluator {
  return async ({ task, reworkRound }): Promise<ReviewerEvaluation> => {
    if (!task) {
      return { status: "error", summary: "Reviewer evaluation: task not found" };
    }

    const settings: Settings | undefined = await deps.taskStore
      .getSettings()
      .catch(() => undefined);

    const assignedAgent = task.assignedAgentId && deps.agentStore
      ? await deps.agentStore.getAgent(task.assignedAgentId).catch(() => null)
      : null;
    const runtimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
    const model = resolveReviewerModel(settings);

    let session: Awaited<ReturnType<typeof createResolvedAgentSession>> | null = null;
    try {
      const runAuditor = createRunAuditor(deps.taskStore, {
        runId: generateSyntheticRunId("reviewer", task.id),
        agentId: "reviewer",
        taskId: task.id,
        phase: "review",
        source: "reviewer-gate",
      });
      const resolved = await createResolvedAgentSession({
        sessionPurpose: "validation",
        runtimeHint,
        pluginRunner: deps.pluginRunner,
        cwd: deps.rootDir,
        systemPrompt: buildReviewerSystemPrompt(),
        tools: "readonly",
        defaultProvider: model.provider,
        defaultModelId: model.modelId,
        fallbackProvider: settings?.fallbackProvider,
        fallbackModelId: settings?.fallbackModelId,
        defaultThinkingLevel: "medium",
        runAuditor,
        settings,
        taskId: task.id,
        taskTitle: task.title,
      });
      session = resolved;

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Reviewer evaluation timeout")), REVIEWER_EVAL_TIMEOUT_MS);
      });
      await Promise.race([
        promptWithFallback(
          resolved.session as Parameters<typeof promptWithFallback>[0],
          buildReviewerPrompt(task, reworkRound),
        ),
        timeout,
      ]);

      return parseReviewerVerdict(resolved.session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      evalLog.error(`Reviewer evaluation error for task ${task.id}: ${message}`);
      return { status: "error", summary: `Reviewer evaluation error: ${message}` };
    } finally {
      if (session) {
        try {
          session.session.dispose();
        } catch (disposeErr) {
          evalLog.warn(`Error disposing Reviewer session for ${task.id}:`, disposeErr);
        }
      }
    }
  };
}

function resolveReviewerModel(
  settings: Partial<Settings> | undefined,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return { provider: TEST_MODE_RESOLVED.provider, modelId: TEST_MODE_RESOLVED.modelId };
  }
  return {
    provider: settings?.defaultProviderOverride ?? settings?.defaultProvider,
    modelId: settings?.defaultModelIdOverride ?? settings?.defaultModelId,
  };
}

/** System prompt framing the Reviewer as a strict, read-only judge of done. */
function buildReviewerSystemPrompt(): string {
  return [
    "You are the Reviewer for a task board. Your sole job is to judge whether the",
    "task in front of you is genuinely DONE against its acceptance bar — you do not",
    "edit code, create tasks, or change anything. You have READ-ONLY tools.",
    "",
    "Be strict but fair: a task passes only when its stated outcome is actually",
    "achieved and verifiable from the work product. If anything required is missing,",
    "incorrect, or unverifiable, fail it and say exactly what is wrong so the",
    "Executor can fix it.",
    "",
    "Return your verdict as a single JSON object and nothing else, of the form:",
    '{ "status": "pass" | "fail" | "blocked",',
    '  "summary": "one-line overall judgment",',
    '  "failureReasons": [ { "title": "...", "message": "...",',
    '                        "expected": "...", "actual": "..." } ] }',
    "Use `blocked` only when an external dependency prevents any judgment.",
    "Omit `failureReasons` on a pass.",
  ].join("\n");
}

/** The per-task judgment prompt. Lazily frames the task description as the
 *  acceptance bar when no explicit assertion is present. */
function buildReviewerPrompt(
  task: { id: string; title?: string; description?: string; prompt?: string },
  reworkRound: number,
): string {
  const lines: string[] = [];
  lines.push(`Task: ${task.title ?? task.id}`);
  if (task.description) {
    lines.push("", "Acceptance bar (task description):", task.description);
  }
  if (task.prompt) {
    lines.push("", "Structured prompt (PROMPT.md):", task.prompt);
  }
  if (reworkRound > 0) {
    lines.push(
      "",
      `This is rework round ${reworkRound}: the task previously failed review and`,
      "was sent back for changes. Judge the current state freshly.",
    );
  }
  lines.push("", "Judge whether this task is DONE and return the JSON verdict.");
  return lines.join("\n");
}

/** Extract the last assistant text from a session (mirrors the mission loop). */
function extractResponseText(session: unknown): string | undefined {
  const state = (session as { state?: { messages?: Array<{ role?: string; content?: unknown }> } }).state;
  if (!state?.messages) return undefined;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
  }
  return undefined;
}

/** Pull a JSON object out of a response that may wrap it in prose / code fences. */
function extractJsonCandidate(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return undefined;
}

/** Parse the AI judge's structured verdict into a {@link ReviewerEvaluation}. */
function parseReviewerVerdict(session: unknown): ReviewerEvaluation {
  const text = extractResponseText(session);
  if (!text) {
    return { status: "error", summary: "Reviewer returned no response" };
  }
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return { status: "error", summary: "Reviewer did not return a JSON verdict" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { status: "error", summary: "Reviewer verdict JSON was malformed" };
  }
  const status = parsed.status;
  if (status !== "pass" && status !== "fail" && status !== "blocked") {
    return { status: "error", summary: `Reviewer returned an invalid status: ${String(status)}` };
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary : `Reviewer verdict: ${status}`;
  const failureReasons = Array.isArray(parsed.failureReasons)
    ? parsed.failureReasons
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map((r) => ({
          title: typeof r.title === "string" ? r.title : "Issue",
          message: typeof r.message === "string" ? r.message : "",
          expected: typeof r.expected === "string" ? r.expected : undefined,
          actual: typeof r.actual === "string" ? r.actual : undefined,
        }))
    : undefined;
  return { status, summary, failureReasons };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as fusionCore from "@fusion/core";
import type { MockSessionPurpose } from "@fusion/core";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "../agents/agent-runtime.js";
import type { SessionPurpose } from "../execution/runtime-resolution.js";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

function resolveProjectRootFromWorktree(cwd: string): string | undefined {
  try {
    const accessor = Reflect.get(fusionCore as object, "getProjectRootFromWorktree");
    if (typeof accessor === "function") {
      return (accessor as (worktreePath: string) => string | undefined)(cwd);
    }
  } catch {
    // Fall through to cwd below.
  }
  return undefined;
}

export const MOCK_PROVIDER_ID = (() => {
  try {
    const value = Reflect.get(fusionCore as object, "MOCK_PROVIDER_ID");
    return typeof value === "string" && value.trim().length > 0 ? value : "mock";
  } catch {
    return "mock";
  }
})();

/**
 * Intentionally non-zero token stats so budget-accounting paths still exercise
 * in test mode without relying on any provider pricing tables or network calls.
 */
export const MOCK_SYNTHETIC_TOKEN_USAGE = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export interface MockScriptContext {
  sessionPurpose: MockSessionPurpose;
  prompt: string;
  options: AgentRuntimeOptions;
  tools: ToolDefinition[];
  taskId?: string;
  taskTitle?: string;
  invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface MockScript {
  run(ctx: MockScriptContext): Promise<void>;
}

interface MockScriptKey {
  sessionPurpose: MockSessionPurpose;
  taskId?: string;
}

function registryKey({ sessionPurpose, taskId }: MockScriptKey): string {
  return `${sessionPurpose}:${taskId ?? "*"}`;
}

const overrides = new Map<string, MockScript>();

export const mockScriptRegistry = {
  setMockScript(key: MockScriptKey, script: MockScript): void {
    overrides.set(registryKey(key), script);
  },
  clearMockScript(key: MockScriptKey): void {
    overrides.delete(registryKey(key));
  },
  resetMockScripts(): void {
    overrides.clear();
  },
  resolveMockScript(key: MockScriptKey): MockScript {
    return overrides.get(registryKey(key))
      ?? overrides.get(registryKey({ sessionPurpose: key.sessionPurpose }))
      ?? DEFAULT_SCRIPTS[key.sessionPurpose];
  },
};

export const setMockScript = mockScriptRegistry.setMockScript.bind(mockScriptRegistry);
export const clearMockScript = mockScriptRegistry.clearMockScript.bind(mockScriptRegistry);
export const resetMockScripts = mockScriptRegistry.resetMockScripts.bind(mockScriptRegistry);
export const resolveMockScript = mockScriptRegistry.resolveMockScript.bind(mockScriptRegistry);

let toolCallCounter = 0;

interface MockAgentSessionState {
  sessionPurpose: MockSessionPurpose;
  options: AgentRuntimeOptions;
}

interface MockToolCallResult {
  steps?: Array<{ status?: string }>;
}

export class MockAgentSession {
  readonly __mock: MockAgentSessionState;
  readonly state: { errorMessage?: string; error?: string } = {};
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(options: AgentRuntimeOptions, sessionPurpose: MockSessionPurpose) {
    this.__mock = { options, sessionPurpose };
  }

  dispose(): void {}

  subscribe(listener: (event: unknown) => void): { unsubscribe?: () => void } {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  emitText(delta: string): void {
    const event = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        partial: delta,
        contentIndex: 0,
        delta,
      },
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getSessionStats(): { tokens: typeof MOCK_SYNTHETIC_TOKEN_USAGE } {
    return { tokens: MOCK_SYNTHETIC_TOKEN_USAGE };
  }
}

async function executeTool(
  tools: ToolDefinition[],
  options: AgentRuntimeOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Mock tool not available: ${name}`);
  }

  options.onToolStart?.(tool.name, args);
  try {
    const result = await tool.execute(
      `mock-tool-${++toolCallCounter}`,
      args,
      undefined,
      undefined,
      {} as never,
    );
    options.onToolEnd?.(tool.name, false, result);
    return result;
  } catch (error) {
    options.onToolEnd?.(tool.name, true, error);
    throw error;
  }
}

function buildPromptSkeleton(taskId: string): string {
  return `# Task: ${taskId}\n\n## Mission\n- Deterministic mock provider triage output.\n\n## Steps\n### Step 0: Preflight\n- Confirm scope and context.\n\n### Step 1: Implement\n- Make the requested changes.\n\n### Step 2: Testing\n- Run focused tests and broader verification.\n\n### Step 3: Docs\n- Update required documentation.\n\n## Completion Criteria\n- Tests relevant to the change pass.\n- Documentation is updated when required.\n\n## Git Commit Convention\n- Use FN-prefixed conventional commits.\n`;
}

function extractStepsFromTaskShowResult(result: unknown): Array<{ status?: string }> {
  const candidates: unknown[] = [result];
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    candidates.push(record.details);
    candidates.push(record.task);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const maybeSteps = (candidate as MockToolCallResult).steps;
    if (Array.isArray(maybeSteps)) {
      return maybeSteps;
    }
  }

  return [];
}

async function loadTaskSteps(options: AgentRuntimeOptions): Promise<Array<{ status?: string }>> {
  const taskId = options.taskId;
  if (!taskId) return [];
  const projectRoot = resolveProjectRootFromWorktree(options.cwd) ?? options.cwd;
  const taskJsonPath = join(projectRoot, ".fusion", "tasks", taskId, "task.json");
  try {
    const raw = await readFile(taskJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { steps?: Array<{ status?: string }> };
    return Array.isArray(parsed.steps) ? parsed.steps : [];
  } catch {
    return [];
  }
}

const DEFAULT_SCRIPTS: Record<MockSessionPurpose, MockScript> = {
  executor: {
    async run(ctx) {
      /*
      FNXC:WorkflowTestMode 2026-06-29-03:58:
      Step-session execution is graph-owned and intentionally withholds fn_task_update/fn_task_done so agents cannot mutate task lifecycle directly. Test mode must mirror that contract: use fn_task_update only for legacy full-task executor sessions, and otherwise return success so the graph projection marks the scoped step.
      */
      if (!ctx.tools.some((tool) => tool.name === "fn_task_update")) {
        if (/Execute the workflow step/i.test(ctx.prompt)) {
          ctx.options.onText?.("{\"verdict\":\"APPROVE\",\"notes\":\"Mock workflow step approved scripted output.\"}");
          return;
        }
        ctx.options.onText?.("Mock executor completed graph-owned step session without lifecycle tool calls.");
        return;
      }
      let steps: Array<{ status?: string }> = [];
      if (ctx.taskId && ctx.tools.some((tool) => tool.name === "fn_task_show")) {
        const taskDetails = await ctx.invokeTool("fn_task_show", { id: ctx.taskId });
        steps = extractStepsFromTaskShowResult(taskDetails);
      }
      if (steps.length === 0) {
        steps = await loadTaskSteps(ctx.options);
      }
      for (const [index, step] of steps.entries()) {
        if (step.status !== "done" && step.status !== "skipped") {
          await ctx.invokeTool("fn_task_update", { step: index + 1, status: "done" });
        }
      }
      ctx.options.onText?.("Mock executor completed scripted step updates.");
    },
  },
  triage: {
    async run(ctx) {
      const taskId = ctx.taskId ?? "FN-TEST";
      const projectRoot = resolveProjectRootFromWorktree(ctx.options.cwd) ?? ctx.options.cwd;
      const promptPath = join(projectRoot, ".fusion", "tasks", taskId, "PROMPT.md");
      const content = buildPromptSkeleton(taskId);
      const writeTool = ctx.tools.find((tool) => tool.name === "write");
      if (writeTool) {
        await ctx.invokeTool("write", { path: promptPath, content });
      } else {
        await mkdir(join(projectRoot, ".fusion", "tasks", taskId), { recursive: true });
        await writeFile(promptPath, content, "utf8");
      }
      ctx.options.onText?.("Mock triage wrote PROMPT.md; workflow Plan Review owns optional approval.");
    },
  },
  reviewer: {
    async run(ctx) {
      ctx.options.onText?.("Verdict: APPROVE\n\nSummary: Mock reviewer approved scripted output.\n");
    },
  },
  merger: {
    async run(ctx) {
      ctx.options.onText?.("Mock merger no-op.");
    },
  },
  heartbeat: {
    async run(ctx) {
      ctx.options.onText?.("Mock heartbeat no-op.");
    },
  },
  validation: {
    async run(ctx) {
      ctx.options.onText?.("Verdict: APPROVE\n\nSummary: Mock validation passed.\n");
    },
  },
};

export class MockAgentRuntime implements AgentRuntime {
  readonly id = MOCK_PROVIDER_ID;
  readonly name = "Mock Provider (test mode)";

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    await options.beforeSpawnSession?.();
    const sessionPurpose = (options.runtimeContext?.sessionPurpose as SessionPurpose | undefined) ?? "executor";
    return {
      session: new MockAgentSession(options, sessionPurpose) as unknown as AgentSession,
      sessionFile: undefined,
    };
  }

  async promptWithFallback(session: AgentSession, prompt: string, _promptOptions?: unknown): Promise<void> {
    const mockSession = session as unknown as MockAgentSession;
    const { options, sessionPurpose } = mockSession.__mock;
    /*
    FNXC:WorkflowTestMode 2026-06-29-04:02:
    Workflow-step gates collect verdict text from AgentSession subscription events, while reviewer lanes also use onText callbacks. Test mode must emit both surfaces so Plan Review and final Code Review exercise the same parsing contract as real runtimes.
    */
    const effectiveOptions: AgentRuntimeOptions = {
      ...options,
      onText: (text) => {
        options.onText?.(text);
        mockSession.emitText(text);
      },
    };
    const tools = options.customTools ?? [];
    const script = mockScriptRegistry.resolveMockScript({
      sessionPurpose,
      taskId: effectiveOptions.taskId,
    });
    await script.run({
      sessionPurpose,
      prompt,
      options: effectiveOptions,
      tools,
      taskId: effectiveOptions.taskId,
      taskTitle: effectiveOptions.taskTitle,
      invokeTool: (name, args) => executeTool(tools, effectiveOptions, name, args),
    });
  }

  describeModel(_session: AgentSession): string {
    return "mock/scripted";
  }
}

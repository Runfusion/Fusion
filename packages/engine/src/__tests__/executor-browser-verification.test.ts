import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { WorkflowIrNode } from "@fusion/core";
import {
  AGENT_BROWSER_NAVIGATION_SKILL_ID,
  augmentSessionSkillsForBrowserStep,
  formatAgentBrowserAvailabilityLog,
  probeAgentBrowserAvailability,
  TaskExecutor,
} from "../executor.js";
import { summarizeToolArgs } from "../agents/agent-logger.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  skillSelection?: { requestedSkillNames?: string[]; projectRootDir?: string; sessionPurpose?: string };
  tools?: "coding" | "readonly";
  systemPrompt?: string;
  customTools?: Array<{ name?: string }>;
};

function captureSession(output = '{"verdict":"APPROVE","notes":""}') {
  const holder: { last?: CapturedSession } = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    holder.last = { skillSelection: opts.skillSelection, tools: opts.tools, systemPrompt: opts.systemPrompt, customTools: opts.customTools };
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (fn: (event: any) => void) => {
          listeners.push(fn);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const fn of listeners) {
            fn({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                partial: output,
                contentIndex: 0,
                delta: output,
              },
            });
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
  return holder;
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-7130",
    title: "Browser verification",
    description: "exercise browser verification",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-7130",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExecutor(store: ReturnType<typeof createMockStore>) {
  return new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
}

function browserVerificationStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "graph:browser-verification-step",
    name: "Browser Verification",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "advisory",
    prompt: "Verify in browser.",
    toolMode: "coding",
    requiresBrowser: true,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function planReviewStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "graph:plan-review-step",
    name: "Plan Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the plan.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function codeReviewStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "graph:code-review-step",
    name: "Code Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the code.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    optionalGroupId: "code-review",
    ...overrides,
  };
}

describe("browser-verification workflow-step browser capability", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("probes agent-browser availability as a bounded non-fatal helper", async () => {
    await expect(probeAgentBrowserAvailability(async (command, options) => {
      expect(command).toBe("agent-browser --version");
      expect(options.timeout).toBeLessThanOrEqual(10_000);
      return { stdout: "agent-browser 1.2.3\n", stderr: "" };
    })).resolves.toEqual({ available: true, version: "agent-browser 1.2.3" });

    await expect(probeAgentBrowserAvailability(async () => {
      const err = new Error("spawn agent-browser ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    })).resolves.toEqual({ available: false, reason: "not installed" });

    await expect(probeAgentBrowserAvailability(async () => {
      const err = new Error("Command timed out") as Error & { code: string; killed: boolean };
      err.code = "ETIMEDOUT";
      err.killed = true;
      throw err;
    })).resolves.toEqual({ available: false, reason: "probe timed out" });
  });

  it("merges the agent-browser navigation skill idempotently", () => {
    expect(augmentSessionSkillsForBrowserStep(undefined, "/repo")).toEqual({
      projectRootDir: "/repo",
      sessionPurpose: "executor",
      requestedSkillNames: [AGENT_BROWSER_NAVIGATION_SKILL_ID],
    });

    expect(augmentSessionSkillsForBrowserStep({
      projectRootDir: "/repo",
      sessionPurpose: "executor",
      requestedSkillNames: ["existing", AGENT_BROWSER_NAVIGATION_SKILL_ID],
    }, "/fallback").requestedSkillNames).toEqual(["existing", AGENT_BROWSER_NAVIGATION_SKILL_ID]);
  });

  it("materializes requiresBrowser from graph prompt config and omits it when absent", async () => {
    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => baseTask({ id }));
    const executor = makeExecutor(store);
    const captured: Array<Record<string, unknown>> = [];
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (_task: unknown, step: Record<string, unknown>) => {
      captured.push(step);
      return { success: true, output: "ok" };
    });

    const browserNode: WorkflowIrNode = {
      id: "custom-browser-step",
      kind: "prompt",
      config: { prompt: "Verify", toolMode: "coding", requiresBrowser: true },
    };
    const plainNode: WorkflowIrNode = { id: "plain-step", kind: "prompt", config: { prompt: "Review" } };

    await (executor as any).runGraphCustomNode(browserNode, baseTask(), {}, undefined);
    await (executor as any).runGraphCustomNode(plainNode, baseTask(), {}, undefined);

    expect(captured[0]).toMatchObject({ id: "graph:custom-browser-step", requiresBrowser: true, toolMode: "coding" });
    expect(captured[1]).not.toHaveProperty("requiresBrowser");
  });

  it("summarizes bash agent-browser commands for agent-log tool entries", () => {
    expect(summarizeToolArgs("bash", { command: "agent-browser open http://localhost:5173" })).toBe(
      "agent-browser open http://localhost:5173",
    );
  });

  it("logs browser verification start, availability, and finish while augmenting session skills", async () => {
    const store = createMockStore();
    const executor = makeExecutor(store);
    const cap = captureSession();
    mockedExecSync.mockImplementation((command: string) => {
      if (command === "agent-browser --version") return Buffer.from("agent-browser 9.9.9\n");
      return Buffer.from("");
    });

    const result = await (executor as any).executeWorkflowStep(
      baseTask(),
      browserVerificationStep(),
      "/tmp/wt",
      {},
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(cap.last?.skillSelection?.requestedSkillNames).toContain(AGENT_BROWSER_NAVIGATION_SKILL_ID);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7130",
      "[browser-verification] agent-browser available — version agent-browser 9.9.9",
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-7130",
      expect.stringContaining("[browser-verification] starting browser verification"),
      "status",
      undefined,
      "reviewer",
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-7130",
      "[browser-verification] agent-browser available — version agent-browser 9.9.9",
      "status",
      undefined,
      "reviewer",
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-7130",
      "[browser-verification] finished browser verification for task FN-7130: verdict APPROVE",
      "status",
      undefined,
      "reviewer",
    );
  });

  it("logs an actionable warning and continues when agent-browser is missing", async () => {
    const store = createMockStore();
    const executor = makeExecutor(store);
    captureSession();
    mockedExecSync.mockImplementation((command: string) => {
      if (command === "agent-browser --version") {
        const err = new Error("spawn agent-browser ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      return Buffer.from("");
    });

    const result = await (executor as any).executeWorkflowStep(
      baseTask(),
      browserVerificationStep(),
      "/tmp/wt",
      {},
      undefined,
      undefined,
    );

    const warning = "[browser-verification] agent-browser not found on PATH — the step relies on the agent-browser CLI; install the agent-browser plugin/binary. Continuing; the step may fast-bail or fail.";
    expect(result.success).toBe(true);
    expect(formatAgentBrowserAvailabilityLog({ available: false, reason: "not installed" })).toBe(warning);
    expect(store.logEntry).toHaveBeenCalledWith("FN-7130", warning);
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-7130", warning, "status", undefined, "reviewer");
  });

  it("keeps flag-absent prompt steps byte-inert for browser logging and skills", async () => {
    const store = createMockStore();
    const executor = makeExecutor(store);
    const cap = captureSession();
    mockedExecSync.mockImplementation((command: string) => {
      if (command === "agent-browser --version") throw new Error("should not probe agent-browser");
      return Buffer.from("");
    });

    const result = await (executor as any).executeWorkflowStep(
      baseTask(),
      browserVerificationStep({ id: "graph:plain", name: "Plain", toolMode: "readonly", requiresBrowser: undefined }),
      "/tmp/wt",
      {},
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(cap.last?.skillSelection?.requestedSkillNames ?? []).not.toContain(AGENT_BROWSER_NAVIGATION_SKILL_ID);
    expect(store.logEntry.mock.calls.some(([, message]: [string, string]) => message.includes("[browser-verification]"))).toBe(false);
    expect(store.appendAgentLog.mock.calls.some(([, message]: [string, string]) => message.includes("[browser-verification]"))).toBe(false);
  });

  it("returns a Plan Review revision for flagged external-integration evidence gaps without launching a session", async () => {
    const store = createMockStore();
    const promptWithExternalCli = "## Mission\nAdd an external CLI.\n\n## Steps\n- Download and run `wt` from https://github.com/worktrunk/worktrunk/releases/latest/download/wt-linux-x64.tar.gz\n";
    store.getTask.mockResolvedValue({
      ...baseTask(),
      prompt: promptWithExternalCli,
    });
    // FNXC:EngineTests 2026-07-20-23:55: Plan Review evidence uses readTaskArtifact → getTaskDocument first.
    store.getTaskDocument = vi.fn(async (_id: string, key: string) =>
      key === "PROMPT.md" ? { content: promptWithExternalCli } : undefined,
    );
    const executor = makeExecutor(store);

    const result = await (executor as any).executeWorkflowStep(
      baseTask(),
      planReviewStep({ requireExternalIntegrationEvidence: true }),
      "/tmp/wt",
      {},
      undefined,
      undefined,
    );

    expect(result).toMatchObject({
      success: false,
      revisionRequested: true,
      verdict: "REVISE",
    });
    expect(result.notes).toContain("External-integration evidence gaps");
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7130",
      expect.stringContaining("Plan Review deterministic external-integration evidence check requested revision"),
    );
  });

  it("lets review-type workflow steps fix inline by default and respects the off switch", async () => {
    const store = createMockStore();
    const executor = makeExecutor(store);
    const cap = captureSession();

    const enabledResult = await (executor as any).executeWorkflowStep(
      baseTask(),
      codeReviewStep(),
      "/tmp/wt",
      { reviewerInlineFixes: true },
      undefined,
      undefined,
    );

    expect(enabledResult.success).toBe(true);
    expect(cap.last?.tools).toBe("coding");
    expect(cap.last?.systemPrompt).toContain("Same-Session Fix Policy");

    const offCap = captureSession();
    const disabledResult = await (executor as any).executeWorkflowStep(
      baseTask(),
      codeReviewStep(),
      "/tmp/wt",
      { reviewerInlineFixes: false },
      undefined,
      undefined,
    );

    expect(disabledResult.success).toBe(true);
    expect(offCap.last?.tools).toBe("readonly");
    expect(offCap.last?.systemPrompt).not.toContain("Same-Session Fix Policy");
  });

  it("keeps Plan Review readonly while allowing PROMPT.md inline repair", async () => {
    const store = createMockStore();
    const executor = makeExecutor(store);
    const cap = captureSession();

    const result = await (executor as any).executeWorkflowStep(
      baseTask(),
      planReviewStep(),
      "/tmp/wt",
      { reviewerInlineFixes: true },
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(cap.last?.tools).toBe("readonly");
    expect(cap.last?.customTools?.map((tool) => tool.name)).toContain("fn_task_prompt_write");
    expect(cap.last?.systemPrompt).toContain("fn_task_prompt_write");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../agents/agent-session-helpers.js", () => ({
  createResolvedAgentSession: vi.fn(async () => ({ session: await mocks.createSession() })),
  promptWithAutoRetry: vi.fn(async (session: { prompt: (value: string) => Promise<void> }, prompt: string) => session.prompt(prompt)),
  describeAgentModel: vi.fn(async () => "mock/mock-model"),
  resolveExecutorSessionModel: vi.fn(() => ({ provider: undefined, modelId: undefined })),
  resolveExecutorThinkingLevel: vi.fn(() => undefined),
  resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
}));

vi.mock("../worktree/worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

import { StepSessionExecutor } from "../execution/step-session-executor.js";
import {
  resolveWorkflowStepRunAgentId,
  WORKFLOW_STEP_RUN_ATTRIBUTION_TIMEOUT_MS,
} from "../execution/resolve-activity-run-agent-id.js";

const executorOwner = {
  id: "agent-built-in-executor",
  role: "executor",
  roles: ["executor"],
  metadata: { builtInWorkflowRole: true, workflowRole: "executor" },
};

function makeTask(steps = 1) {
  return {
    id: "FN-9257",
    title: "Persist workflow activity",
    column: "in-progress",
    dependencies: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompt: `# Task: FN-9257\n\n## Steps\n\n${Array.from({ length: steps }, (_, index) => `### Step ${index}: Step ${index}\n- [ ] Work`).join("\n\n")}`,
    steps: Array.from({ length: steps }, (_, index) => ({ name: `Step ${index}`, status: "pending" })),
  };
}

function makeSession(prompt = vi.fn().mockResolvedValue(undefined)) {
  return {
    prompt,
    dispose: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

function makeExecutor(agentStore: unknown, steps = 1) {
  return new StepSessionExecutor({
    taskDetail: makeTask(steps),
    worktreePath: "/project/.worktrees/fn-9257",
    rootDir: "/project",
    settings: { maxParallelSteps: 1, maxConcurrent: 1, maxWorktrees: 1 },
    agentStore,
  } as any);
}

function makeForeignKeyStore(roster: Array<{ id: string; role?: string; roles?: string[]; metadata?: object }>) {
  const saveRun = vi.fn(async (run: { agentId: string }) => {
    if (!roster.some((agent) => agent.id === run.agentId)) {
      throw new Error("agent_runs_agent_id_fkey");
    }
  });
  return {
    saveRun,
    getAgent: vi.fn(async (id: string) => roster.find((agent) => agent.id === id) ?? null),
    listAgents: vi.fn(async () => roster),
  };
}

describe("workflow step activity run agent attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockReset();
  });

  it("returns only a real id, preferring the provisioned role owner", async () => {
    const poolMember = { id: "agent-pool-executor", role: "executor", roles: ["executor"], metadata: {} };
    const store = {
      getAgent: vi.fn(async (id: string) => id === "agent-assigned" ? { id } : null),
      listAgents: vi.fn(async () => [poolMember, executorOwner]),
    };

    await expect(resolveWorkflowStepRunAgentId(store as any, "agent-assigned")).resolves.toBe("agent-assigned");
    await expect(resolveWorkflowStepRunAgentId(store as any, "executor")).resolves.toBe(executorOwner.id);
  });

  it("rejects blank, missing, empty, and ambiguous attribution without a write candidate", async () => {
    const blankStore = { getAgent: vi.fn(), listAgents: vi.fn() };
    await expect(resolveWorkflowStepRunAgentId(blankStore as any, "")).resolves.toBeNull();
    expect(blankStore.getAgent).not.toHaveBeenCalled();
    expect(blankStore.listAgents).not.toHaveBeenCalled();

    const emptyStore = { getAgent: vi.fn(async () => null), listAgents: vi.fn(async () => []) };
    await expect(resolveWorkflowStepRunAgentId(emptyStore as any, "executor")).resolves.toBeNull();
    const ambiguousStore = { getAgent: vi.fn(async () => null), listAgents: vi.fn(async () => [
      { id: "agent-a", role: "executor", roles: ["executor"], metadata: {} },
      { id: "agent-b", role: "executor", roles: ["executor"], metadata: {} },
    ]) };
    await expect(resolveWorkflowStepRunAgentId(ambiguousStore as any, "executor")).resolves.toBeNull();
    await expect(resolveWorkflowStepRunAgentId({} as any, "executor")).resolves.toBeNull();
  });

  it("swallows synchronous and rejected roster reads", async () => {
    await expect(resolveWorkflowStepRunAgentId({ getAgent: () => { throw new Error("offline"); } } as any, "agent-a")).resolves.toBeNull();
    await expect(resolveWorkflowStepRunAgentId({ getAgent: async () => { throw new Error("offline"); } } as any, "agent-a")).resolves.toBeNull();
    await expect(resolveWorkflowStepRunAgentId({ listAgents: async () => { throw new Error("offline"); } } as any, "executor")).resolves.toBeNull();
  });

  it("bounds a hung two-stage lookup once, without waiting twice", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const store = { getAgent: vi.fn(() => never), listAgents: vi.fn(() => never) };
      const result = resolveWorkflowStepRunAgentId(store as any, "executor");
      await vi.advanceTimersByTimeAsync(WORKFLOW_STEP_RUN_ATTRIBUTION_TIMEOUT_MS + 1);
      await expect(result).resolves.toBeNull();
      expect(store.getAgent).toHaveBeenCalledTimes(1);
      expect(store.listAgents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists start and completed rows with the provisioned executor owner", async () => {
    const store = makeForeignKeyStore([executorOwner]);
    mocks.createSession.mockResolvedValue(makeSession());

    const results = await makeExecutor(store).executeAll();

    expect(results).toMatchObject([{ success: true }]);
    expect(store.saveRun).toHaveBeenCalledTimes(2);
    expect(store.saveRun.mock.calls.map(([run]) => run.agentId)).toEqual([executorOwner.id, executorOwner.id]);
    expect(store.saveRun.mock.calls.map(([run]) => run.status)).toEqual(["active", "completed"]);
    expect(store.saveRun.mock.calls.every(([run]) => run.agentId !== "executor")).toBe(true);
  });

  it("skips unresolvable roster writes once without changing two-step results", async () => {
    const store = makeForeignKeyStore([]);
    mocks.createSession.mockResolvedValue(makeSession());

    const results = await makeExecutor(store, 2).executeAll();

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.success)).toBe(true);
    expect(store.saveRun).not.toHaveBeenCalled();
    const unattributableWarnings = mocks.logger.warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("Skipping unattributable workflow-step activity runs"),
    );
    expect(unattributableWarnings).toHaveLength(1);
  });

  it("bounds a hanging roster lookup once and leaves step execution successful", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const store = { saveRun: vi.fn(), getAgent: vi.fn(() => never), listAgents: vi.fn(() => never) };
      mocks.createSession.mockResolvedValue(makeSession());
      const execution = makeExecutor(store, 2).executeAll();
      await vi.advanceTimersByTimeAsync(WORKFLOW_STEP_RUN_ATTRIBUTION_TIMEOUT_MS + 1);
      const results = await execution;

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.success)).toBe(true);
      expect(store.getAgent).toHaveBeenCalledTimes(1);
      expect(store.listAgents).not.toHaveBeenCalled();
      expect(store.saveRun).not.toHaveBeenCalled();
      expect(mocks.logger.warn.mock.calls.filter(([message]) =>
        typeof message === "string" && message.includes("Skipping unattributable workflow-step activity runs"),
      )).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends completed, failed, or terminated rows with an unproved id", async () => {
    const store = makeForeignKeyStore([executorOwner]);

    mocks.createSession.mockResolvedValueOnce(makeSession());
    await makeExecutor(store).executeAll();

    mocks.createSession.mockResolvedValueOnce(makeSession(vi.fn().mockRejectedValue(new Error("boom"))));
    vi.useFakeTimers();
    try {
      const failed = makeExecutor(store).executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }

    const terminatingExecutor = makeExecutor(store);
    let startPrompt!: () => void;
    let rejectPrompt!: (error: Error) => void;
    const promptStarted = new Promise<void>((resolve) => { startPrompt = resolve; });
    const interruptedPrompt = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
    const terminatingSession = makeSession(vi.fn(async () => {
      startPrompt();
      await interruptedPrompt;
    }));
    terminatingSession.abortBash.mockImplementation(() => rejectPrompt(new Error("aborted")));
    mocks.createSession.mockResolvedValueOnce(terminatingSession);
    const terminating = terminatingExecutor.executeAll();
    await promptStarted;
    await terminatingExecutor.terminateAllSessions();
    await terminating;

    const terminalRuns = store.saveRun.mock.calls.map(([run]) => run).filter((run) => run.status !== "active");
    expect(terminalRuns.map((run) => run.status)).toEqual(expect.arrayContaining(["completed", "failed", "terminated"]));
    expect(store.saveRun.mock.calls.every(([run]) => run.agentId === executorOwner.id)).toBe(true);
  });
});

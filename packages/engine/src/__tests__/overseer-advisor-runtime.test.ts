import { describe, expect, it, vi } from "vitest";
import { OverseerAdvisorRuntime, type OverseerAdvisorAgent } from "../overseer/overseer-advisor-runtime.js";
import { OVERSEER_SESSION_DELTA_MAX_CHARS } from "../overseer/overseer-session-delta.js";

function createFakeAgent(opts?: {
  failTimes?: number;
  onPrompt?: (input: string) => void;
}): OverseerAdvisorAgent & { prompts: string[]; failRemaining: number } {
  const state = { prompts: [] as string[], failRemaining: opts?.failTimes ?? 0 };
  return {
    prompts: state.prompts,
    get failRemaining() {
      return state.failRemaining;
    },
    async prompt(input: string) {
      if (state.failRemaining > 0) {
        state.failRemaining -= 1;
        throw new Error("synthetic advisor failure");
      }
      state.prompts.push(input);
      opts?.onPrompt?.(input);
    },
    abort: vi.fn(),
    reset: vi.fn(),
  };
}

describe("OverseerAdvisorRuntime", () => {
  it("drains a log snapshot into one advisor prompt", async () => {
    const agent = createFakeAgent();
    const host = {
      enqueueAdvice: vi.fn(),
      beginAdvisorUpdate: vi.fn(),
    };
    const runtime = new OverseerAdvisorRuntime({
      agent,
      host,
      sleep: async () => {},
    });

    runtime.onLogSnapshot([
      { type: "text", text: "Starting work on the executor.", agent: "executor" },
    ]);

    // Allow microtask drain
    await vi.waitFor(() => expect(agent.prompts.length).toBe(1));
    expect(agent.prompts[0]).toContain("Starting work on the executor.");
    expect(host.beginAdvisorUpdate).toHaveBeenCalled();
    expect(runtime.backlog).toBe(0);
  });

  it("seedTo skips replaying earlier history", async () => {
    const agent = createFakeAgent();
    const runtime = new OverseerAdvisorRuntime({
      agent,
      host: { enqueueAdvice: vi.fn() },
      sleep: async () => {},
    });

    const history = [
      { type: "text", text: "old turn one", agent: "executor" },
      { type: "text", text: "old turn two", agent: "executor" },
    ];
    runtime.seedTo(history.length);
    runtime.onLogSnapshot([
      ...history,
      { type: "text", text: "new turn three", agent: "executor" },
    ]);

    await vi.waitFor(() => expect(agent.prompts.length).toBe(1));
    expect(agent.prompts[0]).toContain("new turn three");
    expect(agent.prompts[0]).not.toContain("old turn one");
  });

  it("drops backlog after three consecutive failures and notifies once", async () => {
    const agent = createFakeAgent({ failTimes: 3 });
    const notifyFailure = vi.fn();
    const runtime = new OverseerAdvisorRuntime({
      agent,
      host: { enqueueAdvice: vi.fn(), notifyFailure },
      retryDelayMs: 0,
      sleep: async () => {},
    });

    runtime.onLogDelta([{ type: "text", text: "will fail thrice", agent: "executor" }]);

    await vi.waitFor(() => expect(notifyFailure).toHaveBeenCalledTimes(1));
    expect(runtime.backlog).toBe(0);
    expect(agent.prompts.length).toBe(0);
  });

  it("notifies again on a second three-failure streak after a drop", async () => {
    // Six failures: first streak notifies, second streak notifies again (failureNotified reset on drop).
    const agent = createFakeAgent({ failTimes: 6 });
    const notifyFailure = vi.fn();
    const runtime = new OverseerAdvisorRuntime({
      agent,
      host: { enqueueAdvice: vi.fn(), notifyFailure },
      retryDelayMs: 0,
      sleep: async () => {},
    });

    runtime.onLogDelta([{ type: "text", text: "streak one", agent: "executor" }]);
    await vi.waitFor(() => expect(notifyFailure).toHaveBeenCalledTimes(1));

    runtime.onLogDelta([{ type: "text", text: "streak two", agent: "executor" }]);
    await vi.waitFor(() => expect(notifyFailure).toHaveBeenCalledTimes(2));
  });

  it("bounds oversized tool rows through both delta and snapshot entry points", async () => {
    const deltaAgent = createFakeAgent();
    const deltaRuntime = new OverseerAdvisorRuntime({
      agent: deltaAgent,
      host: { enqueueAdvice: vi.fn() },
      sleep: async () => {},
    });
    const oversizedTool = { type: "tool", text: "fn_run_verification", detail: "x".repeat(4_096), agent: "executor" };

    deltaRuntime.onLogDelta([oversizedTool]);
    await vi.waitFor(() => expect(deltaAgent.prompts).toHaveLength(1));
    expect(deltaAgent.prompts[0]!.length).toBeLessThanOrEqual(OVERSEER_SESSION_DELTA_MAX_CHARS);
    expect(deltaAgent.prompts[0]).toContain("characters omitted");

    const snapshotAgent = createFakeAgent();
    const snapshotRuntime = new OverseerAdvisorRuntime({
      agent: snapshotAgent,
      host: { enqueueAdvice: vi.fn() },
      sleep: async () => {},
    });
    snapshotRuntime.onLogSnapshot([oversizedTool]);
    await vi.waitFor(() => expect(snapshotAgent.prompts).toHaveLength(1));
    expect(snapshotAgent.prompts[0]!.length).toBeLessThanOrEqual(OVERSEER_SESSION_DELTA_MAX_CHARS);
    expect(snapshotAgent.prompts[0]).toContain("characters omitted");
  });

  it("reset invalidates in-flight work via epoch", async () => {
    const agent = createFakeAgent();
    const runtime = new OverseerAdvisorRuntime({
      agent,
      host: { enqueueAdvice: vi.fn() },
      sleep: async () => {},
    });
    runtime.onLogDelta([{ type: "text", text: "before reset", agent: "executor" }]);
    runtime.reset();
    expect(runtime.backlog).toBe(0);
    expect(agent.reset).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

const { launchCliTaskSessionMock } = vi.hoisted(() => ({ launchCliTaskSessionMock: vi.fn() }));
vi.mock("../cli-agent/task-session.js", () => ({
  CliTaskSession: class {},
  launchCliTaskSession: launchCliTaskSessionMock,
  killLiveTaskSessions: vi.fn(),
}));
import { buildExecutionPrompt } from "../executor/execution-prompt.js";
import { buildFastLanePrompt, buildReducedStepPrompt, buildStepPrompt } from "../execution/step-session-executor.js";
import { acknowledgeOverlapResumeContext, OVERLAP_RESUME_CONTEXT_MARKER, readOverlapResumeContext, readOverlapResumeContextDelivery } from "../execution/overlap-resume-context.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { runCliAgentNode } from "../executor/run-cli-agent-node.js";
import { dispatchHeartbeatTransportWithOverlapAck } from "../agent-heartbeat.js";
import { finalizeImplementationTransportWithOverlapAck } from "../executor/run-implementation.js";

const context = `${OVERLAP_RESUME_CONTEXT_MARKER}\nDuring this task's wait, FN-A delivered changes.\n- src/shared.ts`;
const task = { id: "FN-B", title: "Waiting task", description: "Implement", prompt: "## Mission\nImplement.\n\n## File Scope\n- `src/shared.ts`\n\n## Steps\n\n### Step 0: Work\nDo it.", steps: [{ name: "Work", status: "pending" }], currentStep: 0, dependencies: [], attachments: [], steeringComments: [] } as any;

describe("overlap resume execution entry points", () => {
  it("injects the same factual context in normal, step, reduced, and Fast prompts", () => {
    expect(buildExecutionPrompt(task, "/repo", undefined, "/repo/wt", undefined, undefined, null, { overlapResumeContext: context })).toContain(context);
    expect(buildStepPrompt(task, 0, "/repo", undefined, "/repo/wt", context)).toContain(context);
    expect(buildReducedStepPrompt(task, 0, "/repo", context)).toContain(context);
    expect(buildFastLanePrompt({ ...task, executionMode: "fast" }, "/repo", undefined, "/repo/wt", context)).toContain(context);
  });

  it("omits empty synchronization sections for tasks without an episode", () => {
    expect(buildExecutionPrompt(task)).not.toContain(OVERLAP_RESUME_CONTEXT_MARKER);
    expect(buildStepPrompt(task, 0)).not.toContain(OVERLAP_RESUME_CONTEXT_MARKER);
  });

  it("reads only ready receipts and deduplicates repeated context", async () => {
    const store = { listTaskOverlapWaits: async () => [
      { phase: "ready", receipt: { briefing: context } },
      { phase: "ready", receipt: { briefing: context } },
      { phase: "revalidation-pending", receipt: { briefing: "not approved" } },
    ] } as any;
    expect(await readOverlapResumeContext(store, task.id)).toBe(context);
  });

  it("passes the briefing through the real custom-model dispatch and acknowledges it", async () => {
    const ready = {
      phase: "ready",
      episodeId: "episode-custom",
      revision: 7,
      owner: "run-custom",
      receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-custom", decidedAt: new Date().toISOString() },
    };
    const completeTaskOverlapWait = vi.fn(async () => ready);
    const executeWorkflowStep = vi.fn(async () => ({ success: true, output: "done" }));
    const live = { ...task, worktree: process.cwd(), column: "in-progress" };
    const store = {
      getTask: vi.fn(async () => live),
      listTaskOverlapWaits: vi.fn(async () => [ready]),
      completeTaskOverlapWait,
      logEntry: vi.fn(),
      updateTask: vi.fn(),
    };
    const result = await runGraphCustomNode({
      store,
      rootDir: process.cwd(),
      workspaceConfig: null,
      options: {},
      graphUnattendedRuns: new Set(),
      getRunContextFor: () => undefined,
      adoptColumnAgentForNode: vi.fn(async () => undefined),
      buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
      ensureGraphCustomNodeWorktree: vi.fn(async () => live),
      executeScriptWorkflowStep: vi.fn(),
      executeWorkflowStep,
      pauseForCliApproval: vi.fn(),
      resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
      runAwaitInputNode: vi.fn(),
      runCliAgentNode: vi.fn(),
      runRawCliCommand: vi.fn(),
      runConfiguredCommand: vi.fn(),
    } as any, { id: "custom-work", kind: "prompt", config: { prompt: "Perform custom work", toolMode: "coding" } } as any, live as any, {});

    expect(result.outcome).toBe("success");
    expect(executeWorkflowStep.mock.calls[0]?.[1]?.prompt).toContain(context);
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-custom", phase: "delivered" }));
  });

  it("delivers and acknowledges CLI context only after launch succeeds", async () => {
    const ready = {
      phase: "ready", episodeId: "episode-cli", revision: 2, owner: "run-cli",
      receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-cli", decidedAt: new Date().toISOString() },
    };
    const completeTaskOverlapWait = vi.fn(async () => ready);
    const store = { listTaskOverlapWaits: vi.fn(async () => [ready]), completeTaskOverlapWait, logEntry: vi.fn() } as any;
    const session = { result: vi.fn(async () => ({ kind: "success" })), kill: vi.fn() };
    launchCliTaskSessionMock.mockRejectedValueOnce(new Error("launch failed")).mockResolvedValueOnce(session);
    const deps = {
      store, getRunContextFor: () => undefined, activeCliTaskSessions: new Map(),
      cliAgentRuntime: { manager: {}, hub: {}, registry: {}, store: {}, projectId: "p", hookEndpointUrl: "http://hooks" },
      reapCliTaskSessionForHandoff: vi.fn(),
    } as any;
    const node = { id: "cli", kind: "prompt" } as any;
    const cfg = { cliAdapterId: "test", prompt: "Run CLI" };
    const live = { ...task, worktree: process.cwd() };

    await expect(runCliAgentNode(deps, node, live, cfg)).rejects.toThrow("launch failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    await expect(runCliAgentNode(deps, node, live, cfg)).resolves.toMatchObject({ outcome: "success" });
    expect(launchCliTaskSessionMock.mock.calls[1]?.[0]?.prompt).toContain(context);
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-cli", phase: "delivered" }));
  });

  it("keeps heartbeat context pending after a failed send and acknowledges the successful retry", async () => {
    const delivery = { context, episodes: [{ episodeId: "heartbeat-episode", revision: 3, owner: "heartbeat", receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "heartbeat-fp", briefing: context, decidedAt: new Date().toISOString() } }] } as any;
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = { completeTaskOverlapWait } as any;
    await expect(dispatchHeartbeatTransportWithOverlapAck({ send: async () => { throw new Error("transport failed"); }, store, taskId: task.id, delivery })).rejects.toThrow("transport failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    const send = vi.fn(async () => undefined);
    await dispatchHeartbeatTransportWithOverlapAck({ send, store, taskId: task.id, delivery });
    expect(send).toHaveBeenCalledOnce();
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "heartbeat-episode", phase: "delivered" }));
  });

  it("fences external implementation acknowledgement on the real session success check", async () => {
    const delivery = { context, episodes: [{ episodeId: "external-episode", revision: 5, owner: "external", receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "external-fp", briefing: context, decidedAt: new Date().toISOString() } }] } as any;
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = { completeTaskOverlapWait } as any;
    await expect(finalizeImplementationTransportWithOverlapAck({ session: { state: { errorMessage: "send failed" } } as any, store, taskId: task.id, delivery })).rejects.toThrow("send failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    await finalizeImplementationTransportWithOverlapAck({ session: { state: {} } as any, store, taskId: task.id, delivery });
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "external-episode", phase: "delivered" }));
  });

  it("acknowledges only generations captured before the successful transport", async () => {
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = {
      listTaskOverlapWaits: vi.fn(async () => [{
        phase: "ready",
        episodeId: "episode-a",
        revision: 4,
        owner: "run-a",
        receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-a", decidedAt: new Date().toISOString() },
      }]),
      completeTaskOverlapWait,
    } as any;
    const delivery = await readOverlapResumeContextDelivery(store, task.id);
    // A newer generation can become ready while the captured prompt is in flight.
    store.listTaskOverlapWaits.mockResolvedValue([{ phase: "ready", episodeId: "episode-c", revision: 1, owner: "run-c", receipt: { briefing: "new context" } }]);

    await acknowledgeOverlapResumeContext(store, task.id, delivery);

    expect(completeTaskOverlapWait).toHaveBeenCalledOnce();
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-a", expectedRevision: 4, owner: "run-a", phase: "delivered" }));
    expect(completeTaskOverlapWait).not.toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-c" }));
  });
});

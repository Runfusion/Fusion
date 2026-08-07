import { describe, expect, it } from "vitest";
import { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";

const agent = (id: string, maxWorkflowSessions?: number) => ({ id, runtimeConfig: { maxWorkflowSessions } }) as any;

describe("WorkflowAgentCapacity", () => {
  it("keeps workflow and heartbeat limits independent while enforcing project then agent limits", async () => {
    const capacity = new WorkflowAgentCapacity();
    const constrained = agent("executor", 1);
    expect(await capacity.acquire({ projectId: "project-a", agent: constrained, attemptId: "one", maxProjectSessions: 2 })).toMatchObject({ status: "acquired" });
    expect(await capacity.acquire({ projectId: "project-a", agent: constrained, attemptId: "two", maxProjectSessions: 2 })).toEqual({ status: "held", reason: "agent-capacity" });
    expect(await capacity.acquire({ projectId: "project-a", agent: agent("reviewer"), attemptId: "three", maxProjectSessions: 2 })).toMatchObject({ status: "acquired" });
    expect(await capacity.acquire({ projectId: "project-a", agent: agent("merger"), attemptId: "four", maxProjectSessions: 2 })).toEqual({ status: "held", reason: "project-capacity" });
  });

  it("isolates matching agent and attempt IDs across projects", async () => {
    const capacity = new WorkflowAgentCapacity();
    expect(await capacity.acquire({ projectId: "project-a", agent: agent("same", 1), attemptId: "attempt" })).toMatchObject({ status: "acquired" });
    expect(await capacity.acquire({ projectId: "project-b", agent: agent("same", 1), attemptId: "attempt" })).toMatchObject({ status: "acquired" });
    expect(capacity.activeSessions("same", "project-a")).toBe(1);
    expect(capacity.activeSessions("same", "project-b")).toBe(1);
    expect(await capacity.release("attempt", "project-a")).toBe(true);
    expect(capacity.activeSessions("same", "project-b")).toBe(1);
  });

  it("allows a fenced attempt to reacquire and releases exactly once", async () => {
    const capacity = new WorkflowAgentCapacity();
    const input = { projectId: "project-a", agent: agent("executor", 1), attemptId: "attempt", maxProjectSessions: 1 };
    const first = await capacity.acquire(input);
    expect(await capacity.acquire(input)).toEqual(first);
    expect(capacity.activeSessions("executor")).toBe(1);
    expect(await capacity.release("attempt")).toBe(true);
    expect(await capacity.release("attempt")).toBe(false);
    expect(capacity.activeSessions("executor")).toBe(0);
  });

  it("passes a finite durable TTL so a crashed engine lease can be reclaimed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const capacity = new WorkflowAgentCapacity({
      acquireWorkflowSessionCapacity: async (input) => { calls.push(input); return "acquired"; },
      releaseWorkflowSessionCapacity: async () => undefined,
    });
    await capacity.acquire({ projectId: "project-a", agent: agent("executor"), attemptId: "crash-safe" });
    expect(calls[0]).toMatchObject({ attemptId: "crash-safe", leaseDurationMs: 10 * 60_000 });
    await capacity.release("crash-safe", "project-a");
  });
});

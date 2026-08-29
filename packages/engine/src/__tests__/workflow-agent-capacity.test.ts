import { describe, expect, it } from "vitest";
import { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";

const agent = (id: string, maxWorkflowSessions?: number) => ({ id, runtimeConfig: { maxWorkflowSessions } }) as any;

describe("WorkflowAgentCapacity", () => {
  /*
  FNXC:WorkflowAgentRouting 2026-08-11-09:12:
  Replaces the former "enforces project then agent limits" case. Workflow principals have NO execution
  cap: one Workflow Executor must be able to hold many concurrent sessions, because a per-principal
  ceiling serialized the whole board (there is typically exactly one agent per role) and its refusal
  became a durable `held` row no dispatcher re-polled.
  */
  it("never refuses a workflow principal, however many sessions it already holds", async () => {
    const capacity = new WorkflowAgentCapacity();
    // `maxWorkflowSessions: 1` is deliberately set and must be ignored — it is the exact config that
    // used to serialize a single-executor board.
    const constrained = agent("executor", 1);
    for (const attemptId of ["one", "two", "three", "four", "five"]) {
      expect(await capacity.acquire({ projectId: "project-a", agent: constrained, attemptId })).toMatchObject({ status: "acquired" });
    }
    expect(capacity.activeSessions("executor", "project-a")).toBe(5);
    // A second role on the same project is likewise uncapped.
    expect(await capacity.acquire({ projectId: "project-a", agent: agent("reviewer"), attemptId: "six" })).toMatchObject({ status: "acquired" });
  });

  it("passes no session limits to the durable store, so a cap cannot be reintroduced by the caller", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const capacity = new WorkflowAgentCapacity({
      acquireWorkflowSessionCapacity: async (input) => { calls.push(input); return "acquired"; },
      releaseWorkflowSessionCapacity: async () => undefined,
    });
    await capacity.acquire({ projectId: "project-a", agent: agent("executor", 1), attemptId: "uncapped" });
    expect(calls[0]).not.toHaveProperty("maxProjectSessions");
    expect(calls[0]).not.toHaveProperty("maxAgentSessions");
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
    const input = { projectId: "project-a", agent: agent("executor", 1), attemptId: "attempt" };
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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { buildOverlapDeltaReviewPrompt, revalidatePendingOverlapWaitsAtGraphNode, runOverlapPlanRevalidation } from "../workflows/overlap-plan-revalidation.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-B", prompt: "## Mission\nKeep sharedApi compatible.", steps: [{ name: "Preflight", status: "done" }, { name: "Implement", status: "in-progress" }], currentStep: 1 } as any;
const receipt = { decision: "revalidate" as const, freshness: "proven" as const, commonFiles: ["src/shared.ts"], deliveryProofs: [{ repository: ".", landedSha: "c1" }], decisionFingerprint: "delta-1", decidedAt: "2026-09-09T23:53:00.000Z" };

describe("overlap plan delta revalidation", () => {
  it("uses a distinct delta fingerprint and asks only about invalidated promises", async () => {
    const review = vi.fn(async () => ({ verdict: "APPROVE" }));
    await expect(runOverlapPlanRevalidation({ task, receipt, expectedIdentity: "plan+delta-1", readCurrentIdentity: async () => "plan+delta-1", review })).resolves.toEqual({ verdict: "APPROVE" });
    expect(review).toHaveBeenCalledWith(expect.stringContaining("Review only whether the delivered delta invalidates"), { cacheKey: "plan+delta-1", nested: true });
    expect(buildOverlapDeltaReviewPrompt({ task, receipt })).toContain("src/shared.ts");
  });

  it("does not invoke a reviewer for resume or briefing decisions", async () => {
    const review = vi.fn();
    await expect(runOverlapPlanRevalidation({ task, receipt: { ...receipt, decision: "briefing" }, expectedIdentity: "brief", readCurrentIdentity: async () => "brief", review })).resolves.toEqual({ verdict: "APPROVE" });
    expect(review).not.toHaveBeenCalled();
  });

  it("accepts REVISE only when it names the invalidated promise", async () => {
    const current = async () => "identity";
    await expect(runOverlapPlanRevalidation({ task, receipt, expectedIdentity: "identity", readCurrentIdentity: current, review: async () => ({ verdict: "REVISE" }) })).resolves.toEqual({ verdict: "UNAVAILABLE" });
    await expect(runOverlapPlanRevalidation({ task, receipt, expectedIdentity: "identity", readCurrentIdentity: current, review: async () => ({ verdict: "REVISE", invalidatedPromise: "sharedApi remains compatible", feedback: "Update only this contract." }) })).resolves.toMatchObject({ verdict: "REVISE", invalidatedPromise: "sharedApi remains compatible" });
    expect(task.steps[0].status).toBe("done");
  });

  it.each([
    ["empty", async () => ({})],
    ["malformed", async () => ({ verdict: "RETHINK" })],
    ["provider rejection", async () => { throw new Error("provider unavailable"); }],
  ])("maps %s review outcomes to retryable UNAVAILABLE", async (_label, review) => {
    await expect(runOverlapPlanRevalidation({ task, receipt, expectedIdentity: "identity", readCurrentIdentity: async () => "identity", review })).resolves.toEqual({ verdict: "UNAVAILABLE" });
  });

  it("runs the pending delta review before the real graph node and persists approval", async () => {
    const live = { ...task, column: "in-progress", prompt: task.prompt } as TaskDetail;
    const pending = { projectId: "p", taskId: live.id, episodeId: "episode-1", blockerTaskId: "FN-A", observedAt: receipt.decidedAt, phase: "revalidation-pending", revision: 3, owner: "graph-owner", attempt: 1, receipt, updatedAt: receipt.decidedAt } as any;
    const completeTaskOverlapWait = vi.fn(async (input: any) => ({ ...pending, ...input, phase: "ready", revision: 4 }));
    const store = {
      listTaskOverlapWaits: vi.fn(async () => [pending]),
      completeTaskOverlapWait,
      getTask: vi.fn(async () => live),
    };
    const nodeHandler = vi.fn(async () => ({ outcome: "success" as const }));
    const graph = new WorkflowGraphExecutor({
      handlers: { prompt: nodeHandler },
      beforeNodeExecution: async (node) => {
        const outcome = await revalidatePendingOverlapWaitsAtGraphNode({
          task: live,
          store: store as any,
          nodeId: node.id,
          review: async () => ({ success: true, verdict: "APPROVE", notes: "The delivered signature remains compatible." }),
          repair: vi.fn(async () => true),
        });
        return outcome === "approved" || outcome === "not-required" ? undefined : { outcome: "failure", value: `overlap-plan-revalidation-${outcome}` };
      },
    });
    const ir: WorkflowIr = { version: "v2", name: "overlap-review", columns: [{ id: "in-progress", name: "Work", traits: [] }], nodes: [{ id: "start", kind: "start" }, { id: "execute", kind: "prompt", config: { prompt: "Execute" } }, { id: "end", kind: "end" }], edges: [{ from: "start", to: "execute" }, { from: "execute", to: "end" }] };

    const result = await graph.run(live, { experimentalFeatures: { workflowGraphExecutor: true } }, ir);

    expect(result.outcome).toBe("success");
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "ready", expectedRevision: 3 }));
    expect(nodeHandler).toHaveBeenCalledTimes(1);
  });

  it("repairs REVISE in place and obtains a second approval before resuming", async () => {
    let live = { ...task, column: "in-progress" } as TaskDetail;
    const pending = { projectId: "p", taskId: live.id, episodeId: "episode-revise", blockerTaskId: "FN-A", observedAt: receipt.decidedAt, phase: "revalidation-pending", revision: 7, owner: "graph-owner", attempt: 1, planFingerprint: createHash("sha256").update(live.prompt!).digest("hex"), receipt, updatedAt: receipt.decidedAt } as any;
    let current = pending;
    const completeTaskOverlapWait = vi.fn(async (input: any) => {
      current = { ...current, ...input, revision: current.revision + 1 };
      return current;
    });
    const claimTaskOverlapWait = vi.fn(async (input: any) => {
      current = { ...current, phase: "analyzing", revision: current.revision + 1, observation: { executionIdentity: input.executionIdentity } };
      return current;
    });
    const repair = vi.fn(async () => {
      live = { ...live, prompt: `${live.prompt}\n\n## Targeted repair\nKeep sharedApi compatible.` };
      return true;
    });
    const review = vi.fn()
      .mockResolvedValueOnce({ success: false, verdict: "REVISE", notes: "Keep sharedApi compatible." })
      .mockResolvedValueOnce({ success: true, verdict: "APPROVE" });
    const outcome = await revalidatePendingOverlapWaitsAtGraphNode({
      task: live,
      store: {
        listTaskOverlapWaits: vi.fn(async () => [current]),
        claimTaskOverlapWait,
        completeTaskOverlapWait,
        getTask: vi.fn(async () => live),
      } as any,
      nodeId: "execute",
      review,
      repair,
    });

    expect(outcome).toBe("approved");
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "repair-required", expectedRevision: 7 }));
    expect(repair).toHaveBeenCalledWith(expect.objectContaining({ invalidatedPromise: "Keep sharedApi compatible." }));
    expect(claimTaskOverlapWait).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledTimes(2);
    expect(live.column).toBe("in-progress");
    expect(live.steps?.[0]?.status).toBe("done");
  });

  it("reclaims a repaired plan with an exact durable execution identity before second approval", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "fn-332-revalidation-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: worktree });
      execFileSync("git", ["config", "user.email", "fusion@example.test"], { cwd: worktree });
      execFileSync("git", ["config", "user.name", "Fusion Test"], { cwd: worktree });
      writeFileSync(join(worktree, "shared.ts"), "export const sharedApi = true;\n");
      execFileSync("git", ["add", "shared.ts"], { cwd: worktree });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: worktree });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
      const oldPrompt = task.prompt;
      const repaired = {
        ...task,
        prompt: `${oldPrompt}\n\n## Repair\nUse the delivered sharedApi signature.`,
        lineageId: "lineage-b",
        checkoutLeaseEpoch: 4,
        worktree,
        branch: "fusion/fn-b",
      } as TaskDetail;
      const priorIdentity = {
        taskLineageId: "lineage-b", planFingerprint: createHash("sha256").update(oldPrompt).digest("hex"),
        checkoutEpoch: "4", worktree, branch: "fusion/fn-b", headSha,
        repository: "packages/app", target: "main", nodeId: "execute", nodeInstanceId: "execute:1",
      };
      const repairRequired = {
        projectId: "p", taskId: repaired.id, episodeId: "episode-repaired", blockerTaskId: "FN-A",
        observedAt: receipt.decidedAt, phase: "repair-required", revision: 9, owner: "graph-owner", attempt: 1,
        planFingerprint: priorIdentity.planFingerprint, observation: { executionIdentity: priorIdentity },
        receipt: { ...receipt, revalidationVerdict: "REVISE", invalidatedPromise: "sharedApi remains compatible" },
        updatedAt: receipt.decidedAt,
      } as any;
      let current = repairRequired;
      const identityKeys = ["taskLineageId", "planFingerprint", "checkoutEpoch", "worktree", "branch", "headSha", "repository", "target", "nodeId", "nodeInstanceId"];
      const sameIdentity = (left: any, right: any) => identityKeys.every((key) => left?.[key] === right?.[key]);
      const claimTaskOverlapWait = vi.fn(async (input: any) => {
        current = { ...current, phase: "analyzing", revision: 10, observation: { ...current.observation, executionIdentity: input.executionIdentity } };
        return current;
      });
      const completeTaskOverlapWait = vi.fn(async (input: any) => {
        if (!sameIdentity(input.executionIdentity, current.observation.executionIdentity)) return null;
        current = { ...current, ...input, observation: current.observation, revision: current.revision + 1 };
        return current;
      });
      const review = vi.fn(async () => ({ success: true, verdict: "APPROVE" }));

      const outcome = await revalidatePendingOverlapWaitsAtGraphNode({
        task: repaired,
        store: {
          listTaskOverlapWaits: vi.fn(async () => [current]),
          claimTaskOverlapWait,
          completeTaskOverlapWait,
          getTask: vi.fn(async () => repaired),
        } as any,
        nodeId: "execute",
        review,
        repair: vi.fn(async () => true),
      });

      expect(outcome).toBe("approved");
      expect(claimTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({
        expectedRevision: 9,
        executionIdentity: expect.objectContaining({ headSha, repository: "packages/app", target: "main", nodeId: "execute", nodeInstanceId: "execute:1" }),
      }));
      expect(completeTaskOverlapWait).toHaveBeenNthCalledWith(1, expect.objectContaining({ phase: "revalidation-pending", expectedRevision: 10 }));
      expect(completeTaskOverlapWait).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: "ready", expectedRevision: 11 }));
      expect(review).toHaveBeenCalledOnce();
      expect(repaired.steps?.[0]?.status).toBe("done");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("rejects a verdict when plan or delivery identity changes during review", async () => {
    let read = 0;
    const review = vi.fn(async () => ({ verdict: "APPROVE" }));
    await expect(runOverlapPlanRevalidation({ task, receipt, expectedIdentity: "identity", readCurrentIdentity: async () => ++read === 1 ? "identity" : "new-identity", review })).resolves.toEqual({ verdict: "UNAVAILABLE" });
  });
});

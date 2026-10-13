import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import kbExtension, { __setCachedStoreForTesting, closeCachedStores } from "../extension.js";

/*
FNXC:StrandedGateRetry 2026-10-13-05:10 (STAS-299 req 4 + Invariant C):
`fn_task_retry` on the extension is the retry a coding agent actually holds, and it was the surface
whose silence cost STAS-281 2.2 days: self-heal declared the Plan Review session dead, flipped its
`pending` row to `failed`, and left the card in the hold lane with an approved plan and a full step
list — a failure shape this tool could not see, because it admitted only a card-level `failed` /
`stuck-killed` or an in-review stall.

The shared core classification is proven in `packages/core/src/__tests__/stranded-gate-retry.test.ts`.
What THIS file owns is that the extension surface consumes it: the same card, retried through the tool,
comes out with the gate discharged and the approved work untouched, and the tool ADVERTISES the hatch
so an agent in session knows it exists rather than parking.
*/

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { id: string },
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool: (def: RegisteredTool) => tools.set(def.name, def),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    on: () => {},
    tools,
  };
  return api as unknown as { tools: Map<string, RegisteredTool> };
}

const h = createSharedPgTaskStoreTestHarness({ prefix: "fn_stranded_gate_retry" });

pgDescribe("extension fn_task_retry stranded-gate discharge", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    tmpDir = h.rootDir();
    __setCachedStoreForTesting(tmpDir, h.store());
    api = createMockAPI();
    kbExtension(api);
  });
  afterEach(async () => {
    await closeCachedStores();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function seedStrandedCard(status: "failed" | null) {
    const store = h.store();
    const task = await store.createTask({
      title: "plan-review stranded in the hold lane",
      description: "test",
      column: "todo",
    });
    await store.updateTask(task.id, {
      status,
      error: status === "failed" ? "1 workflow step result(s) marked failed by self-healing (FN-8492)" : null,
      approvedPlanFingerprint: "7a73aaff",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Await the plan-review verdict", status: "pending" },
      ],
      currentStep: 1,
      worktree: "/tmp/fusion-stranded-worktree",
      branch: `fusion/${task.id}`,
      branchWriteOrigin: "engine" as const,
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        source: "optional-group",
        status: "failed",
        reviewKind: "plan",
        startedAt: "2026-09-24T00:16:39.000Z",
        output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
      }],
    });
    return task;
  }

  it.each([["the post-fix card self-heal parked as failed", "failed" as const], ["the card stranded before the lifecycle fix", null as const]])(
    "discharges the verdict-less plan gate in place — %s", async (_name, status) => {
      const store = h.store();
      const task = await seedStrandedCard(status);
      const retry = api.tools.get("fn_task_retry")!;

      const result = await retry.execute("retry-1", { id: task.id }, undefined, undefined, { cwd: tmpDir });

      expect(result.isError).toBeUndefined();
      expect(result.details.strandedGateRetried).toBe(true);
      expect(result.details.gateStepIds).toEqual(["plan-review"]);
      expect(result.content[0].text).toContain("gate row(s) were discharged");

      const updated = await store.getTask(task.id);
      expect(updated.column).toBe("todo");
      expect(updated.status).toBeFalsy();
      expect(updated.error).toBeFalsy();
      expect(updated.workflowStepResults ?? []).toEqual([]);
      // Invariant C: the plan and everything the executor already built survive the retry.
      expect(updated.approvedPlanFingerprint).toBe("7a73aaff");
      expect(updated.steps?.map((step) => step.status)).toEqual(["done", "pending"]);
      expect(updated.worktree).toBe("/tmp/fusion-stranded-worktree");
      expect(updated.branch).toBe(`fusion/${task.id}`);
    },
  );

  it("advertises the hatch to the agent that holds the tool", async () => {
    /* Requirement 4's other half: a hatch an agent does not know about is a hatch it will not use.
       STAS-281's card sat in `todo` while agents reported it as needing operator attention. */
    const retry = api.tools.get("fn_task_retry")!;
    expect(retry.description).toContain("no verdict");
    expect(retry.description).toContain("discharges that gate in place");
    expect((retry.promptGuidelines ?? []).some((line) => line.includes("verdict-less failed Plan/Code Review row"))).toBe(true);
  });
});

/*
FNXC:NoVerdictFailureDiagnostic 2026-11-04-05:30 (RUFU-381):
A custom-node gate session that fails for a NAMED reason used to lose that reason at the node
boundary. The incident: card RUFU-259's `code-review` gate died seven times in four hours and every
durable History line read `Code Review failed before producing a verdict: failed` — six identical
rows, zero causes — because `runGraphCustomNode` mapped the session result to
`value: failureValue ?? verdict ?? (success ? "passed" : "failed")` and published
`node:<id>:error` for ONE refusal value only. Every other failure shape (the timeout shape, the
readonly-violation shape, the generic catch's `err.message`) had its `error` string dropped on the
floor, and `synthesizeNonVerdictFailureOutput` then echoed the minted `"failed"` back as the
"diagnostic".

These tests pin the boundary contract: a failed gate result carrying a non-empty error publishes that
text on the canonical `node:<id>:error` carrier, on BOTH mapping seams (the prompt/script dispatch
and the raw-CLI branch), while a failure with nothing to say publishes nothing.
*/

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Settings, TaskDetail } from "@fusion/core";

import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";

const now = "2026-11-01T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "RUFU-381",
    title: "Forward the real cause at the node boundary",
    description: "A gate failure must not be reduced to its own status word.",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    prompt: "# Task\n",
    worktree: process.cwd(),
    ...overrides,
  } as TaskDetail;
}

function harness(row: TaskDetail) {
  const store = {
    getTask: vi.fn(async () => row),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
    isWorkflowCliCommandApproved: vi.fn(async () => false),
  };
  return {
    store,
    rootDir: process.cwd(),
    workspaceConfig: null,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => row),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "ok" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(async () => ({ success: true, output: "ok" })),
    runConfiguredCommand: vi.fn(),
  };
}

/** A blocking prompt gate with no `reviewKind`, so the content-review proof seam stays out of the way. */
function promptGateNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-review",
    kind: "gate",
    config: { name: "Code Review", gateMode: "gate", prompt: "Review", ...overrides },
  } as const;
}

/** A blocking raw-CLI gate — the second mapping seam, which returned no contextPatch at all. */
function cliGateNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "cli-gate",
    kind: "gate",
    config: {
      name: "CLI Gate",
      gateMode: "gate",
      executor: "cli",
      cliCommand: "pnpm check",
      // Trust-on-first-use is a separate concern; this suite is about the error carrier.
      cliSkipApproval: true,
      ...overrides,
    },
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("custom-node gate error forwarding (RUFU-381)", () => {
  describe("prompt/script dispatch mapping", () => {
    it("forwards the generic session-catch error text instead of dropping it", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({ success: false, error: "provider returned 502" });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "failure", value: "failed" });
      expect(result.contextPatch?.["node:code-review:error"]).toBe("provider returned 502");
    });

    it("forwards the timeout shape's error text", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({
        success: false,
        error: "workflow step timed out after 900000ms",
        timedOut: true,
        verdictRequired: true,
      });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result.contextPatch?.["node:code-review:error"]).toBe("workflow step timed out after 900000ms");
    });

    it("forwards the readonly-violation shape's error text", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({ success: false, error: "[readonly-violation] denied tool bash" });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result.contextPatch?.["node:code-review:error"]).toBe("[readonly-violation] denied tool bash");
    });

    it("publishes nothing when the failure carries no cause to name", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({ success: false });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "failure", value: "failed" });
      expect(result.contextPatch ?? {}).not.toHaveProperty("node:code-review:error");
    });

    it("publishes nothing for a whitespace-only error", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({ success: false, error: "   \n " });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result.contextPatch ?? {}).not.toHaveProperty("node:code-review:error");
    });

    it("never publishes an error for a result that succeeded", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({ success: true, output: "APPROVE", verdict: "APPROVE", error: "stale" });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "success", value: "APPROVE" });
      expect(result.contextPatch ?? {}).not.toHaveProperty("node:code-review:error");
    });

    it("carries a reserved failure value's error text on the same carrier", async () => {
      const row = task();
      const deps = harness(row);
      deps.executeWorkflowStep.mockResolvedValue({
        success: false,
        error: "review input unprovable: git-diff-too-large",
        failureValue: "review-input-unprovable",
      });

      const result = await runGraphCustomNode(deps as never, promptGateNode() as never, row, {} as Settings);

      expect(result.contextPatch?.["node:code-review:error"]).toBe("review input unprovable: git-diff-too-large");
    });
  });

  describe("raw-CLI gate mapping", () => {
    it("forwards the command's error text on the same carrier", async () => {
      const row = task();
      const deps = harness(row);
      deps.runRawCliCommand.mockResolvedValue({ success: false, error: "exit 1: 3 files unformatted" });

      const result = await runGraphCustomNode(deps as never, cliGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "failure", value: "failed" });
      expect(result.contextPatch?.["node:cli-gate:error"]).toBe("exit 1: 3 files unformatted");
    });

    it("publishes nothing for a cli gate that passed", async () => {
      const row = task();
      const deps = harness(row);
      deps.runRawCliCommand.mockResolvedValue({ success: true, output: "all good" });

      const result = await runGraphCustomNode(deps as never, cliGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "success", value: "passed" });
      expect(result.contextPatch ?? {}).not.toHaveProperty("node:cli-gate:error");
    });

    it("publishes nothing when the failing cli gate had no error text", async () => {
      const row = task();
      const deps = harness(row);
      deps.runRawCliCommand.mockResolvedValue({ success: false });

      const result = await runGraphCustomNode(deps as never, cliGateNode() as never, row, {} as Settings);

      expect(result).toMatchObject({ outcome: "failure", value: "failed" });
      expect(result.contextPatch ?? {}).not.toHaveProperty("node:cli-gate:error");
    });
  });
});

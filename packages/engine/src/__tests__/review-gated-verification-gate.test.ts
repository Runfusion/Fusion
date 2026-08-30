import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIrNode } from "@fusion/core";
import { runDeterministicVerificationGate } from "../workflow-node-runners/verification-gate.js";
import { GateNodeRunner } from "../workflow-node-runners/gate-runner.js";

const node: WorkflowIrNode = { id: "verification-step", kind: "gate", column: "in-review", config: { workflowAction: "deterministic-verification" } };
const task = { id: "FN-175" } as Task;
const settings = (overrides: Partial<Settings> = {}) => ({ testCommand: "pnpm test", buildCommand: "pnpm build", ...overrides }) as Settings;
const deps = (runVerification: unknown) => ({ store: {} as TaskStore, runVerification: runVerification as never });

function commandResult(overrides: Record<string, unknown> = {}) {
  return { command: "pnpm test", exitCode: 0, stdout: "", stderr: "", success: true, ...overrides };
}

/*
FNXC:ReviewGatedVerification 2026-08-25-08:15:
The wiring suite below is the one that mattered and did not exist. Every assertion in this file used
to call `runDeterministicVerificationGate` directly, so the whole set stayed green while the gate was
NEVER REACHED in production: `GateNodeRunner` recognised only `prompt` and `scriptName` as executable
and returned a silent success for a `workflowAction` node. Verification completed in ~46ms and
recorded a PASS without running anything.
Testing a function proves the function. It does not prove the graph calls it.
*/
describe("GateNodeRunner wiring", () => {
  const runnerContext = (context: Record<string, unknown> = {}) => ({ task, context, signal: undefined }) as never;

  it("routes a workflowAction gate to the custom-node runner instead of passing it silently", async () => {
    const runCustomNode = vi.fn().mockResolvedValue({ outcome: "failure", value: "failed" });
    const runner = new GateNodeRunner(runCustomNode as never);

    const outcome = await runner.run(node, runnerContext());

    expect(runCustomNode).toHaveBeenCalledTimes(1);
    expect(runCustomNode.mock.calls[0]?.[0]).toMatchObject({ id: "verification-step" });
    // A gate that cannot run its body must never report success on the strength of not trying.
    expect(outcome).toMatchObject({ outcome: "failure" });
  });

  it("still routes the prompt and scriptName shapes it already supported", async () => {
    for (const config of [{ prompt: "review this" }, { scriptName: "verify.sh" }]) {
      const runCustomNode = vi.fn().mockResolvedValue({ outcome: "success" });
      const runner = new GateNodeRunner(runCustomNode as never);
      await runner.run({ ...node, config } as WorkflowIrNode, runnerContext());
      expect(runCustomNode).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps a pure context gate declarative — no runner call, verdict from graph state", async () => {
    const runCustomNode = vi.fn();
    const runner = new GateNodeRunner(runCustomNode as never);
    const contextGate = { ...node, config: { expect: "success", contextKey: "outcome" } } as WorkflowIrNode;

    await expect(runner.run(contextGate, runnerContext({ outcome: "success" }))).resolves.toMatchObject({ outcome: "success" });
    await expect(runner.run(contextGate, runnerContext({ outcome: "failure" }))).resolves.toMatchObject({ outcome: "failure", value: "gate-mismatch" });
    expect(runCustomNode).not.toHaveBeenCalled();
  });
});

describe("runDeterministicVerificationGate", () => {
  it("delegates to the shared executor verification primitive rather than re-running commands", async () => {
    const runVerification = vi.fn().mockResolvedValue({ allPassed: true });
    const gate = await runDeterministicVerificationGate(deps(runVerification), node, task, settings(), "/worktree");

    expect(gate).toMatchObject({ outcome: "success", value: "passed" });
    // The primitive owns command selection, ordering, and timeouts — this gate must not re-derive them.
    expect(runVerification).toHaveBeenCalledTimes(1);
    expect(runVerification.mock.calls[0]?.[3]).toMatchObject({ testCommand: "pnpm test", buildCommand: "pnpm build" });
    expect(runVerification.mock.calls[0]?.[2]).toBe("/worktree");
  });

  it("fails on a non-zero result and preserves its command label", async () => {
    const runVerification = vi.fn().mockResolvedValue({
      allPassed: false,
      failedCommand: "testCommand",
      testResult: commandResult({ exitCode: 1, success: false, stderr: "failure tail" }),
    });
    const gate = await runDeterministicVerificationGate(deps(runVerification), node, task, settings(), "/worktree");

    expect(gate).toMatchObject({ outcome: "failure", value: "failed" });
    expect(String(gate.contextPatch.output)).toContain("testCommand");
    expect(String(gate.contextPatch.output)).toContain("failure tail");
  });

  /*
  FNXC:ReviewGatedVerification 2026-08-25-08:15:
  An unconfigured gate reports SKIPPED, not passed and not failed. Failing closed was the previous
  contract and it is wrong for the default project shape (no testCommand configured): it would fail
  every task on a project that never opted in. Passing is equally wrong — it is a green badge for a
  check nobody ran. `workflow-step-skipped` is the existing fast-mode vocabulary and renders as a
  skipped step, which is the honest third answer.
  */
  it("reports not-configured — never passed — when no command is configured", async () => {
    const runVerification = vi.fn();
    const gate = await runDeterministicVerificationGate(
      deps(runVerification), node, task, settings({ testCommand: undefined, buildCommand: undefined }), "/worktree",
    );

    expect(gate.value).toBe("not-configured");
    expect(gate.value).not.toBe("passed");
    expect(String(gate.contextPatch.output)).toContain("NOTHING WAS VERIFIED");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("classifies an infrastructure fault apart from a failing test, ignoring claimed output text", async () => {
    const runVerification = vi.fn().mockResolvedValue({
      allPassed: false,
      failedCommand: "testCommand",
      testResult: commandResult({ exitCode: null, success: false, timedOut: true, stdout: "verification passed" }),
    });
    const gate = await runDeterministicVerificationGate(deps(runVerification), node, task, settings({ buildCommand: undefined }), "/worktree");

    expect(gate).toMatchObject({ outcome: "failure", value: "verification-infrastructure-failure" });
    expect(String(gate.contextPatch.output)).toContain("timed-out");
  });
});

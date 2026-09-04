import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskStep, WorkflowIrNode } from "@fusion/core";
import { ParseStepsNodeRunner } from "../workflow-node-runners/parse-steps-runner.js";

const node = (config: Record<string, unknown>): WorkflowIrNode => ({ id: "parse", kind: "parse-steps", config });
const task = (steps: TaskStep[] = []) => ({ id: "FN-175", steps } as TaskDetail);

describe("review-gated parse-step preservation", () => {
  it("preserves live remediation before an empty parse can replace task steps", async () => {
    const writeSteps = async () => { throw new Error("must not write"); };
    const runner = new ParseStepsNodeRunner({
      readArtifact: async () => "",
      writeSteps,
      getLiveTask: async () => task([{ name: "Fix: guard", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "guard" } }]),
    });
    await expect(runner.run(node({ artifact: "PROMPT.md", parser: "step-headings", preserveRemediationSteps: true }), { task: task(), context: {} }))
      .resolves.toMatchObject({ outcome: "success", value: "preserved-remediation-steps" });
  });

  it("keeps live remediation steps ahead of Fast synthetic projection", async () => {
    const readArtifact = vi.fn(async () => "### Step 1: stale");
    const writeSteps = vi.fn(async () => undefined);
    const fastTask = { ...task(), executionMode: "fast" } as TaskDetail;
    const runner = new ParseStepsNodeRunner({
      readArtifact,
      writeSteps,
      getLiveTask: async () => ({
        ...fastTask,
        steps: [{ name: "Fix: guard", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "guard" } }],
      }),
    });

    await expect(runner.run(node({ artifact: "PROMPT.md", parser: "step-headings" }), { task: fastTask, context: {} }))
      .resolves.toMatchObject({ outcome: "success", value: "preserved-remediation-steps" });
    expect(readArtifact).not.toHaveBeenCalled();
    expect(writeSteps).not.toHaveBeenCalled();
  });

  it("keeps an already-expanded foreach ahead of Fast synthetic projection", async () => {
    const readArtifact = vi.fn(async () => "### Step 1: stale");
    const writeSteps = vi.fn(async () => undefined);
    const fastTask = { ...task([{ name: "Pinned", status: "in-progress" }]), executionMode: "fast" } as TaskDetail;
    const runner = new ParseStepsNodeRunner({
      readArtifact,
      writeSteps,
      hasExpandedForeach: async () => true,
    });

    await expect(runner.run(node({ artifact: "PROMPT.md", parser: "step-headings" }), { task: fastTask, context: {} }))
      .resolves.toMatchObject({ outcome: "success", value: "already-expanded" });
    expect(readArtifact).not.toHaveBeenCalled();
    expect(writeSteps).not.toHaveBeenCalled();
  });

  it("preserves a completed remediation occurrence and its pending verification successor", async () => {
    const writes: TaskStep[][] = [];
    const audits: string[] = [];
    const liveSteps: TaskStep[] = [
      {
        name: "Fix: guard",
        status: "done",
        remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "guard" },
      },
      { name: "Testing & Verification", status: "pending" },
    ];
    const runner = new ParseStepsNodeRunner({
      readArtifact: async () => "### Step 1: stale authored step",
      writeSteps: async (_task, steps) => { writes.push(steps); },
      getLiveTask: async () => task(liveSteps),
      audit: (reason) => audits.push(reason),
    });

    await expect(runner.run(
      node({ artifact: "PROMPT.md", parser: "step-headings", preserveRemediationSteps: true }),
      { task: task(), context: {} },
    )).resolves.toMatchObject({ outcome: "success", value: "preserved-remediation-steps" });
    expect(writes).toEqual([]);
    expect(audits).toContain("preserved-remediation-steps");
  });

  it("audits but never filters implementation names containing gate words", async () => {
    const writes: TaskStep[][] = [];
    const audits: string[] = [];
    const runner = new ParseStepsNodeRunner({
      readArtifact: async () => "### Step 1: Wire documentation link resolver\n### Step 2: Testing & Verification",
      writeSteps: async (_task, steps) => { writes.push(steps); },
      audit: (reason) => audits.push(reason),
    });
    await runner.run(node({ artifact: "PROMPT.md", parser: "step-headings", implementationOnlySteps: true }), { task: task(), context: {} });
    expect(writes).toEqual([[{ name: "Wire documentation link resolver", status: "pending" }, { name: "Testing & Verification", status: "pending" }]]);
    expect(audits).toContain("implementation-only-leakage");
  });

  /*
  FNXC:PlanningDocumentationStep 2026-08-26-05:56:
  A planned `Testing & Verification` step is the INTENDED plan on these workflows — the executor owns
  testing because a readonly reviewer cannot run commands. Auditing it as review-gate leakage made
  every card report a problem with its own correct plan, which is how a signal stops being read.
  */
  it("does not report leakage for the testing step the planner is meant to emit", async () => {
    const writes: TaskStep[][] = [];
    const audits: string[] = [];
    const runner = new ParseStepsNodeRunner({
      readArtifact: async () => "### Step 1: Add the retry guard\n### Step 2: Testing & Verification",
      writeSteps: async (_task, steps) => { writes.push(steps); },
      audit: (reason) => audits.push(reason),
    });
    await runner.run(node({ artifact: "PROMPT.md", parser: "step-headings", implementationOnlySteps: true }), { task: task(), context: {} });
    expect(writes[0]?.map((step) => step.name)).toEqual(["Add the retry guard", "Testing & Verification"]);
    expect(audits).not.toContain("implementation-only-leakage");
  });
});

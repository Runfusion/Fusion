import { describe, expect, it } from "vitest";
import {
  formatRemediationStepName,
  hasOpenEquivalentRemediationStep,
  remediationWaveCount,
  type Task,
  type TaskStep,
} from "../index.js";
import { appendRemediationStepsImpl } from "../task-store/remediation-step-ops.js";

const remediation = (detail: string, status: TaskStep["status"] = "pending", wave = 1): TaskStep => ({
  name: formatRemediationStepName({ detail }),
  status,
  remediation: { wave, gate: "Code Review", gateStepId: "code-review", filePath: "src/example.ts", detail },
});

function fakeStore(steps: TaskStep[]) {
  const task = { id: "FN-175", steps } as Task;
  return {
    task,
    store: {
      async updateTaskAtomic(_id: string, update: (current: Task) => { steps?: TaskStep[] } | null) {
        const patch = await update(task);
        if (patch?.steps) task.steps = patch.steps;
        return task;
      },
    },
  };
}

describe("review remediation steps", () => {
  it("appends without rewriting the existing prefix", async () => {
    const prefix = [{ name: "Implementation", status: "done" as const, dependsOn: [] }];
    const { store, task } = fakeStore(prefix);
    const result = await appendRemediationStepsImpl(store as never, task.id, [remediation("missing undefined case")]);
    expect(task.steps.slice(0, prefix.length)).toEqual(prefix);
    expect(result).toMatchObject({ appendedCount: 1, wave: 1, insertionIndex: 1, verificationStepIndex: 2 });
    expect(result.appended).toHaveLength(1);
    expect(task.steps.at(-1)).toEqual({ name: "Testing & Verification", status: "pending" });
  });

  it("keeps completed verification history and reports only the appended fix", async () => {
    const originalVerification = { name: "Testing & Verification", status: "done" as const };
    const { store, task } = fakeStore([
      { name: "Implement", status: "done" },
      originalVerification,
    ]);
    const result = await appendRemediationStepsImpl(store as never, task.id, [remediation("missing undefined case")]);

    expect(task.steps.map((entry) => [entry.name, entry.status])).toEqual([
      ["Implement", "done"],
      ["Testing & Verification", "done"],
      ["Fix: missing undefined case", "pending"],
      ["Testing & Verification", "pending"],
    ]);
    expect(task.steps[1]).toBe(originalVerification);
    expect(result).toMatchObject({
      appendedCount: 1,
      insertionIndex: 2,
      verificationStepIndex: 3,
    });
    expect(result.appended.map((entry) => entry.name)).toEqual(["Fix: missing undefined case"]);
  });

  it("deduplicates only open equivalent remediation", async () => {
    const { store, task } = fakeStore([remediation("missing undefined case")]);
    expect((await appendRemediationStepsImpl(store as never, task.id, [remediation("missing undefined case")])).appendedCount).toBe(0);
    task.steps[0]!.status = "done";
    expect((await appendRemediationStepsImpl(store as never, task.id, [remediation("missing undefined case")])).appendedCount).toBe(1);
  });

  it("counts durable waves and formats collision-free names", () => {
    expect(remediationWaveCount([])).toBe(0);
    expect(remediationWaveCount([remediation("one", "done", 1), remediation("three", "pending", 3)])).toBe(3);
    for (const detail of ["inverted condition", "undefined case", "resolver error"]) {
      const name = formatRemediationStepName({ detail });
      expect(name).toMatch(/^Fix: /);
      expect(name).not.toMatch(/(^|[^a-z])(testing|verification|documentation|delivery)([^a-z]|$)/i);
      expect(name).not.toMatch(/test|verif|qa|review/i);
    }
  });

  it("prefers finding titles while retaining legacy name fallbacks", () => {
    expect(formatRemediationStepName({ title: "Short headline", detail: "Long reviewer explanation", name: "Legacy label" }))
      .toBe("Fix: Short headline");
    expect(formatRemediationStepName({ title: " \n\t ", detail: "Long reviewer explanation" }))
      .toBe("Fix: Long reviewer explanation");
    expect(formatRemediationStepName({ name: "Legacy label" })).toBe("Fix: Legacy label");
    expect(formatRemediationStepName({})).toBe("Fix: review finding");

    const multiLine = formatRemediationStepName({ title: "Short\n  headline\tfor operators" });
    expect(multiLine).toBe("Fix: Short headline for operators");
    expect(multiLine).not.toContain("\n");
  });

  it("recognizes open equivalence structurally", () => {
    const existing = remediation("missing undefined case");
    expect(hasOpenEquivalentRemediationStep([existing], remediation("missing undefined case"))).toBe(true);
    existing.status = "done";
    expect(hasOpenEquivalentRemediationStep([existing], remediation("missing undefined case"))).toBe(false);
  });
});

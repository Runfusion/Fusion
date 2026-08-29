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
    expect(result).toMatchObject({ appendedCount: 1, wave: 1 });
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

  it("recognizes open equivalence structurally", () => {
    const existing = remediation("missing undefined case");
    expect(hasOpenEquivalentRemediationStep([existing], remediation("missing undefined case"))).toBe(true);
    existing.status = "done";
    expect(hasOpenEquivalentRemediationStep([existing], remediation("missing undefined case"))).toBe(false);
  });
});

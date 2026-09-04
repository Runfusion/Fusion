import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStep } from "@fusion/core";
import { hasOpenEquivalentRemediationStep, planRemediationPlacement } from "@fusion/core";
import { deriveRemediationSteps } from "../executor/derive-remediation-steps.js";
import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";

describe("deriveRemediationSteps", () => {
  const base = { gateStepId: "code-review", wave: 1, prompt: "## File Scope\n- `src/**`", changedFiles: [] } as const;

  it("turns each blocking code-review finding into title-labelled provenance-backed work", () => {
    const body = [
      "Reverse the guard before the retry executes.",
      "The current condition lets invalid retries proceed.",
    ].join("\n");
    const result = deriveRemediationSteps({
      ...base,
      gate: "Code Review",
      findings: [{ id: "finding-1", title: "wrong guard", body, filePath: "src/guard.ts", line: 8, severity: "critical" }],
    });
    expect(result.steps).toEqual([expect.objectContaining({
      name: "Fix: wrong guard",
      status: "pending",
      remediation: expect.objectContaining({
        gate: "Code Review",
        findingId: "finding-1",
        filePath: "src/guard.ts",
        line: 8,
        detail: body,
      }),
    })]);
    expect(result.steps[0]!.name).not.toContain("Reverse the guard");
    expect(result.steps[0]!.name).not.toContain("\n");
    expect(result.steps[0]!.name).not.toMatch(/test|verif|qa|review/i);
  });

  it("falls back to the body for a legacy code-review finding with a blank title", () => {
    const result = deriveRemediationSteps({
      ...base,
      gate: "Code Review",
      findings: [{ id: "legacy", title: " \n\t", body: "Preserve the fallback detail", filePath: "src/legacy.ts", severity: "critical" }],
    });

    expect(result.steps[0]).toMatchObject({
      name: "Fix: Preserve the fallback detail",
      remediation: { detail: "Preserve the fallback detail" },
    });
  });

  it("deduplicates code-review findings by durable body rather than title", () => {
    const result = deriveRemediationSteps({
      ...base,
      gate: "Code Review",
      findings: [
        { id: "same-1", title: "first headline", body: "Same durable finding body", filePath: "src/guard.ts", severity: "critical" },
        { id: "same-2", title: "second headline", body: "Same durable finding body", filePath: "src/guard.ts", severity: "critical" },
      ],
    });

    expect(result.steps.map((step) => step.name)).toEqual(["Fix: first headline", "Fix: second headline"]);
    expect(hasOpenEquivalentRemediationStep([result.steps[0]!], result.steps[1]!)).toBe(true);
  });

  it("uses titles for findings inside a confirmed workspace repository", () => {
    const result = deriveRemediationSteps({
      ...base,
      gate: "Code Review",
      prompt: "## File Scope\n- `repo-b/**`",
      confirmedRepositories: ["repo-a"],
      findings: [{ id: "workspace", title: "workspace guard", body: "Repair the workspace guard", filePath: "repo-a/src/x.ts", severity: "critical" }],
    });

    expect(result).toMatchObject({ outOfScope: [] });
    expect(result.steps[0]).toMatchObject({
      name: "Fix: workspace guard",
      remediation: { detail: "Repair the workspace guard", filePath: "repo-a/src/x.ts" },
    });
  });

  it("does not create work for non-blocking or out-of-scope findings", () => {
    const nonBlocking = deriveRemediationSteps({
      ...base, gate: "Code Review",
      findings: [{ id: "note", title: "note", body: "note", filePath: "src/a.ts", severity: "medium" }],
    });
    expect(nonBlocking.steps).toEqual([]);

    const upstream = deriveRemediationSteps({
      ...base, gate: "Code Review",
      findings: [{ id: "upstream", title: "upstream", body: "outside", filePath: "other/a.ts", severity: "critical" }],
    });
    expect(upstream).toMatchObject({ steps: [], reason: "upstream-out-of-scope" });
    expect(upstream.outOfScope).toEqual([{ filePath: "other/a.ts", detail: "outside" }]);
  });

  it("derives distinct verification files and a fallback when output has none", () => {
    const files = deriveRemediationSteps({ ...base, gate: "Verification", gateStepId: "verification", verificationCommandLabel: "testCommand", verificationOutput: "src/a.ts:3 failed\nsrc/b.ts:6 failed" });
    expect(files.steps.map((step) => step.remediation?.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
    const fallback = deriveRemediationSteps({ ...base, gate: "Verification", gateStepId: "verification", verificationCommandLabel: "buildCommand", verificationOutput: "failed" });
    expect(fallback.steps).toHaveLength(1);
    expect(fallback.steps[0].name).toBe("Fix: Fix failing buildCommand");
  });
});

describe("review remediation release and fallback policy", () => {
  function subject(overrides: Partial<Task> = {}): Task {
    return {
      id: "FN-217-release",
      column: "in-review",
      status: null,
      paused: false,
      prompt: "## File Scope\n- `src/**`\n",
      modifiedFiles: [],
      steps: [],
      ...overrides,
    } as Task;
  }

  function storeFor(task: Task, append?: readonly TaskStep[]) {
    const logEntry = vi.fn(async () => undefined);
    return {
      logEntry,
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      getTask: vi.fn(async () => task),
      appendRemediationSteps: vi.fn(async (_id: string, candidates: readonly TaskStep[], options: { wave: number }) => {
        const appended = [...(append ?? candidates)];
        const placement = planRemediationPlacement(task.steps ?? [], appended);
        task.steps = placement.steps;
        return { task, appended, appendedCount: appended.length, wave: options.wave, ...placement };
      }),
      updateTaskAtomic: vi.fn(async (_id: string, callback: (current: Task) => Partial<Task> | null) => {
        const patch = callback(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };
  }

  async function append(task: Task, store: ReturnType<typeof storeFor>, findings: any[] = []) {
    const outcome = await appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix: vi.fn(async () => undefined) },
      task,
      { stepName: "Code Review", feedback: "advisory", phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", findings },
    );
    expect(task).toMatchObject({ status: null, paused: false });
    expect(task).not.toHaveProperty("awaitingApprovalReason");
    return outcome;
  }

  it("appends a fourth remediation wave when actionable evidence remains", async () => {
    const task = subject({ worktree: "/tmp/fn-236-wave-4", steps: [{ name: "prior", status: "done", remediation: { wave: 3, gate: "Code Review", gateStepId: "code-review", detail: "prior" } }] });
    const store = storeFor(task);
    await expect(append(task, store, [{ id: "wave-4", title: "guard", body: "fix guard", filePath: "src/a.ts", severity: "critical" }]))
      .resolves.toBe("appended");
    expect(task.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({ wave: 4 }),
    }));
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("keeps wave as provenance beyond ten remediation passes", async () => {
    const task = subject({ worktree: "/tmp/fn-236-wave-11", steps: [{ name: "prior", status: "done", remediation: { wave: 10, gate: "Code Review", gateStepId: "code-review", detail: "prior" } }] });
    const store = storeFor(task);
    await expect(append(task, store, [{ id: "wave-11", title: "guard", body: "fix another guard", filePath: "src/b.ts", severity: "critical" }]))
      .resolves.toBe("appended");
    expect(task.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({ wave: 11 }),
    }));
  });

  it("turns an out-of-scope Code Review finding into a repairable fallback step", async () => {
    const task = subject({ worktree: "/tmp/fn-267-outside" });
    const store = storeFor(task);
    await expect(append(task, store, [{ id: "outside", title: "outside", body: "fix outside", filePath: "other/a.ts", severity: "critical" }]))
      .resolves.toBe("appended");
    expect(task.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({
        gate: "Code Review",
        findingId: "missing-code-review-fix-steps",
        detail: expect.stringContaining("without usable file-scoped Fix steps"),
      }),
    }));
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("turns a finding-less Code Review REVISE into a repairable fallback step", async () => {
    const task = subject({ worktree: "/tmp/fn-267-missing" });
    const store = storeFor(task);
    await expect(append(task, store)).resolves.toBe("appended");
    expect(task.steps).toContainEqual(expect.objectContaining({
      name: "Fix: Turn Code Review feedback into actionable fixes",
      status: "pending",
      remediation: expect.objectContaining({
        gate: "Code Review",
        findingId: "missing-code-review-fix-steps",
      }),
    }));
  });

  it("releases duplicate-only remediation with no pending work", async () => {
    const task = subject({
      steps: [{
        name: "Fix: fix guard",
        status: "done",
        remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", findingId: "same", filePath: "src/a.ts", detail: "fix guard" },
      }],
    });
    const store = storeFor(task, []);
    await expect(append(task, store, [{ id: "same", title: "guard", body: "fix guard", filePath: "src/a.ts", severity: "critical" }]))
      .resolves.toBe("released-no-pending-work");
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Review remediation released as non-blocking", "review-remediation-no-pending-work");
  });

  it("releases a workspace remediation whose checkout is missing", async () => {
    const task = subject({
      repositoryScope: { state: "confirmed", revision: 1, repositories: ["Merge"] } as never,
      workspaceWorktrees: { Merge: {} } as never,
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        verdict: "REVISE",
        repositoryScopeRevision: 1,
        repositoryReviewOutcomes: [{
          repository: "Merge",
          status: "REVIEWED",
          verdict: "REVISE",
          fingerprint: "tree-1",
          findings: [{ id: "workspace", title: "guard", body: "fix guard", filePath: "src/a.ts", severity: "critical" }],
        }],
      }] as never,
    });
    const store = storeFor(task);
    await expect(append(task, store, [{ id: "workspace", title: "guard", body: "fix guard", filePath: "src/a.ts", severity: "critical" }]))
      .resolves.toBe("released-workspace-worktree-missing");
    expect(store.logEntry).toHaveBeenCalledWith(task.id, "Review remediation released as non-blocking", "review-remediation-workspace-worktree-missing");
  });
});

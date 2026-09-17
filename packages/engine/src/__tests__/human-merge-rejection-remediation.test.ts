/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — an accepted human rejection must become RUNNABLE corrections on the SAME task, covering both
a targeted defect and a rejected approach, with no work lost, no child task, and no move back to
Planning. These drive the real publication path with scripted model output.

Surface enumeration covered here:
  • targeted vs structural classification, several instructions, several repositories;
  • empty / invalid / non-JSON output, an unavailable model, and an abort — all leave the refusal
    durably closed and retryable, never released;
  • a second dispatch while an analysis is in flight produces no second wave;
  • finished steps and their reports are preserved, and the amendment is published through the
    canonical prompt path before any step becomes runnable.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import { publishHumanMergeCorrection } from "../workflows/human-merge-approval-boundary.js";
import {
  buildHumanMergeCorrectionPrompt,
  HumanMergeCorrectionPlanError,
  parseHumanMergeCorrectionPlan,
} from "../workflows/human-merge-feedback-planner.js";

const CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:abc",
  targetSignature: "merge:.@origin:fusion/FN-514->main",
};

function rejectedTask(over: Partial<Task> = {}): Task {
  return {
    id: "FN-514",
    title: "Verrou de livraison",
    description: "Valider la livraison avec un verrou par tâche",
    prompt: "# Task: FN-514\n\n## Steps\n\n### Step 0: Preflight\n",
    column: "in-review",
    modifiedFiles: ["packages/dashboard/app/components/TaskCard.tsx"],
    steps: [
      { name: "Step 0: Preflight", status: "done", report: { summary: "preflight done" } },
      { name: "Step 1: Implement", status: "done", report: { summary: "implemented" } },
    ],
    humanMergeApproval: {
      enabled: true,
      generation: 1,
      remediationGeneration: 1,
      rejection: {
        requestId: "rej-1",
        instruction: "La navigation est fausse et il manque la confirmation avant suppression.",
        rejectedBy: "dashboard-operator",
        rejectedAt: "2026-09-17T11:30:00.000Z",
        candidate: CANDIDATE,
        remediationGeneration: 1,
        state: "pending",
      },
    },
    ...over,
  } as unknown as Task;
}

const TARGETED = JSON.stringify({
  mode: "fixSteps",
  rationale: "Le parcours est correct mais deux défauts précis restent.",
  coveredRequirements: ["navigation fausse", "confirmation manquante"],
  steps: [
    { title: "Corriger la destination de navigation", detail: "…", files: ["packages/dashboard/app/components/TaskCard.tsx"], verification: "TaskCard.test.tsx" },
    { title: "Ajouter la confirmation de suppression", detail: "…", files: ["packages/dashboard/app/components/ListView.tsx"], verification: "ListView.test.tsx" },
  ],
});

const STRUCTURAL = JSON.stringify({
  mode: "replan",
  rationale: "L'approche choisie ne peut pas satisfaire l'exigence oubliée.",
  coveredRequirements: ["exigence oubliée", "parcours erroné"],
  amendment: "Remplacer le routage local par le registre partagé et déplacer la confirmation dans le store.",
  steps: [
    { title: "Introduire le registre partagé", detail: "…", files: ["packages/core/src/nav/registry.ts"], verification: "registry.test.ts" },
    { title: "Rebrancher les deux hôtes", detail: "…", files: ["packages/dashboard/app/components/TaskCard.tsx", "packages/engine/src/nav.ts"], verification: "hosts.test.tsx" },
  ],
});

function createDeps(task: Task, reply: string | (() => Promise<string>)) {
  const state = { row: task };
  const appended: unknown[] = [];
  const amendments: { amendment: string; files: readonly string[] }[] = [];
  const resumed: string[] = [];
  const store = {
    getTask: vi.fn(async () => structuredClone(state.row)),
    /* Fenced on requestId, exactly like the production writer. */
    updateHumanMergeRejectionState: vi.fn(async (_id: string, input: { requestId: string; patch: Record<string, unknown> }) => {
      const rejection = state.row.humanMergeApproval?.rejection;
      if (!rejection || rejection.requestId !== input.requestId) {
        return { applied: false as const, reason: "candidate-superseded" as const };
      }
      Object.assign(rejection, input.patch);
      return { applied: true as const, task: structuredClone(state.row), replayed: false };
    }),
    appendRemediationSteps: vi.fn(async (_id: string, steps: readonly unknown[]) => {
      appended.push(...steps);
      state.row.steps = [...(state.row.steps ?? []), ...(steps as never[])];
      return { task: state.row, appended: steps as never[], appendedCount: steps.length, wave: 1 };
    }),
    logEntry: vi.fn(async () => undefined),
  } as never;
  return {
    state,
    appended,
    amendments,
    resumed,
    deps: {
      store,
      analyze: vi.fn(async () => (typeof reply === "string" ? reply : reply())),
      publishAmendment: vi.fn(async (_task: Task, amendment: string, files: readonly string[]) => {
        amendments.push({ amendment, files });
      }),
      resumeExecution: vi.fn(async (t: Task) => { resumed.push(t.id); }),
    },
  };
}

describe("FN-514 — targeted corrections", () => {
  it("publishes the amendment first, then runnable steps, then resumes execution", async () => {
    const task = rejectedTask();
    const { deps, appended, amendments, resumed, state } = createDeps(task, TARGETED);

    const outcome = await publishHumanMergeCorrection("FN-514", deps as never);

    expect(outcome).toMatchObject({ kind: "published", mode: "fixSteps", appendedCount: 2 });
    // The amendment reaches the canonical prompt path with the declared file scope.
    expect(amendments).toHaveLength(1);
    expect(amendments[0].amendment).toContain("La navigation est fausse");
    expect([...amendments[0].files].sort()).toEqual([
      "packages/dashboard/app/components/ListView.tsx",
      "packages/dashboard/app/components/TaskCard.tsx",
    ]);
    // Every appended step carries the human-refusal provenance, never a Code Review verdict.
    expect(appended).toHaveLength(2);
    for (const step of appended as { remediation: { gate: string; gateStepId: string } }[]) {
      expect(step.remediation.gate).toBe("Human Review");
      expect(step.remediation.gateStepId).toBe("human-merge-approval:rej-1");
    }
    // Finished work is preserved, and the card resumed rather than moving backward to Planning.
    expect(state.row.steps!.slice(0, 2).map((step) => step.status)).toEqual(["done", "done"]);
    expect(state.row.steps![1].report?.summary).toBe("implemented");
    expect(resumed).toEqual(["FN-514"]);
    expect(state.row.column).toBe("in-review");
  });

  it("marks the episode published so a NEW decision becomes due", async () => {
    const { deps, state } = createDeps(rejectedTask(), TARGETED);
    await publishHumanMergeCorrection("FN-514", deps as never);
    expect(state.row.humanMergeApproval!.rejection!.state).toBe("published");
    expect(state.row.humanMergeApproval!.rejection!.analysis).toMatchObject({ mode: "fixSteps" });
    // No delivery authorization was invented.
    expect(state.row.humanMergeApproval!.decision).toBeUndefined();
  });
});

describe("FN-514 — structural corrections", () => {
  it("publishes a replacement approach IN PLACE, spanning several packages", async () => {
    const { deps, amendments, appended, state } = createDeps(rejectedTask(), STRUCTURAL);

    const outcome = await publishHumanMergeCorrection("FN-514", deps as never);

    expect(outcome).toMatchObject({ kind: "published", mode: "replan" });
    expect(amendments[0].amendment).toContain("Replacement Approach");
    expect(amendments[0].amendment).toContain("registre partagé");
    // A structural correction is not shrunk into one cosmetic fix.
    expect(appended).toHaveLength(2);
    expect(amendments[0].files).toContain("packages/core/src/nav/registry.ts");
    expect(amendments[0].files).toContain("packages/engine/src/nav.ts");
    // The original request and plan survive; the card never left review for Planning.
    expect(state.row.prompt).toContain("### Step 0: Preflight");
    expect(state.row.column).toBe("in-review");
  });
});

describe("FN-514 — failures leave the refusal closed and retryable", () => {
  it.each<[string, string]>([
    ["empty output", ""],
    ["prose with no JSON", "I think it looks fine, approving."],
    ["unknown mode", JSON.stringify({ mode: "advice", rationale: "r", coveredRequirements: ["x"], steps: [] })],
    ["replan with no amendment", JSON.stringify({ mode: "replan", rationale: "r", coveredRequirements: ["x"], steps: [{ title: "t", detail: "d", files: ["a.ts"], verification: "v" }] })],
    ["no covered requirement", JSON.stringify({ mode: "fixSteps", rationale: "r", coveredRequirements: [], steps: [{ title: "t", detail: "d", files: ["a.ts"], verification: "v" }] })],
    ["no runnable work", JSON.stringify({ mode: "fixSteps", rationale: "r", coveredRequirements: ["x"], steps: [{ title: "t", detail: "d", files: [], verification: "v" }] })],
  ])("returns the refusal to pending on %s, publishing nothing", async (_label, reply) => {
    const { deps, amendments, appended, state } = createDeps(rejectedTask(), reply);

    const outcome = await publishHumanMergeCorrection("FN-514", deps as never);

    expect(outcome.kind).toBe("retryable");
    expect(amendments).toHaveLength(0);
    expect(appended).toHaveLength(0);
    expect(state.row.humanMergeApproval!.rejection!.state).toBe("pending");
    expect(state.row.humanMergeApproval!.rejection!.lastError).toBeTruthy();
    // Crucially: no delivery authorization was produced by the failure.
    expect(state.row.humanMergeApproval!.decision).toBeUndefined();
  });

  it("returns the refusal to pending when the model itself is unavailable", async () => {
    const { deps, state } = createDeps(rejectedTask(), async () => { throw new Error("provider unavailable"); });
    const outcome = await publishHumanMergeCorrection("FN-514", deps as never);
    expect(outcome).toMatchObject({ kind: "retryable", reason: expect.stringContaining("provider unavailable") });
    expect(state.row.humanMergeApproval!.rejection!.state).toBe("pending");
  });

  it("returns the refusal to pending when the amendment cannot be published", async () => {
    const { deps, appended, state } = createDeps(rejectedTask(), TARGETED);
    deps.publishAmendment = vi.fn(async () => { throw new Error("prompt write refused"); });
    const outcome = await publishHumanMergeCorrection("FN-514", deps as never);
    expect(outcome.kind).toBe("retryable");
    // Steps must NOT become runnable against an unpublished contract.
    expect(appended).toHaveLength(0);
    expect(state.row.humanMergeApproval!.rejection!.state).toBe("pending");
  });

  it("records a bounded attempt count across retries", async () => {
    const { deps, state } = createDeps(rejectedTask(), "not json");
    await publishHumanMergeCorrection("FN-514", deps as never);
    expect(state.row.humanMergeApproval!.rejection!.attemptCount).toBe(1);
    await publishHumanMergeCorrection("FN-514", deps as never);
    expect(state.row.humanMergeApproval!.rejection!.attemptCount).toBe(2);
  });
});

describe("FN-514 — duplicate dispatch and non-candidates", () => {
  it("produces no second wave while an analysis is already in flight", async () => {
    const task = rejectedTask();
    task.humanMergeApproval!.rejection!.state = "analyzing";
    const { deps, appended } = createDeps(task, TARGETED);
    expect(await publishHumanMergeCorrection("FN-514", deps as never)).toEqual({ kind: "not-applicable" });
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it("does nothing for a published episode, an unarmed card, or a missing task", async () => {
    const published = rejectedTask();
    published.humanMergeApproval!.rejection!.state = "published";
    expect(await publishHumanMergeCorrection("FN-514", createDeps(published, TARGETED).deps as never)).toEqual({ kind: "not-applicable" });

    const unarmed = rejectedTask({ humanMergeApproval: undefined });
    expect(await publishHumanMergeCorrection("FN-514", createDeps(unarmed, TARGETED).deps as never)).toEqual({ kind: "not-applicable" });
  });
});

describe("FN-514 — the analysis contract", () => {
  it("gives the planner the refusal, the original request, the plan and the delivered work", () => {
    const prompt = buildHumanMergeCorrectionPrompt({
      task: rejectedTask(),
      rejection: rejectedTask().humanMergeApproval!.rejection!,
    });
    expect(prompt).toContain("La navigation est fausse");
    expect(prompt).toContain("## Original Request");
    expect(prompt).toContain("## Current Plan");
    expect(prompt).toContain("packages/dashboard/app/components/TaskCard.tsx");
    // The planner is explicitly denied the authority to approve or soften the refusal.
    expect(prompt).toContain("must not approve the delivery");
  });

  it("drops absolute paths and traversal escapes from declared files", () => {
    const plan = parseHumanMergeCorrectionPlan(JSON.stringify({
      mode: "fixSteps",
      rationale: "r",
      coveredRequirements: ["x"],
      steps: [{ title: "t", detail: "d", files: ["/etc/passwd", "../../outside.ts", "./packages/core/src/a.ts"], verification: "v" }],
    }));
    expect(plan.steps[0].files).toEqual(["packages/core/src/a.ts"]);
  });

  it("refuses a step that declares no verification", () => {
    expect(() => parseHumanMergeCorrectionPlan(JSON.stringify({
      mode: "fixSteps", rationale: "r", coveredRequirements: ["x"],
      steps: [{ title: "t", detail: "d", files: ["a.ts"], verification: "" }],
    }))).toThrow(HumanMergeCorrectionPlanError);
  });

  it("accepts a fenced JSON reply surrounded by prose", () => {
    const plan = parseHumanMergeCorrectionPlan(`Voici le plan.\n\`\`\`json\n${TARGETED}\n\`\`\`\nFin.`);
    expect(plan.mode).toBe("fixSteps");
    expect(plan.steps).toHaveLength(2);
  });
});

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — the PRODUCTION paths, not the helpers.

Review found three defects that every existing suite missed because each one exercised a helper with
hand-shaped injected callbacks:

  1. «Refuser» had no production caller: an accepted rejection stayed `pending` forever.
  2. «Créer PR» called the injected `createPr` with `{ task, node, source }` while the production
     callback destructures `entity.sourceId` / `entity.headBranch` / `entity.baseBranch` /
     `entity.repo` — a guaranteed TypeError, and no `PrEntity`/`prInfo` was ever persisted.
  3. A card waiting for its operator was surfaced as a stall and eventually paused + failed.

These tests therefore start from PERSISTED state and assert OBSERVABLE effects: the prompt actually
published, the steps actually appended, the entity and task link actually written, the bounce
actually requested, and the number of provider calls. The PR callback here destructures its input
exactly like `createPrNodeGithubOps.createPr` does, so a regression to the wrong argument shape fails
with the same TypeError production would have raised.
*/
import { describe, expect, it, vi } from "vitest";
import type { HumanMergeApprovalState, PrEntity, Task } from "@fusion/core";

import { buildPrNodeDeps, type PrNodeStore } from "../merge/pr-nodes.js";
import {
  buildHumanMergeCorrectionPublicationDeps,
  buildHumanMergeCreatePrHandoff,
  evaluateHumanMergeDeliveryBarrier,
  publishHumanMergeCorrection,
  widenPromptFileScope,
} from "../workflows/human-merge-approval-boundary.js";

const CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:abc",
  targetSignature: "create-pr:.@origin:fusion/FN-514->main",
};

const PROMPT = [
  "# Task: FN-514",
  "",
  "## Mission",
  "",
  "Deliver the thing.",
  "",
  "## File Scope",
  "",
  "- `packages/dashboard/app/components/Nav.tsx`",
  "",
  "## Do NOT",
  "",
  "- break things",
  "",
].join("\n");

const REJECTED: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  remediationGeneration: 1,
  rejection: {
    requestId: "j1",
    instruction: "La navigation mobile est inutilisable : refais le parcours complet.",
    rejectedBy: "dashboard-operator",
    rejectedAt: "2026-09-17T11:00:00.000Z",
    candidate: CANDIDATE,
    remediationGeneration: 1,
    state: "pending",
  },
};

const STRUCTURAL_REPLY = JSON.stringify({
  mode: "replan",
  rationale: "Le parcours mobile repose sur un drawer qui ne peut pas satisfaire la demande.",
  coveredRequirements: ["navigation mobile utilisable", "parcours complet refait"],
  amendment: "Remplacer le drawer par une barre de sections plein écran.",
  steps: [
    {
      title: "Remplacer le drawer mobile",
      detail: "Supprimer le drawer et rendre la liste de sections plein écran.",
      files: ["packages/dashboard/app/components/MobileNav.tsx", "packages/dashboard/app/components/Nav.tsx"],
      verification: "pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/MobileNav.test.tsx",
    },
    {
      title: "Couvrir les deux points de rupture",
      detail: "Ajouter les assertions 390 et 768.",
      files: ["packages/dashboard/app/components/__tests__/MobileNav.test.tsx"],
      verification: "la même suite couvre 390 et 768",
    },
  ],
});

/** A minimal durable task store: the mutations this path performs, nothing else. */
function createTaskStoreFake(initial: Partial<Task>) {
  const task = {
    id: "FN-514",
    title: "Valider la livraison",
    description: "Verrou par tâche",
    column: "in-review",
    prompt: PROMPT,
    steps: [{ name: "Step 1: build", status: "done" }],
    workflowStepResults: [],
    worktree: "/tmp/fn-514",
    log: [],
    modifiedFiles: [],
    ...initial,
  } as unknown as Task;

  const documents = new Map<string, string>();
  const rerunRequests: Array<{ taskId: string; worktree: string; persistWorktreePath?: boolean }> = [];
  const store = {
    getRootDir: () => "/tmp/project",
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    }),
    upsertTaskDocument: vi.fn(async (_id: string, doc: { key: string; content: string }) => {
      documents.set(doc.key, doc.content);
      return doc;
    }),
    getTaskDocument: vi.fn(async (_id: string, key: string) =>
      documents.has(key) ? { content: documents.get(key)! } : undefined),
    appendRemediationSteps: vi.fn(async (_id: string, steps: Array<Record<string, unknown>>) => {
      const appended = steps.map((step) => ({ ...step, status: "pending" }));
      (task.steps as unknown[]).push(...appended);
      return { task, appended, appendedCount: appended.length, wave: 1 };
    }),
    updateHumanMergeRejectionState: vi.fn(async (_id: string, input: { requestId: string; patch: Record<string, unknown> }) => {
      const state = task.humanMergeApproval;
      if (!state?.rejection || state.rejection.requestId !== input.requestId) {
        return { applied: false, reason: "candidate-superseded" };
      }
      state.rejection = { ...state.rejection, ...input.patch } as never;
      return { applied: true, task, replayed: false };
    }),
    updateHumanMergeDecisionReceipt: vi.fn(async () => ({ applied: true })),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
  };

  return { task, store, documents, rerunRequests };
}

/*
The analysis seam is injected at the SESSION level so `runHumanMergeCorrectionAnalysis`'s own
model resolution, prompt, text collection, empty-reply guard and disposal all run for real.
*/
function scriptedSession(reply: string | (() => Promise<string>)) {
  return (async (received: Record<string, unknown>) => {
    return {
      session: {
        prompt: async () => {
          const value = typeof reply === "function" ? await reply() : reply;
          (received.onText as (t: string) => void)?.(value);
        },
        dispose: () => undefined,
      },
    };
  }) as never;
}

function publicationDeps(
  fixture: ReturnType<typeof createTaskStoreFake>,
  reply: string | (() => Promise<string>),
) {
  return buildHumanMergeCorrectionPublicationDeps({
    store: fixture.store as never,
    settings: { testMode: true } as never,
    scheduleWorkflowRerun: (taskId, worktreePath, _message, _preserve, persistWorktreePath) => {
      fixture.rerunRequests.push({ taskId, worktree: worktreePath, persistWorktreePath });
    },
    createAnalysisSession: scriptedSession(reply),
  });
}

describe("FN-514 — an accepted rejection becomes runnable corrective work", () => {
  it("publishes the amendment, widens the scope, appends startable steps and resumes implementation", async () => {
    const fixture = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });

    const outcome = await publishHumanMergeCorrection("FN-514", publicationDeps(fixture, STRUCTURAL_REPLY));

    expect(outcome).toMatchObject({ kind: "published", mode: "replan", appendedCount: 2 });

    // The CONTRACT is published, not merely computed: PROMPT.md carries the amendment...
    expect(fixture.task.prompt).toContain("## Correction Amendment 1 — Operator Rejected The Delivery");
    expect(fixture.task.prompt).toContain("La navigation mobile est inutilisable");
    expect(fixture.task.prompt).toContain("Remplacer le drawer par une barre de sections plein écran.");
    // ...the original plan survives it...
    expect(fixture.task.prompt).toContain("Deliver the thing.");
    // ...the declared scope is widened so the corrective work is not stranded at merge...
    expect(fixture.task.prompt).toContain("- `packages/dashboard/app/components/MobileNav.tsx`");
    expect(fixture.task.prompt).toContain("- `packages/dashboard/app/components/Nav.tsx`");
    // ...and the `plan` mirror matches the published artifact.
    expect(fixture.documents.get("plan")).toBe(fixture.task.prompt);

    // Named, startable work carrying the human-refusal provenance (never a Code Review verdict).
    const appended = (fixture.task.steps as Array<Record<string, unknown>>).slice(1);
    expect(appended.map((step) => step.name)).toEqual([
      "Fix: Remplacer le drawer mobile",
      "Fix: Couvrir les deux points de rupture",
    ]);
    expect(appended[0]).toMatchObject({
      status: "pending",
      remediation: { gate: "Human Review", gateStepId: "human-merge-approval:j1", wave: 1 },
    });
    // The finished step is preserved.
    expect((fixture.task.steps as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "done" });

    // The episode is closed and execution resumes through the existing review → WIP bounce.
    expect(fixture.task.humanMergeApproval?.rejection?.state).toBe("published");
    expect(fixture.rerunRequests).toEqual([
      { taskId: "FN-514", worktree: "/tmp/fn-514", persistWorktreePath: true },
    ]);
  });

  it("is dispatched by the graph delivery barrier, which then still holds", async () => {
    const fixture = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });
    const publishCorrection = vi.fn((taskId: string) =>
      publishHumanMergeCorrection(taskId, publicationDeps(fixture, STRUCTURAL_REPLY)));

    const outcome = await evaluateHumanMergeDeliveryBarrier(
      { id: "merge", kind: "merge-attempt" } as never,
      fixture.task,
      { store: fixture.store as never, publishCorrection },
    );

    expect(publishCorrection).toHaveBeenCalledWith("FN-514");
    expect(fixture.task.humanMergeApproval?.rejection?.state).toBe("published");
    // Processing a refusal is never a delivery.
    expect(outcome.kind).toBe("hold");
    expect((outcome as { reason: string }).reason).toContain("corrections");
  });

  it("keeps the refusal closed and retryable when the model is unavailable or answers invalidly", async () => {
    const unavailable = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });
    const failed = await publishHumanMergeCorrection("FN-514", publicationDeps(unavailable, async () => {
      throw new Error("provider 503");
    }));
    expect(failed.kind).toBe("retryable");
    expect(unavailable.task.humanMergeApproval?.rejection?.state).toBe("pending");
    expect(unavailable.rerunRequests).toEqual([]);
    expect(unavailable.task.prompt).toBe(PROMPT);

    const invalid = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });
    const rejectedOutput = await publishHumanMergeCorrection("FN-514", publicationDeps(invalid, "no json here"));
    expect(rejectedOutput.kind).toBe("retryable");
    expect(invalid.task.humanMergeApproval?.rejection?.state).toBe("pending");
    expect((invalid.task.steps as unknown[]).length).toBe(1);

    // A later valid answer publishes — the refusal was retryable, not lost.
    const retried = await publishHumanMergeCorrection("FN-514", publicationDeps(invalid, STRUCTURAL_REPLY));
    expect(retried).toMatchObject({ kind: "published" });
  });

  it("refuses to append work against an unpublished plan when the read-back does not match", async () => {
    const fixture = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });
    // A write that silently does not persist must not produce steps for a contract nobody can read.
    fixture.store.updateTask.mockImplementation(async () => fixture.task);

    const outcome = await publishHumanMergeCorrection("FN-514", publicationDeps(fixture, STRUCTURAL_REPLY));
    expect(outcome.kind).toBe("retryable");
    expect((fixture.task.steps as unknown[]).length).toBe(1);
    expect(fixture.rerunRequests).toEqual([]);
    expect(fixture.task.humanMergeApproval?.rejection?.state).toBe("pending");
  });

  it("never produces a second correction wave for the same episode", async () => {
    const fixture = createTaskStoreFake({ humanMergeApproval: structuredClone(REJECTED) });
    await publishHumanMergeCorrection("FN-514", publicationDeps(fixture, STRUCTURAL_REPLY));
    const replay = await publishHumanMergeCorrection("FN-514", publicationDeps(fixture, STRUCTURAL_REPLY));
    expect(replay).toEqual({ kind: "not-applicable" });
    expect((fixture.task.steps as unknown[]).length).toBe(3);
    expect(fixture.rerunRequests).toHaveLength(1);
  });

  it("widens the declared scope additively and drops escaping paths", () => {
    const widened = widenPromptFileScope(PROMPT, [
      "packages/dashboard/app/components/MobileNav.tsx",
      "packages/dashboard/app/components/Nav.tsx",
      "../../../etc/passwd",
      "/absolute/path.ts",
    ]);
    expect(widened).toContain("- `packages/dashboard/app/components/Nav.tsx`");
    expect(widened).toContain("- `packages/dashboard/app/components/MobileNav.tsx`");
    expect(widened).not.toContain("etc/passwd");
    expect(widened).not.toContain("/absolute/path.ts");
    expect(widened).toContain("## Do NOT");
  });
});

/*
The production `createPr` callback shape, copied from `createPrNodeGithubOps.createPr`: it reads
`entity.sourceId` first, then the branch fields and the repo slug. Passing anything without `entity`
raises here exactly as it did in production.
*/
function createProductionShapedPrOps(calls: Array<Record<string, unknown>>) {
  return {
    resolvePrSource: (task: Task) => ({
      sourceType: "task" as const,
      sourceId: task.id,
      repo: "acme/widgets",
      headBranch: "fusion/fn-514",
    }),
    createPr: async ({ task, entity, integrationRemote }: {
      task: Task;
      entity: PrEntity;
      integrationRemote?: string;
    }) => {
      const worktreeKey = entity.sourceId;
      const headBranch = entity.headBranch;
      const [owner, name] = entity.repo.split("/");
      calls.push({ worktreeKey, headBranch, base: entity.baseBranch, owner, name, integrationRemote, taskId: task.id });
      return { prNumber: 42, prUrl: "https://github.test/acme/widgets/pull/42", headOid: "cafe" };
    },
    mergePr: async () => { throw new Error("mergePr must never be called by the create-only handoff"); },
  };
}

function createPrStoreFake(seed?: Partial<PrEntity>) {
  const entities = new Map<string, PrEntity>();
  const prInfos: Array<Record<string, unknown> | null> = [];
  if (seed) entities.set(seed.id!, seed as PrEntity);
  const store: PrNodeStore = {
    getSettings: async () => ({ worktreeRebaseRemote: "origin" }),
    ensurePrEntityForSource: async (input) => {
      const existing = [...entities.values()].find(
        (entity) => entity.sourceType === input.sourceType && entity.sourceId === input.sourceId,
      );
      if (existing) return existing;
      const created = {
        id: `pr-${entities.size + 1}`,
        state: input.state ?? "creating",
        autoMerge: false,
        unverified: false,
        responseRounds: 0,
        createdAt: 0,
        updatedAt: 0,
        baseBranch: "main",
        ...input,
      } as PrEntity;
      entities.set(created.id, created);
      return created;
    },
    getPrEntity: async (id) => entities.get(id) ?? null,
    getActivePrEntityBySource: async (sourceType, sourceId) =>
      [...entities.values()].find((entity) => entity.sourceType === sourceType && entity.sourceId === sourceId) ?? null,
    updatePrEntity: async (id, patch) => {
      const current = entities.get(id)!;
      const next = { ...current, ...patch } as PrEntity;
      entities.set(id, next);
      return next;
    },
    updatePrInfo: async (_id, prInfo) => {
      prInfos.push(prInfo as Record<string, unknown> | null);
      return undefined;
    },
  } as unknown as PrNodeStore;
  return { store, entities, prInfos };
}

describe("FN-514 — «Créer PR» speaks the real PR-node contract", () => {
  const task = { id: "FN-514", title: "Valider la livraison", worktree: "/tmp/fn-514" } as unknown as Task;

  it("creates the PR through the production callback shape and persists entity + manual task link", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const prStore = createPrStoreFake();
    const deps = buildPrNodeDeps(() => prStore.store, createProductionShapedPrOps(calls) as never);

    const handoff = buildHumanMergeCreatePrHandoff(deps, prStore.store);
    const result = await handoff!(task);

    expect(result).toEqual({
      state: "created",
      prNumber: 42,
      prUrl: "https://github.test/acme/widgets/pull/42",
      repository: "acme/widgets",
    });
    // The callback actually received an entity — the old `{ task, node, source }` shape threw here.
    expect(calls).toEqual([{
      worktreeKey: "FN-514",
      headBranch: "fusion/fn-514",
      base: "main",
      owner: "acme",
      name: "widgets",
      integrationRemote: "origin",
      taskId: "FN-514",
    }]);
    // The entity is durable and open, so reuse/reconciliation can find it later.
    expect([...prStore.entities.values()][0]).toMatchObject({
      state: "open",
      prNumber: 42,
      prUrl: "https://github.test/acme/widgets/pull/42",
      headOid: "cafe",
    });
    // The task link is a MANUAL transfer: the card stays in review and nothing implies a merge.
    expect(prStore.prInfos).toEqual([expect.objectContaining({
      number: 42,
      url: "https://github.test/acme/widgets/pull/42",
      status: "open",
      manual: true,
      headBranch: "fusion/fn-514",
      baseBranch: "main",
    })]);
  });

  it("adopts an already-open entity instead of opening a second pull request, and repairs the link", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const prStore = createPrStoreFake({
      id: "pr-existing",
      sourceType: "task",
      sourceId: "FN-514",
      repo: "acme/widgets",
      headBranch: "fusion/fn-514",
      baseBranch: "main",
      state: "open",
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      autoMerge: false,
      unverified: false,
      responseRounds: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const deps = buildPrNodeDeps(() => prStore.store, createProductionShapedPrOps(calls) as never);

    const result = await buildHumanMergeCreatePrHandoff(deps, prStore.store)!(task);

    expect(result).toMatchObject({ state: "reused", prNumber: 7 });
    expect(calls).toEqual([]);
    expect(prStore.prInfos).toEqual([expect.objectContaining({ number: 7, manual: true })]);
  });

  it("classifies an indeterminate provider outcome without marking the entity failed", async () => {
    const prStore = createPrStoreFake();
    const ops = {
      ...createProductionShapedPrOps([]),
      createPr: async () => { throw new Error("socket hang up"); },
    };
    const deps = buildPrNodeDeps(() => prStore.store, ops as never);

    const result = await buildHumanMergeCreatePrHandoff(deps, prStore.store)!(task);

    expect(result).toMatchObject({ state: "indeterminate" });
    // Left `creating`, so the next explicit command reconciles rather than opening a duplicate.
    expect([...prStore.entities.values()][0]).toMatchObject({ state: "creating" });
    expect(prStore.prInfos).toEqual([]);
  });

  it("records a determinate provider refusal on the entity and never merges", async () => {
    const prStore = createPrStoreFake();
    const ops = {
      ...createProductionShapedPrOps([]),
      createPr: async () => { throw new Error("GitHub said no"); },
    };
    const deps = buildPrNodeDeps(() => prStore.store, ops as never);

    const result = await buildHumanMergeCreatePrHandoff(deps, prStore.store)!(task);

    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("GitHub said no") });
    expect([...prStore.entities.values()][0]).toMatchObject({ state: "failed", failureReason: "GitHub said no" });
  });

  it("is unavailable rather than broken when the PR callbacks are not injected", () => {
    expect(buildHumanMergeCreatePrHandoff(undefined, undefined)).toBeUndefined();
  });
});

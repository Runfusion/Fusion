/*
FNXC:MissionFeatureSyncLanes 2026-07-30-02:10 (U7 / R3, R12 — unowned drift site):

`reconcileMissionFeatureState` maps a task's lifecycle POSITION onto its mission
feature's roadmap status. It once read literal lifecycle ids, and on a renamed workflow every one of
them silently answers "no", so the function collapses to a permanent `noop`.

WHAT THAT LOOKS LIKE TO AN OPERATOR: a mission roadmap frozen at whatever status it
last held while the tasks underneath it run to completion. Nothing errors, nothing
retries, and the mission view simply stops tracking reality. That is worse than a
wrong status, because a stale roadmap reads as a stable one.

`mission-feature-sync.ts` is in no unit's file list — not in the plan's per-file
census, and not in the drift review's ownership split (self-healing, dashboard,
triage/replan-target, core, executor). Picked up because it is a planning-lane
reader and nobody else has it.

The three mappings, in role terms:
  complete                  -> feature done
  wip or review             -> feature in-progress
  intake or hold            -> feature triaged ("returned to triage")

The function is already async and already takes the store, so this resolves for
real rather than needing the injected-lane pattern the synchronous predicates
required. An unresolvable workflow falls back to the legacy ids — NOT to `noop`: a
mission whose workflow cannot be read should keep tracking on the default
vocabulary rather than go silent, which is the failure being fixed.
*/
import { describe, expect, it, vi } from "vitest";
import type { MissionFeature, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { reconcileMissionFeatureState, resolveFeatureRepairTargets } from "../missions/mission-feature-sync.js";

const DEFAULT_NAMES = {
  intake: "triage", hold: "todo", wip: "in-progress",
  review: "in-review", complete: "done",
};
/* Every role renamed, and no id collides with a legacy literal, so a surviving
   comparison cannot match by luck. */
const RENAMED = {
  intake: "backlog", hold: "drafting", wip: "building",
  review: "checking", complete: "shipped",
};

function ir(n: typeof DEFAULT_NAMES): WorkflowIr {
  return {
    version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
    columns: [
      { id: n.intake, name: "Intake", traits: [{ trait: "intake" }] },
      { id: n.hold, name: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: n.wip, name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      {
        id: n.review, name: "Review",
        traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }],
      },
      { id: n.complete, name: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const task = (column: string): Task => ({
  id: "FN-1", title: "t", description: "", column, status: null, error: null,
  dependencies: [], steps: [], currentStep: 0, log: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Task);

const feature = (status: string): Pick<MissionFeature, "id" | "status" | "lastValidatorStatus"> =>
  ({ id: "feat-1", status, lastValidatorStatus: undefined } as never);

function storeWith(workflowIr: WorkflowIr | null): TaskStore {
  const selection = { workflowId: "wf", stepIds: [] };
  return {
    getTask: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => {
      if (!workflowIr) throw new Error("unresolvable");
      return { ir: workflowIr };
    }),
  } as unknown as TaskStore;
}

const decide = (n: typeof DEFAULT_NAMES, column: string, featureStatus: string, workflowIr: WorkflowIr | null = ir(n)) =>
  reconcileMissionFeatureState(storeWith(workflowIr), task(column), feature(featureStatus));

describe("mission feature reconciliation resolves lifecycle roles", () => {
  for (const [label, n] of [["default", DEFAULT_NAMES], ["renamed", RENAMED]] as const) {
    it(`marks a feature done when its task reaches the ${label} complete column`, async () => {
      const d = await decide(n, n.complete, "in-progress");
      expect(d.kind).toBe("update");
      expect(d.kind === "update" && d.status).toBe("done");
    });

    it(`marks a feature in-progress when its task reaches the ${label} wip column`, async () => {
      const d = await decide(n, n.wip, "triaged");
      expect(d.kind === "update" && d.status).toBe("in-progress");
    });

    it(`marks a feature in-progress when its task reaches the ${label} review column`, async () => {
      const d = await decide(n, n.review, "defined");
      expect(d.kind === "update" && d.status).toBe("in-progress");
    });

    it(`returns a feature to triaged when its task bounces to the ${label} intake column`, async () => {
      const d = await decide(n, n.intake, "in-progress");
      expect(d.kind === "update" && d.status).toBe("triaged");
    });

    it(`returns a feature to triaged when its task bounces to the ${label} hold column`, async () => {
      const d = await decide(n, n.hold, "in-progress");
      expect(d.kind === "update" && d.status).toBe("triaged");
    });
  }

  it("falls back to the legacy vocabulary when the workflow cannot be resolved", async () => {
    /*
    NOT `noop`. A mission whose workflow cannot be read should keep tracking on the
    default vocabulary rather than go silent — going silent is the exact failure this
    conversion fixes, so the unresolvable path must not reproduce it.
    */
    const d = await decide(DEFAULT_NAMES, "in-progress", "triaged", null);
    expect(d.kind === "update" && d.status).toBe("in-progress");
  });
});

/*
FNXC:MissionFeatureSyncLanes 2026-07-30-02:40:
The legacy-id acceptance for the planner-lane branch, and its scoping. Pre-#2515 rows
still resting in `triage`/`todo` must keep returning their feature to `triaged` — but
only when the workflow does not declare that id as some OTHER role, which is the
over-reach greptile caught on #2593.
*/
describe("legacy planner ids are accepted only when orphaned", () => {
  /** A workflow that names its REVIEW lane `triage` — legal, and not a planner lane. */
  const TRIAGE_IS_REVIEW = { ...RENAMED, review: "triage" };

  it("returns the feature to triaged for an ORPHANED legacy `triage` row", async () => {
    // The migration window: the workflow declares no `triage`, so the row is a
    // pre-U11 leftover awaiting re-homing and still means "back to planning".
    const d = await decide(RENAMED, "triage", "in-progress");
    expect(d.kind === "update" && d.status).toBe("triaged");
  });

  it("does NOT return the feature to triaged when `triage` is the workflow's REVIEW lane", async () => {
    /*
    Mapping a review-lane card to `triaged` would walk the roadmap BACKWARDS while the
    task is actually awaiting merge. The review role must win over the legacy id.

    `feature.status: "in-progress"` is load-bearing: the planner-lane branch only
    fires for an in-progress feature, so a `triaged` fixture would fall through to the
    review branch and pass whether or not the acceptance is scoped. My first version
    made exactly that mistake and passed under both implementations — it proved
    nothing until the feature status let the wrong branch win.
    */
    const d = await decide(TRIAGE_IS_REVIEW, "triage", "in-progress");

    // Stays in-progress via the REVIEW role, rather than being walked back to triaged.
    expect(d.kind).toBe("noop");
  });
});

/*
FNXC:MissionFeatureSyncLanes 2026-07-30-05:40 (PR #2602 review — greptile P1):
A per-role legacy fallback must never claim a column the workflow assigned to a
DIFFERENT role. Unguarded, a workflow that omits `hold` but names its REVIEW lane
`todo` got `lane.hold = "todo"`, so a card awaiting merge matched the planner-lane
branch and its feature was walked BACKWARDS from in-progress to triaged.
*/
describe("legacy per-role fallbacks never alias a declared role", () => {
  /** No hold role, and the REVIEW lane is named with the legacy hold id. */
  function holdlessTodoIsReviewIr(): WorkflowIr {
    return {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        // `merge` is what makes this resolve as the REVIEW role — see the note above
        // `todoIsReviewIr` in the sibling suite for why that detail matters.
        { id: "todo", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
        { id: "shipped", name: "Complete", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
  }

  it("does NOT walk an in-progress feature back to triaged for a card in the REVIEW lane", async () => {
    const d = await reconcileMissionFeatureState(
      storeWith(holdlessTodoIsReviewIr()),
      task("todo"),
      feature("in-progress"),
    );

    // The review role governs: the feature stays in-progress rather than regressing.
    expect(d.kind).toBe("noop");
  });

  it("still advances a feature to in-progress from that same REVIEW lane", async () => {
    // The other side, so "always noop" cannot pass for "correctly not a planner lane".
    const d = await reconcileMissionFeatureState(
      storeWith(holdlessTodoIsReviewIr()),
      task("todo"),
      feature("triaged"),
    );

    expect(d.kind === "update" && d.status).toBe("in-progress");
  });
});

/*
FNXC:MissionFeatureSyncLanes 2026-07-30-06:40 (PR #2602 review, second P1 — greptile):
"DECLARED" means the workflow declares a column with that id — NOT that some role
resolved to it. A non-lifecycle column named `todo` (traits mapping to no role) was
invisible to the previous role-only check, so the fallback claimed it as `lane.hold`
and a task resting there had its feature regressed to `triaged`.

I had recorded that as a residual limitation. It was not a limitation, it was an unread
input: the IR is in reach here.
*/
describe("a non-lifecycle column named with a legacy id is not claimed", () => {
  /** No hold role, plus a column literally named `todo` that carries NO lifecycle trait. */
  function holdlessWithInertTodoIr(): WorkflowIr {
    return {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        // Declared, but maps to no role — the case the role-only check could not see.
        { id: "todo", name: "Parking", traits: [] },
        { id: "shipped", name: "Complete", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
  }

  it("does NOT regress an in-progress feature for a task in that inert column", async () => {
    const d = await reconcileMissionFeatureState(
      storeWith(holdlessWithInertTodoIr()),
      task("todo"),
      feature("in-progress"),
    );

    expect(d.kind).toBe("noop");
  });

  it("still treats the workflow's REAL intake column as a planner lane", async () => {
    // The counter-case, so "never a planner lane" cannot pass for "reads the IR".
    const d = await reconcileMissionFeatureState(
      storeWith(holdlessWithInertTodoIr()),
      task("backlog"),
      feature("in-progress"),
    );

    expect(d.kind === "update" && d.status).toBe("triaged");
  });
});

/*
FNXC:MissionValidationRepair 2026-08-10-17:20:
Repair targets retain the exact observed task snapshot. This proves absent links remain repairable
rather than being mistaken for a stale fence, while renamed lifecycle roles retain their meaning.
*/
describe("feature validation repair target resolution", () => {
  const linkedFeature = { id: "F-1", taskId: "FN-1" } as MissionFeature;
  const repairStore = (resolvedTask: Task | undefined, workflowIr: WorkflowIr = ir(DEFAULT_NAMES)) => ({
    ...storeWith(workflowIr),
    getTask: vi.fn(async () => resolvedTask),
  }) as unknown as TaskStore;

  it.each([
    ["planner", DEFAULT_NAMES.intake, "triaged", false, "planner"],
    ["wip", DEFAULT_NAMES.wip, "in-progress", true, "wip"],
    ["review", DEFAULT_NAMES.review, "in-progress", true, "wip"],
  ] as const)("derives %s targets from the linked task lane", async (_label, column, status, resumeImplementation, laneRole) => {
    const source = task(column);
    const result = await resolveFeatureRepairTargets(repairStore(source), linkedFeature);
    expect(result).toMatchObject({ status, resumeImplementation, groundTruth: {
      featureId: "F-1", taskId: "FN-1", taskLiveness: "live", taskColumn: column,
      taskUpdatedAt: source.updatedAt, laneRole,
    } });
  });

  it("uses renamed planner lanes from the same workflow snapshot", async () => {
    const result = await resolveFeatureRepairTargets(repairStore(task(RENAMED.hold), ir(RENAMED)), linkedFeature);
    expect(result).toMatchObject({ status: "triaged", resumeImplementation: false, groundTruth: { laneRole: "planner", taskColumn: RENAMED.hold } });
  });

  it("rejects a completed or custom live lane instead of falsely clearing it to defined", async () => {
    await expect(resolveFeatureRepairTargets(repairStore(task(DEFAULT_NAMES.complete)), linkedFeature))
      .rejects.toThrow("not a planner or active-work lifecycle lane");
  });

  it("fences unlinked, missing, and physically archived task links as absent", async () => {
    const unlinked = await resolveFeatureRepairTargets(repairStore(undefined), { id: "F-0", taskId: undefined });
    const missing = await resolveFeatureRepairTargets(repairStore(undefined), linkedFeature);
    const archived = await resolveFeatureRepairTargets(repairStore({ ...task(DEFAULT_NAMES.wip), deletedAt: "2026-01-02T00:00:00.000Z" }), linkedFeature);
    for (const [result, taskId] of [[unlinked, null], [missing, "FN-1"], [archived, "FN-1"]] as const) {
      expect(result).toMatchObject({ status: "defined", resumeImplementation: false, groundTruth: {
        taskId, taskLiveness: "absent", taskColumn: null, taskUpdatedAt: null, laneRole: "none",
      } });
    }
  });

  it("does not emit an unverifiable absent fence for archived snapshots or renamed archived lanes", async () => {
    const retainedSnapshot = await resolveFeatureRepairTargets(
      repairStore({ ...task(DEFAULT_NAMES.wip), archivedAt: "2026-01-02T00:00:00.000Z" }),
      linkedFeature,
    );
    expect(retainedSnapshot.groundTruth.taskLiveness).toBe("live");
    await expect(resolveFeatureRepairTargets(repairStore(task(RENAMED.archived), ir(RENAMED)), linkedFeature))
      .rejects.toThrow("not a planner or active-work lifecycle lane");
  });
});

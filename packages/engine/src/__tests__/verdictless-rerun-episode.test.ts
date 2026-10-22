import { describe, expect, it, vi } from "vitest";
import {
  getBuiltinWorkflow,
  resolveRequiredPreMergeStepIds,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS,
  openVerdictlessGateRerunEpisode,
  rerouteFailedNoVerdictPreMergeGateToReview,
  rerouteUnrunPreMergeGateToReview,
  VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX,
  verdictlessGateEpisodeResetMarker,
  verdictlessGateRerunLogMarker,
} from "../merge/pre-merge-gate-reseed.js";

/*
FNXC:VerdictlessRerunEpisode 2026-10-22-17:13 (measured on rtm3 2026-10-22, kubernetes board):
RUFU-217's `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS` bounds how many times one crashing review gate may be
re-seened, and RUFU-452 made that count durable. Neither gave the budget an END. Measured on rtm3: 10
of 14 `in-review` kubernetes cards sat with a verdict-less `code-review` row and exactly 3 strikes;
KUBE-142 has carried the same three strikes since 2026-10-21T18:03 while the merge door refuses it
every few minutes. KUBE-190 is the decisive trace — 14:48:26 operator dashboard Retry discarded the
verdict-less row and armed the gate's own node, 14:48:29 wrote `Revision budget reset for 'code-review'
by operator retry` (the FN-1711 *revision* budget, a different counter), 14:48:54 the review node really
ran, 14:49:13 it died verdict-less again — and from that instant no lane could ever re-run the gate
again, because the three strikes the PREVIOUS episode spent still stood. The operator performed the one
action the product offers and the card stayed dead.

The invariant this file pins: the rerun budget is scoped to a review EPISODE. Strikes are counted from
the newest operator-opened episode marker for that gate, so an operator restart re-arms the bounded
window instead of confronting a lifetime ban. It is the same pattern FN-1711 introduced for the sibling
budget in `executor/optional-step-revision.ts` (`OPTIONAL_STEP_REVISION_RESET_MARKER` + `resetIndexFor`).
Equally load-bearing: the boundary is a boundary, not an amnesty — the cap still binds inside the new
episode, only an operator action may open one, and an episode line can never itself be counted as a
strike.
*/

const IR = getBuiltinWorkflow("builtin:coding")!.ir;
const REQUIRED = resolveRequiredPreMergeStepIds(IR, ["plan-review", "code-review"]);
const mergeContent = {
  kind: "singular",
  diff: { state: "fingerprint", fingerprint: "current" },
} as MergeContentDescriptor;

/** A card in the exact measured shape: in review, required `code-review` row `failed` with no verdict. */
function verdictlessTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-707E",
    column: "in-review",
    autoMerge: true,
    paused: false,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [
      // Plan Review approved: the unrun-gate lane seeds the EARLIEST seedable gate in IR order, so a
      // missing plan-review would win and this card's `code-review` budget would never be consulted.
      {
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "passed",
        verdict: "APPROVE",
        reviewKind: "plan",
        startedAt: "2026-10-21T17:01:46.264Z",
        completedAt: "2026-10-21T17:07:07.917Z",
      },
      {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        reviewKind: "code",
        startedAt: "2026-10-21T18:04:31.420Z",
        completedAt: "2026-10-21T18:04:54.842Z",
      },
    ],
    ...overrides,
  } as unknown as Task;
}

/**
 * The counter reads the DURABLE row (RUFU-452), so the fixture states strikes through `durableLog` and
 * never through the caller's task projection.
 */
function store(durableLog: Array<{ action: string }> | null) {
  const selection = { workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] };
  return {
    getTask: vi.fn(async () => (durableLog === null ? null : { log: durableLog })),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: IR }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true })),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore & Record<string, any>;
}

function strikeMarkers(gateId: string, count: number): Array<{ action: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    action: `${verdictlessGateRerunLogMarker(gateId)} verdict-less failure, re-seeded in place for a fresh run`
      + ` (rerun ${index + 1} of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS})`,
  }));
}

function episodeMarker(gateId: string): { action: string } {
  return { action: `${verdictlessGateEpisodeResetMarker(gateId)} verdict-less re-run budget reopened` };
}

const bothLanes = [
  { name: "no-verdict lane", reroute: rerouteFailedNoVerdictPreMergeGateToReview },
  { name: "unrun-gate lane", reroute: rerouteUnrunPreMergeGateToReview },
] as const;

describe("verdict-less pre-merge gate rerun budget is episode-scoped", () => {
  /*
  The pre-fix failure, stated as the assertion that was false: a card whose durable log holds three
  strikes AND a later operator-restart marker was refused with `rerun-budget-exhausted` and seeded
  nothing. This is the KUBE-190 shape after 14:49:13.
  */
  it.each(bothLanes)("re-arms the budget in the $name when an operator restart opened a new episode", async ({ reroute }) => {
    const fake = store([...strikeMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS), episodeMarker("code-review")]);

    await expect(reroute(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({
      rerouted: true, nodeId: "code-review", workflowStepId: "code-review",
      ...(reroute === rerouteUnrunPreMergeGateToReview ? { reason: "verdictless-seeded" } : {}),
    });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    // `rerun 1 of 3` is the proof the tally restarted rather than the cap being widened: ignoring the
    // old strikes would have labelled this `rerun 4 of 3`.
    expect(fake.logEntry).toHaveBeenCalledWith(
      "RUFU-707E",
      expect.stringContaining(`rerun 1 of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS}`),
    );
  });

  it("refuses again once the new episode has itself spent its strikes", async () => {
    const fake = store([
      episodeMarker("code-review"),
      ...strikeMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS),
    ]);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(fake.logEntry).not.toHaveBeenCalled();
  });

  it("counts only the strikes that followed the newest episode marker", async () => {
    const fake = store([
      ...strikeMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS),
      episodeMarker("code-review"),
      ...strikeMarkers("code-review", 1),
    ]);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });
    expect(fake.logEntry).toHaveBeenCalledWith(
      "RUFU-707E",
      expect.stringContaining(`rerun 2 of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS}`),
    );
  });

  it("does not let another gate's episode marker reopen this gate's budget", async () => {
    const fake = store([
      ...strikeMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS),
      episodeMarker("plan-review"),
    ]);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("keeps the cap enforced when no episode marker was ever written", async () => {
    const fake = store(strikeMarkers("code-review", MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS));

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({ rerouted: false, reason: "rerun-budget-exhausted" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  The two markers share a human-readable stem and the tally is a `startsWith` over the strike prefix.
  If an episode line ever began with that prefix, every operator restart would spend a strike — the
  reset would cost the very thing it grants. Asserted as behavior of the marker vocabulary, not as prose.
  */
  it("never counts an episode marker as a strike", () => {
    expect(verdictlessGateEpisodeResetMarker("code-review")
      .startsWith(verdictlessGateRerunLogMarker("code-review"))).toBe(false);
    expect(verdictlessGateRerunLogMarker("code-review")
      .startsWith(VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX)).toBe(false);
  });

  /*
  Only an operator action may open an episode. If a re-seed lane emitted the marker as a side effect of
  seeding, the bounded crash-loop stop would erase itself on every doomed attempt — which is precisely
  the RUFU-449 failure the budget was added for.
  */
  it("writes no episode marker from a re-seed lane, so an automatic pass cannot reopen its own budget", async () => {
    const fake = store([]);

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, verdictlessTask(), {
      requiredPreMergeStepIds: REQUIRED, mergeContent,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded" });

    const written = fake.logEntry.mock.calls.map((call: unknown[]) => String(call[1]));
    expect(written.some((line: string) => line.includes(verdictlessGateRerunLogMarker("code-review")))).toBe(true);
    expect(written.some((line: string) => line.includes(VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX))).toBe(false);
  });

  it("opens exactly one episode marker per named gate", async () => {
    const fake = store([]);

    await expect(openVerdictlessGateRerunEpisode(fake, "RUFU-707E", ["code-review", "plan-review"]))
      .resolves.toEqual(["code-review", "plan-review"]);

    expect(fake.logEntry.mock.calls.map((call: unknown[]) => String(call[1]))).toEqual([
      expect.stringContaining(verdictlessGateEpisodeResetMarker("code-review")),
      expect.stringContaining(verdictlessGateEpisodeResetMarker("plan-review")),
    ]);
  });
});

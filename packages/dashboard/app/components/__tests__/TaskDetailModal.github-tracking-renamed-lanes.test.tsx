/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
GITHUB TRACKING WAS UNREACHABLE ON A RENAMED BOARD.

`canTaskEditGithubTracking` consulted `GITHUB_TRACKING_EDITABLE_COLUMNS` — the hardcoded set
`{triage, todo, in-progress, in-review, ideas}` — with `.has(column)`, and had no resolved branch at
all. On a board whose lanes are renamed it matched nothing, so the helper returned false for EVERY
task and `showGithubTrackingSection` hid the section outright. The operator could not turn tracking on
or off, with no error and no explanation. The only thing keeping it reachable was the unrelated
Ideas-workflow escape hatch.

WHY NO GATE SAW IT. The census counts COMPARISONS against legacy ids; this is a Set literal — a
DEFINITION — consulted via `.has()`. Nothing in the backlog ever pointed here. Same blind spot that
hid `TIME_INDICATOR_COLUMNS` and `BLOCKER_ESCALATION_COLUMNS`.

THE CASES ARE DIFFERENTIAL. `building` and `shipped` collide with no legacy id, so a surviving
`.has(column)` cannot pass by luck, and the `todo` control pins that the default vocabulary is
unaffected. The board payload is the real one the modal fetches, so the flags travel the production
path (`fetchBoardWorkflows` -> `resolveTaskWorkflowMetadata` -> `currentColumnFlags`) rather than
being injected as props.
*/
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import * as api from "../../api";

setupTaskDetailModalHooks();

/** A renamed board: no lane id collides with a legacy one. */
const RENAMED_PAYLOAD = {
  flagEnabled: true,
  defaultWorkflowId: "wf-renamed",
  taskWorkflowIds: {},
  workflows: [
    {
      id: "wf-renamed",
      name: "Renamed",
      columns: [
        { id: "drafting", name: "Drafting", flags: { intake: true, hold: true } },
        { id: "building", name: "Building", flags: { countsTowardWip: true } },
        { id: "shipped", name: "Shipped", flags: { complete: true } },
      ],
    },
  ],
};

/** The default board, as a control — the legacy ids ARE this workflow's ids. */
const DEFAULT_PAYLOAD = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  taskWorkflowIds: {},
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "todo", name: "Todo", flags: { intake: true, hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
};

function renderIn(column: string, payload: unknown) {
  vi.spyOn(api, "fetchBoardWorkflows").mockResolvedValue(payload as never);
  return render(
    <TaskDetailModal
      initialTab="details"
      task={makeTask({ column })}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      onTaskUpdated={vi.fn()}
      addToast={noop}
    />,
  );
}

/*
The section is the observable: `showGithubTrackingSection` is `canEditGithubTracking && ...` for a
task with tracking off, so "can the operator edit this?" and "is the section on screen?" are the same
question here — which is exactly the user-facing symptom.
*/
const trackingSection = () => screen.queryByText("GitHub tracking");

describe("GitHub tracking editability under a renamed board vocabulary", () => {
  /* Control: the default vocabulary offers the section. Passes before and after the fix, so a
     generally broken modal cannot hide behind the renamed case below. */
  it("default vocabulary: a task in `todo` can edit GitHub tracking", async () => {
    renderIn("todo", DEFAULT_PAYLOAD);

    await waitFor(() => expect(trackingSection()).toBeInTheDocument());
  });

  /* The defect: `building` is in no legacy set, so the section vanished entirely. */
  it("renamed vocabulary: a task in the WIP lane can edit GitHub tracking", async () => {
    renderIn("building", RENAMED_PAYLOAD);

    await waitFor(() => expect(trackingSection()).toBeInTheDocument());
  });

  /*
  The paired negative: resolving roles must not hand editability to a FINISHED card. The legacy set
  excluded `done` and the resolved form must exclude its renamed equivalent, or the fix
  trades a missing affordance for one that should not be there.
  */
  it("renamed vocabulary: a task in the COMPLETE lane cannot edit GitHub tracking", async () => {
    renderIn("shipped", RENAMED_PAYLOAD);

    /* Wait for the workflow fetch to land before asserting absence, or this passes vacuously on the
       pre-resolution render — where the flags are undefined and the legacy fallback also says no. */
    await waitFor(() => expect(screen.getByText("Renamed")).toBeInTheDocument());
    expect(trackingSection()).not.toBeInTheDocument();
  });
});

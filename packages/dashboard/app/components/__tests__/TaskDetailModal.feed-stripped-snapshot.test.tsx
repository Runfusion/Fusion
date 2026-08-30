/*
FNXC:TaskActivityFeedFreshness 2026-08-26-12:20:
REPORTED: a task that is done, and demonstrably has journal entries, shows "(no activity)" in Feed.

Two things combine, and either alone is harmless:

1. `stripTaskListHeavyFields` (sse.ts) empties `log` and KEEPS every other field, `prompt` included.
   So an SSE `task:updated` payload for a task that has a spec arrives with `prompt` present and
   `log: []`.
2. The detail mount effect treats `"prompt" in task` as proof the prop is a complete TaskDetail and
   returns WITHOUT requesting the detail. `prompt` and `log` are stripped by different paths, so that
   proxy is false exactly for the payload above.

The card therefore adopts a log-less snapshot as if it were complete, and the only rescue —
`refreshEmptyActivityFeed` — is bound to a segment CHANGE. When Feed is already the active segment
(opening on `initialTab: "logs"`, which is how a deep link and the board's activity affordance land),
nothing ever changes segment, so "(no activity)" is permanent for that visit.

These tests pin the observable outcome, not the internals: entries the server has must reach the Feed
however the card was opened.
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React, { type ComponentProps } from "react";
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

setupTaskDetailModalHooks();

const SERVER_ENTRY = "Step 2 (Testing & Verification) → done";

function renderModal(props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
  return render(
    <TaskDetailModal
      task={makeTask({ id: "FN-FEED-1" })}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      {...props}
    />,
  );
}

/** Exactly what an SSE snapshot looks like: spec present, journal emptied. */
function strippedSnapshot() {
  return makeTask({
    id: "FN-FEED-1",
    column: "done" as never,
    prompt: "# Task FN-FEED-1\n\n## Steps\n\n### Step 1: Do the thing\n",
    log: [],
  });
}

describe("Feed on a log-stripped snapshot", () => {
  it("fetches the real detail when the card opens straight onto an empty Feed", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
      id: "FN-FEED-1",
      column: "done" as never,
      log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
    }) as never);

    renderModal({ task: strippedSnapshot(), initialTab: "logs" });

    // The rescue must not depend on the operator switching segments: Feed is already open.
    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalled();
  });

  /*
  A task that genuinely has no entries must still say so, and must not spin: the rescue is guarded on
  emptiness, so one attempt per visit is the contract, not a retry loop.
  */
  it("still reports an honestly empty journal, and asks only once", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({ id: "FN-FEED-2", log: [] }) as never);

    renderModal({ task: makeTask({ id: "FN-FEED-2", prompt: "# spec", log: [] }), initialTab: "logs" });

    expect(await screen.findByText("(no activity)")).toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail).mock.calls.length).toBeLessThanOrEqual(1);
  });

  /*
  The documented property that must not regress: a card opened with real entries already in hand
  renders them without paying for a request.
  */
  it("does not re-request when the prop already carries the journal", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();

    renderModal({
      task: makeTask({
        id: "FN-FEED-3",
        prompt: "# spec",
        log: [{ timestamp: "2026-08-26T08:00:00.000Z", action: "Already present" }],
      }),
      initialTab: "logs",
    });

    expect(screen.getByText("Already present")).toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).not.toHaveBeenCalled();
  });
});

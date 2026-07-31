/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:35:
THE LIVE ELAPSED-TIME INDICATOR NEVER STARTED FOR CARDS IN A RENAMED WIP OR REVIEW LANE.

`wantsLiveTimeIndicator` decides whether a card subscribes to the shared ticker. It reads
`isWipColumn` / `isReviewColumn` / `taskColumnFlags` — all derived from the `taskColumnFlags` PROP —
while its dependency array lists only `task.*` fields.

`taskColumnFlags` arrives ASYNCHRONOUSLY: the board resolves workflow traits after first paint, so
the first computation always runs with the flags undefined. The role helpers then fall back to the
legacy ids, and on a renamed board `isWipColumnRole(undefined, "building")` is false. The card
decides it needs no ticker. When the flags arrive, `task.column` has not changed — so nothing in the
dependency array changed, the memo never recomputes, and the card never subscribes.

WHY THE DEFAULT BOARD HID IT. With legacy ids the fallback answers `true` on the very first paint
(`column === "in-progress"`), so the memo's initial value is already correct and the stale dependency
list costs nothing. The defect is renamed-board-only, which is why it survived.

Found by generalizing the memo-dependency defect in the blocker fan-out (#2993) into a sweep for
memoized hooks that read a lane value absent from their deps, rather than treating that one as a
one-off. This repo has no `react-hooks/exhaustive-deps` rule, so the whole class is invisible to lint.
*/

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

/* The subscription flag is the observable: `enabled` is exactly `wantsLiveTimeIndicator`. */
const tickerCalls: boolean[] = [];
vi.mock("../../hooks/useLiveTimeTicker", () => ({
  useLiveTimeTicker: (enabled: boolean) => {
    tickerCalls.push(enabled);
    return Date.now();
  },
}));

const noop = () => {};

function taskIn(column: string): Task {
  return {
    id: "KB-1",
    title: "a card",
    description: "t",
    column,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    executionStartedAt: "2026-06-01T00:00:00.000Z",
    cumulativeActiveMs: 60_000,
    steps: [],
  } as unknown as Task;
}

/** Did the card subscribe on its LATEST render? */
const subscribedNow = () => tickerCalls[tickerCalls.length - 1] === true;

describe("the live time indicator when column traits arrive after first paint", () => {
  /* Control: on a legacy board the fallback answers correctly on the first paint, so this passes
     with or without the fix and proves the harness observes a real subscription. */
  it("default vocabulary: a card in `in-progress` subscribes with no flags at all", () => {
    tickerCalls.length = 0;
    render(<TaskCard task={taskIn("in-progress")} onOpenDetail={noop} addToast={noop} />);

    expect(subscribedNow()).toBe(true);
  });

  /*
  The defect. First paint has no flags, so the renamed lane reads as not-WIP and the card declines
  the ticker; the flags then arrive and nothing recomputes.
  */
  it("renamed vocabulary: a card subscribes once its WIP traits arrive", () => {
    tickerCalls.length = 0;
    const { rerender } = render(
      <TaskCard task={taskIn("building")} onOpenDetail={noop} addToast={noop} />,
    );
    /* Pre-load: correctly declines, because nothing yet says this lane is WIP. */
    expect(subscribedNow()).toBe(false);

    rerender(
      <TaskCard
        task={taskIn("building")}
        taskColumnFlags={{ countsTowardWip: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(subscribedNow()).toBe(true);
  });

  /*
  The paired negative: recomputing must not degrade into "every card subscribes". A card whose
  resolved traits say terminal is finished work and must stay off the shared ticker, or the fix
  trades one stalled indicator for sixty cards waking a backgrounded tab — the exact cost the
  shared-ticker refactor documented at this site.
  */
  it("renamed vocabulary: a card in the renamed COMPLETE lane does not subscribe", () => {
    tickerCalls.length = 0;
    const { rerender } = render(
      <TaskCard task={taskIn("shipped")} onOpenDetail={noop} addToast={noop} />,
    );
    rerender(
      <TaskCard
        task={taskIn("shipped")}
        taskColumnFlags={{ complete: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(subscribedNow()).toBe(false);
  });
});

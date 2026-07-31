/*
FNXC:WorkflowResolvedColumns 2026-07-31-03:10:
THE TIME INDICATOR IS GATED ON A HARDCODED LEGACY LANE SET, so it never renders on a renamed board.

`TIME_INDICATOR_COLUMNS` is `{in-progress, in-review, done}`. Both the `timeIndicator` memo and the
`chipFarRight` layout test `task.column` against it directly, so a card in a renamed WIP, review or
completion lane returns `null` no matter what its resolved traits say.

WHY THIS IS A SEPARATE DEFECT FROM #2996, and a correction to that PR's claim: #2996 fixed the
SUBSCRIPTION — `wantsLiveTimeIndicator` kept a pre-load answer and the card never joined the shared
ticker. That was real, and it was not sufficient. The card now subscribes and still renders nothing,
because this gate rejects it first. I described that PR as making renamed-lane cards "show their live
elapsed-time indicator"; it made them eligible to.

WHY NO CHECK SAW IT. The census counts COMPARISONS against legacy ids. This is a Set literal — a
DEFINITION — so nothing in the backlog ever pointed here, the same blind spot that hid
`BLOCKER_ESCALATION_COLUMNS` until it was found by hand.
*/

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

vi.mock("../../hooks/useLiveTimeTicker", () => ({
  useLiveTimeTicker: () => Date.parse("2026-06-01T01:00:00.000Z"),
}));

const noop = () => {};

function runningTaskIn(column: string): Task {
  return {
    id: "KB-1",
    title: "a running card",
    description: "t",
    column,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    executionStartedAt: "2026-06-01T00:00:00.000Z",
    cumulativeActiveMs: 120_000,
    timedExecutionMs: 120_000,
    steps: [],
  } as unknown as Task;
}

/** The indicator renders an elapsed duration; any of these means it is present. */
const hasDuration = (root: HTMLElement) => /\d+\s*(s|m|h)\b|\d+:\d\d/.test(root.textContent ?? "");

describe("the card time indicator under a renamed board vocabulary", () => {
  /* Control: the legacy vocabulary renders it, with no flags at all. */
  it("default vocabulary: a card in `in-progress` shows an elapsed time", () => {
    const { container } = render(
      <TaskCard task={runningTaskIn("in-progress")} onOpenDetail={noop} addToast={noop} />,
    );

    expect(hasDuration(container as unknown as HTMLElement)).toBe(true);
  });

  /* The defect: the renamed WIP lane is not in the hardcoded set, so nothing renders. */
  it("renamed vocabulary: a card whose traits say WIP shows an elapsed time", () => {
    const { container } = render(
      <TaskCard
        task={runningTaskIn("building")}
        taskColumnFlags={{ countsTowardWip: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(hasDuration(container as unknown as HTMLElement)).toBe(true);
  });

  /*
  The paired negative: resolving traits must not put a live timer on every lane. A card in the
  renamed INTAKE lane has not started, so it must stay out — otherwise the fix trades a missing
  indicator for a running clock on work that has not begun.
  */
  it("renamed vocabulary: a card in the intake lane shows no elapsed time", () => {
    const { container } = render(
      <TaskCard
        task={runningTaskIn("drafting")}
        taskColumnFlags={{ intake: true, hold: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(hasDuration(container as unknown as HTMLElement)).toBe(false);
  });
});

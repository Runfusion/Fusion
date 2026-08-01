/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:20:
THE CARD'S DIFF-STATS REFRESH KEY STAYED UNDEFINED ON A RENAMED BOARD.

`mergeSignature` is the value `useTaskDiffStats` uses to notice that a merge changed what a finished
card should display. It early-returns `undefined` unless `isCompleteColumn`, which derives from the
`taskColumnFlags` PROP — and its dependency list was three `task.*` fields, none of which is that
prop or anything carrying it.

The flags arrive after first paint (the board resolves workflow traits asynchronously). The first
computation therefore runs with them undefined, the role helper falls back to the legacy id, and on a
renamed board `isCompleteColumnRole(undefined, "shipped")` is false — so the signature is `undefined`.
When the flags arrive, `task.column` has not changed and, for a card already merged when the board
loaded, neither have the two `mergeDetails` fields. Nothing recomputes and the key stays absent.

WHY THE DEFAULT BOARD HID IT: `column === "done"` answers true on the first paint, so the memo's
initial value is already right.

Last live site from the sweep recorded in the learnings doc (nine persistent candidates, seven
covered transitively or by a dependency that already carries the flags).
*/

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

/* Capture the options `useTaskDiffStats` is called with — `mergeSignature` is the observable. */
const seen: (string | undefined)[] = [];
vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: (
    _id: string,
    _column: string,
    _sha: string | undefined,
    _projectId: string | undefined,
    options: { mergeSignature?: string },
  ) => {
    seen.push(options?.mergeSignature);
    return { stats: undefined, loading: false };
  },
}));

const noop = () => {};

/** A card that merged BEFORE the board loaded: its mergeDetails never change afterwards. */
function mergedTaskIn(column: string): Task {
  return {
    id: "KB-1",
    title: "a merged card",
    description: "t",
    column,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    steps: [],
    mergeDetails: { commitSha: "abc1234", filesChanged: 3, landedFiles: ["a.ts", "b.ts", "c.ts"] },
  } as unknown as Task;
}

const latest = () => seen[seen.length - 1];

describe("the diff-stats refresh key when column traits arrive after first paint", () => {
  /* Control: on a legacy board the key is present from the first paint, with no flags at all. */
  it("default vocabulary: a card in `done` gets a merge signature", () => {
    seen.length = 0;
    render(<TaskCard task={mergedTaskIn("done")} onOpenDetail={noop} addToast={noop} />);

    expect(latest()).toBeDefined();
  });

  /* The defect: the renamed complete lane never produced a key, so a merge could not refresh stats. */
  it("renamed vocabulary: the key appears once the complete trait arrives", () => {
    seen.length = 0;
    const { rerender } = render(
      <TaskCard task={mergedTaskIn("shipped")} onOpenDetail={noop} addToast={noop} />,
    );
    expect(latest()).toBeUndefined();

    rerender(
      <TaskCard
        task={mergedTaskIn("shipped")}
        taskColumnFlags={{ complete: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(latest()).toBeDefined();
  });

  /*
  The paired negative: recomputing must not hand a signature to cards that are not finished. An
  in-flight card has no merge to key on, and inventing one would make the diff-stats hook treat
  unfinished work as landed.
  */
  it("renamed vocabulary: a card in the WIP lane still has no signature", () => {
    seen.length = 0;
    const { rerender } = render(
      <TaskCard task={mergedTaskIn("building")} onOpenDetail={noop} addToast={noop} />,
    );
    rerender(
      <TaskCard
        task={mergedTaskIn("building")}
        taskColumnFlags={{ countsTowardWip: true }}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(latest()).toBeUndefined();
  });
});

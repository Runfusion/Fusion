import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { join } from "node:path";
import { listComponentFiles, loadAllAppCss, readAppFile } from "../../test/cssFixture";
import { TaskCard } from "../TaskCard";
import type { Task } from "@fusion/core";

/*
FN-416 — Symptom Verification for "a reverted card shows only its badge".

Original symptom: after a successful revert the card rendered a `.card-reverted-actions` strip with
Delete and Revise buttons beside the Reverted badge, and no affordance existed to undo the revert.
This suite replays that exact fixture (reverted `sourceMetadata`, Complete column, Delete handler
supplied) and proves the strip is gone, the badge stays, and the context menu offers a working
restore action on both desktop right-click and mobile long-press.
*/

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

const noop = () => {};

function makeRevertedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Reverted task",
    column: "done",
    status: undefined as never,
    steps: [],
    dependencies: [],
    description: "Some landed work",
    mergeDetails: { commitSha: "landed-sha" },
    sourceMetadata: { revertedAt: "2026-07-16T00:00:00.000Z" },
    ...overrides,
  } as Task;
}

describe("FN-416 reverted card shows only its badge", () => {
  // Case (a) + (f): the exact original reproduction.
  it("renders the Reverted badge with no Delete/Revise resolution actions and no leftover container", () => {
    render(
      <TaskCard
        task={makeRevertedTask()}
        onOpenDetail={noop}
        onDeleteTask={vi.fn()}
        addToast={noop}
      />,
    );

    expect(screen.getByLabelText("This task's changes were reverted")).toBeInTheDocument();
    expect(document.querySelector(".card-reverted-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
  });

  // Case (j): a later restore marker clears the badge without any data migration.
  it("drops the badge once a later restore marker exists", () => {
    render(
      <TaskCard
        task={makeRevertedTask({ sourceMetadata: { revertedAt: "2026-07-16T00:00:00.000Z", restoredAt: "2026-07-17T00:00:00.000Z" } } as Partial<Task>)}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(document.querySelector(".card-reverted-chip")).toBeNull();
  });
});

describe("FN-416 restore-revert context-menu action", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // Case (g): desktop right-click.
  it("offers Restore revert on right-click and calls the handler", async () => {
    const onRestoreRevertTask = vi.fn().mockResolvedValue({ mode: "git", clean: true, restoreCommitSha: "restore-sha" });
    render(
      <TaskCard
        task={makeRevertedTask()}
        onOpenDetail={noop}
        onRestoreRevertTask={onRestoreRevertTask}
        addToast={noop}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore revert" }));

    await waitFor(() => expect(onRestoreRevertTask).toHaveBeenCalledWith("FN-001", { mode: "auto" }));
  });

  // Case (k): an already-reverted card is never offered Revert again.
  it("hides the Revert entry on an already-reverted card", () => {
    render(
      <TaskCard
        task={makeRevertedTask()}
        onOpenDetail={noop}
        onRevertTask={vi.fn()}
        onRestoreRevertTask={vi.fn()}
        addToast={noop}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.queryByRole("menuitem", { name: "Revert" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Restore revert" })).toBeInTheDocument();
  });

  it("still offers Revert on a completed card that was never reverted", () => {
    render(
      <TaskCard
        task={makeRevertedTask({ sourceMetadata: {} } as Partial<Task>)}
        onOpenDetail={noop}
        onRevertTask={vi.fn()}
        onRestoreRevertTask={vi.fn()}
        addToast={noop}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Revert" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Restore revert" })).toBeNull();
  });

  // Case (h): mobile long-press uses the same single model as desktop right-click.
  it("offers the same Restore revert entry on a mobile long-press", async () => {
    vi.useFakeTimers();
    const onRestoreRevertTask = vi.fn().mockResolvedValue({ mode: "git", clean: true, restoreCommitSha: "restore-sha" });
    try {
      render(
        <TaskCard
          task={makeRevertedTask()}
          onOpenDetail={noop}
          onRestoreRevertTask={onRestoreRevertTask}
          addToast={noop}
        />,
      );

      const card = document.querySelector(".card") as HTMLElement;
      fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 32, clientY: 36 });
      await act(async () => { await vi.advanceTimersByTimeAsync(550); });

      await act(async () => {
        fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Restore revert" }), { pointerType: "touch", pointerId: 2 });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onRestoreRevertTask).toHaveBeenCalledWith("FN-001", { mode: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
FN-416 case (e): code-construct census. No production dashboard module may still build the removed
reverted-actions strip or its label key. This asserts source CONSTRUCTS, not comments or prose.
*/
describe("FN-416 removed reverted-actions affordance is absent from production modules", () => {
  it("no component module references card-reverted-actions or revertedResolutionActions", () => {
    const offenders = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__"))
      .filter((relativePath) => {
        const source = readAppFile(join("components", relativePath));
        // Comments are documentation, never the subject: strip them before the construct scan.
        const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        return stripped.includes("card-reverted-actions") || stripped.includes("revertedResolutionActions");
      });
    expect(offenders).toEqual([]);
  });

  it("no stylesheet still declares the removed .card-reverted-actions rule", () => {
    const css = loadAllAppCss().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toContain(".card-reverted-actions");
  });
});

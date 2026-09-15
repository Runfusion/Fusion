/*
FNXC:TaskDetailPresentation 2026-09-15-00:20:
The plan sub-view shows the task's REAL `PROMPT.md` and adds a Copy control. What matters is that Copy puts
the current Markdown SOURCE on the clipboard (never the rendered DOM and never the product summary), that
its confirmation is transient and self-clearing, that a failure shows no confirmation, and that leaving the
document or switching task can never leave a stale "Copied" behind for a successor.

The sub-view itself must stay a sub-view: Back returns to the same tab it was opened from, the plan's own
editing affordances remain, and reading or copying mutates nothing.
*/

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const PLAN = [
  "# Task: FN-PLAN",
  "",
  "## Mission",
  "Copy the **source**, not the rendered document.",
  "",
  "1. First step",
  "2. Second step",
  "",
  "- A bullet with `inline code`",
].join("\n");

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function renderPlan(overrides = {}) {
  return render(
    <TaskDetailContent
      {...sharedProps}
      embedded
      task={makeTask({ id: "FN-PLAN", prompt: PLAN, ...overrides })}
    />,
  );
}

function openDefinition() {
  const tab = Array.from(document.querySelectorAll<HTMLElement>(".detail-tab"))
    .find((candidate) => candidate.textContent?.trim() === "Plan");
  if (!tab) throw new Error("definition tab not found");
  fireEvent.click(tab);
}

function openPlanDocument() {
  openDefinition();
  fireEvent.click(screen.getByRole("button", { name: /Read plan/i }));
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("plan sub-view navigation and copy", () => {
  it("opens the real PROMPT.md as a sub-view and returns to the tab it came from", () => {
    renderPlan();
    openPlanDocument();

    expect(screen.getByTestId("task-detail-plan-document")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Copy the source, not the rendered document.");

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));

    expect(screen.queryByTestId("task-detail-plan-document")).toBeNull();
    // The definition destination is still the selected tab; the task was not closed.
    expect(screen.getByRole("button", { name: /Read plan/i })).toBeInTheDocument();
  });

  it("copies the current Markdown source rather than the rendered document", async () => {
    renderPlan();
    openPlanDocument();

    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(PLAN);
    // Proof it is the SOURCE: Markdown syntax survives, which rendered text would have consumed.
    expect(writeText.mock.calls[0]![0]).toContain("## Mission");
    expect(writeText.mock.calls[0]![0]).toContain("`inline code`");
  });

  it("confirms the copy and clears that confirmation on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPlan();
    openPlanDocument();

    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));
    await waitFor(() => expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copied"));

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copy");
  });

  it("shows no confirmation when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    // The shared utility falls back to execCommand; make that fail too so the copy genuinely fails.
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    renderPlan();
    openPlanDocument();

    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copy");
    expect(screen.getByTestId("task-detail-plan-copy")).not.toHaveTextContent("Copied");
  });

  it("never carries a confirmation back into the document after leaving it", async () => {
    renderPlan();
    openPlanDocument();

    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));
    await waitFor(() => expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copied"));

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));
    fireEvent.click(screen.getByRole("button", { name: /Read plan/i }));

    expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copy");
  });

  it("discards a copy that resolves after the document closed", async () => {
    let release!: () => void;
    writeText.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve(); }));

    renderPlan();
    openPlanDocument();
    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));
    await act(async () => {
      release();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /Read plan/i }));
    expect(screen.getByTestId("task-detail-plan-copy")).toHaveTextContent("Copy");
  });

  it("keeps the plan's own editing affordances and mutates nothing by reading or copying", async () => {
    renderPlan();
    openPlanDocument();

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-detail-plan-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // The document is unchanged and still the real prompt.
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Copy the source, not the rendered document.");
  });
});

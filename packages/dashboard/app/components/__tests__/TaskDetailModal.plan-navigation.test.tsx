/*
FNXC:TaskDetailPresentation 2026-09-15-16:02:
FN-424 removed Copy, Open PROMPT.md and Edit from the plan sub-view, and the inline specification
editor that Edit was the only entry point for. The copy-confirmation cases that encoded those
affordances are deleted with their subject rather than weakened.

What remains, and what these tests guard: the sub-view stays a sub-view (Back returns to the tab it
was opened from), it renders the task's REAL `PROMPT.md` complete, and it exposes NO write or copy
action on either host, in either style, with or without a mounted file browser.
*/

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import { FileBrowserProvider } from "../../context/FileBrowserContext";

setupTaskDetailModalHooks();

const PLAN = [
  "# Task: FN-PLAN",
  "",
  "## Mission",
  "Read the **source**, not a summary.",
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

function renderPlan(options?: { embedded?: boolean; withFileBrowser?: boolean }) {
  const content = (
    <TaskDetailContent
      {...sharedProps}
      embedded={options?.embedded ?? true}
      onRequestClose={noop}
      task={makeTask({ id: "FN-PLAN", prompt: PLAN })}
    />
  );
  return render(options?.withFileBrowser ? <FileBrowserProvider>{content}</FileBrowserProvider> : content);
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

describe("plan sub-view navigation", () => {
  it("opens the real PROMPT.md as a sub-view and returns to the tab it came from", () => {
    renderPlan();
    openPlanDocument();

    expect(screen.getByTestId("task-detail-plan-document")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Read the source, not a summary.");

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));

    expect(screen.queryByTestId("task-detail-plan-document")).toBeNull();
    // The definition destination is still the selected tab; the task was not closed.
    expect(screen.getByRole("button", { name: /Read plan/i })).toBeInTheDocument();
  });

  it("keeps Back as the only control in the sub-view header", () => {
    renderPlan();
    openPlanDocument();

    const header = document.querySelector(".detail-plan-document-header");
    expect(header).toBeInTheDocument();
    expect(header!.querySelectorAll("button")).toHaveLength(1);
    expect(header!.querySelector("button")).toHaveAccessibleName("Back to definition");
  });

  /*
  The invariant, not the reported repro: no host, and no mounted file browser, may expose a copy or
  write affordance in the plan sub-view.
  */
  it.each([
    { label: "the embedded host", embedded: true, withFileBrowser: false },
    { label: "the modal-shaped host", embedded: false, withFileBrowser: false },
    { label: "a mounted file browser", embedded: true, withFileBrowser: true },
  ])("exposes no Copy, Open PROMPT.md or Edit action in $label", ({ embedded, withFileBrowser }) => {
    renderPlan({ embedded, withFileBrowser });
    openPlanDocument();

    for (const name of ["Copy", "Open PROMPT.md", "Edit"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByTestId("task-detail-plan-copy")).toBeNull();
    expect(document.querySelector(".detail-plan-copy")).toBeNull();
    expect(document.querySelector(".detail-spec-edit-trigger")).toBeNull();
    expect(document.querySelector(".spec-editor-edit-mode")).toBeNull();
    expect(document.querySelector(".spec-editor-textarea")).toBeNull();

    // The read stays complete.
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Read the source, not a summary.");
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Second step");
  });

  it("still shows the (no prompt) fallback when the task has no plan", () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        onRequestClose={noop}
        task={makeTask({ id: "FN-EMPTY", prompt: "" })}
      />,
    );
    openPlanDocument();

    expect(screen.getByText("(no prompt)")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-plan-copy")).toBeNull();
  });
});

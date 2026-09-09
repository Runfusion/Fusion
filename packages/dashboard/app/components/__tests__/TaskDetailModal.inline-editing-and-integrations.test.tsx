/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
import { describe, it, expect, vi } from "vitest";
import { useState, type Dispatch, type SetStateAction } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, TaskDetail } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  mockConfirmWithCheckbox,
  mockUsePluginUiSlots,
  expectBaseRule,
  expectSingleStatsRuntimeStatus,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { loadAllAppCss } from "../../test/cssFixture";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

function openTaskDetailActionsMenu() {
  const trigger = screen.getByRole("button", { name: "Actions" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("menu");
}

function getMediaBlocks(css: string, mediaQuery: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < css.length) {
    const mediaStart = css.indexOf(mediaQuery, searchFrom);
    if (mediaStart === -1) {
      break;
    }

    const blockStart = css.indexOf("{", mediaStart);
    if (blockStart === -1) {
      break;
    }

    let depth = 1;
    let index = blockStart + 1;

    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      index += 1;
    }

    if (depth === 0) {
      blocks.push(css.slice(blockStart + 1, index - 1));
      searchFrom = index;
    } else {
      break;
    }
  }

  return blocks;
}

function getRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function getRuleBlockFromSelectorList(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector);
  if (selectorIndex === -1) {
    return "";
  }
  const ruleStart = css.indexOf("{", selectorIndex);
  if (ruleStart === -1) {
    return "";
  }
  const ruleEnd = css.indexOf("}", ruleStart);
  return ruleEnd === -1 ? "" : css.slice(ruleStart + 1, ruleEnd);
}

/*
FNXC:TaskDetailStatsAssertions 2026-08-09-16:50:
FN-8906 requires Stats-tab runtime-status assertions to be scoped to the named Stats region because
the modal header lifecycle badge intentionally renders the same raw status string.
*/
describe("TaskDetailModal", () => {
  describe("source issue metadata", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("renders source issue collapsed by default and expands details on toggle", async () => {
      const user = userEvent.setup();
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Source issue")).toBeTruthy();
      expect(screen.getByLabelText("GitHub source issue")).toBeTruthy();
      const summaryIssueLink = screen.getByRole("link", { name: "(#2473)" });
      expect(summaryIssueLink).toHaveAttribute(
        "href",
        "https://github.com/runfusion/fusion/issues/2473",
      );
      expect(summaryIssueLink.classList.contains("detail-source-link--summary")).toBe(true);
      expect(screen.queryByText("Provider")).toBeNull();

      const toggle = screen.getByRole("button", { name: "Expand source issue details" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const chevron = toggle.querySelector("svg");
      expect(chevron?.classList.contains("detail-source-chevron--expanded")).toBe(false);

      await user.click(toggle);

      const collapseToggle = await screen.findByRole("button", { name: "Collapse source issue details" });
      await waitFor(() => {
        expect(collapseToggle).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Provider")).toBeTruthy();
      });
      expect(screen.getByText("github")).toBeTruthy();
      expect(screen.getByText("runfusion/fusion")).toBeTruthy();
      const sourceLink = screen.getByRole("link", { name: "https://github.com/runfusion/fusion/issues/2473" });
      expect(sourceLink).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/2473");
      expect(sourceLink).toHaveAttribute("target", "_blank");
      const expandedChevron = collapseToggle.querySelector("svg");
      expect(expandedChevron?.classList.contains("detail-source-chevron--expanded")).toBe(true);
    });

    it("applies compact GitHub source summary styling contracts", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-source-provider-badge", "border-radius: var(--radius-pill);");
      expectBaseRule(css, ".detail-source-provider-badge", "background: color-mix(in srgb, var(--text-muted) 18%, transparent);");
      expectBaseRule(css, ".detail-source-link--summary", "text-decoration: none;");
      expectBaseRule(css, ".detail-source-section .detail-source-grid", "margin-top: var(--space-sm);");
      expectBaseRule(css, ".detail-source-section .detail-source-grid", "padding-top: var(--space-sm);");
    });

    it("does not render GitHub badge for non-github providers", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceIssue: {
              provider: "gitlab",
              repository: "runfusion/fusion",
              externalIssueId: "42",
              issueNumber: 42,
              url: "https://gitlab.com/runfusion/fusion/-/issues/42",
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByLabelText("GitHub source issue")).toBeNull();
      expect(screen.getByRole("link", { name: "(#42)" })).toBeTruthy();
    });

    it("hides source issue read section when sourceIssue metadata is missing", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceIssue: undefined })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Source issue")).toBeNull();
      expect(screen.queryByText("No source issue metadata recorded.")).toBeNull();
    });

    it("prefills source issue inputs in edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

      await waitFor(() => {
        expect((screen.getByTestId("task-source-provider-input") as HTMLInputElement).value).toBe("github");
      });
      expect((screen.getByTestId("task-source-repository-input") as HTMLInputElement).value).toBe("runfusion/fusion");
      expect((screen.getByTestId("task-source-external-id-input") as HTMLInputElement).value).toBe("I_kgDOExample");
      expect((screen.getByTestId("task-source-url-input") as HTMLInputElement).value).toBe("https://github.com/runfusion/fusion/issues/2473");
    });

    it("renders source issue block below Model Configuration in edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

      await waitFor(() => {
        const modelLabel = screen.getByText("Model Configuration");
        const sourceLabel = screen.getByText("Source Issue");

        // U6/R3: the per-step workflow section no longer renders in edit mode,
        // so we only assert Source Issue stays below Model Configuration.
        expect(
          modelLabel.compareDocumentPosition(sourceLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      });
    });

    it("sends sourceIssue payload when source metadata is edited", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "gitlab" } });
      fireEvent.change(screen.getByTestId("task-source-repository-input"), { target: { value: "runfusion/dashboard" } });
      fireEvent.change(screen.getByTestId("task-source-external-id-input"), { target: { value: "I_kgDONew" } });
      fireEvent.change(screen.getByTestId("task-source-url-input"), { target: { value: "https://gitlab.com/runfusion/dashboard/-/issues/2473" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          sourceIssue: {
            provider: "gitlab",
            repository: "runfusion/dashboard",
            externalIssueId: "I_kgDONew",
            issueNumber: 2473,
            url: "https://gitlab.com/runfusion/dashboard/-/issues/2473",
          },
        }), undefined);
      });
    });

    it("sends sourceIssue: null when all source metadata fields are cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-repository-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-external-id-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-url-input"), { target: { value: "" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({ sourceIssue: null }), undefined);
      });
    });

    it("keeps edit mode active and shows error toast when source metadata save fails", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockRejectedValueOnce(new Error("source patch failed"));
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "gitlab" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: source patch failed", "error");
      });
      expect(document.querySelector("#task-form-title")).toBeTruthy();
    });
  });

  describe("Details tab original prompt", () => {
    it("is collapsed by default and expands to render the original prompt as markdown", () => {
      const originalPrompt = "# Heading\n\n- item\n\n`code`";
      const generatedPrompt = "# FN-TEST\n\n## Mission\nGenerated plan";
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-TEST",
            title: "Title must not replace description",
            description: originalPrompt,
            prompt: generatedPrompt,
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("heading", { name: "Original prompt" })).toBeTruthy();
      const toggle = screen.getByRole("button", { name: "Expand original prompt" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      // Collapsed by default: the prompt body is not in the DOM until expanded.
      expect(screen.queryByTestId("task-detail-original-prompt")).toBeNull();

      fireEvent.click(toggle);

      const expandedToggle = screen.getByRole("button", { name: "Collapse original prompt" });
      expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
      const originalPromptNode = screen.getByTestId("task-detail-original-prompt");
      expect(originalPromptNode.className).toContain("markdown-body");
      // Rendered as markdown, not raw source: a real heading/list/code element exists,
      // and the raw markdown characters are gone.
      expect(originalPromptNode.querySelector("h1, li, code")).toBeTruthy();
      expect(originalPromptNode.textContent).not.toContain("# Heading");
      expect(originalPromptNode.textContent).not.toContain("`code`");

      const originalSection = document.querySelector(".detail-section--original-prompt");
      expect(originalSection?.contains(screen.getByText("Original prompt"))).toBe(true);
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(originalPromptNode.textContent).not.toBe("Title must not replace description");
    });

    it("renders a non-boxed empty fallback with no toggle", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-EMPTY",
            description: "   \n\t ",
            prompt: "# FN-EMPTY\n\n## Mission\nGenerated plan still visible",
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("No original prompt recorded.")).toBeTruthy();
      expect(screen.queryByTestId("task-detail-original-prompt")).toBeNull();
      expect(screen.queryByRole("button", { name: "Expand original prompt" })).toBeNull();
      expect(document.querySelector(".detail-section--original-prompt .detail-original-prompt-text")).toBeNull();
    });

    it("shows the same collapsible original prompt section in embedded task detail content", () => {
      const originalPrompt = "Embedded prompt\nwith a second line";
      const { container } = render(
        <TaskDetailContent
          embedded
          initialTab="details"
          task={makeTask({
            id: "FN-EMBED",
            description: originalPrompt,
            prompt: "# FN-EMBED\n\n## Mission\nEmbedded generated plan",
          })}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(document.querySelector(".task-detail-content--embedded")).toBeTruthy();
      expect(screen.queryByTestId("task-detail-original-prompt")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Expand original prompt" }));
      expect(screen.getByTestId("task-detail-original-prompt").textContent).toBe(originalPrompt);
    });

    it("applies wrapping and mobile CSS contracts to the expanded original prompt section", () => {
      const css = readDashboardStylesSource();
      const markdownBodyBlock = getRuleBlock(css, ".detail-section--original-prompt .markdown-body");
      const emptyBlock = getRuleBlock(css, ".detail-original-prompt-empty");
      const mobileBlock = getMediaBlocks(css, "@media (max-width: 768px)").find((block) =>
        block.includes(".detail-section--original-prompt"),
      ) ?? "";

      expect(css).toContain(".detail-section--original-prompt,\n.detail-section--plan-prompt");
      expect(markdownBodyBlock).toContain("box-sizing: border-box;");
      expect(markdownBodyBlock).toContain("width: 100%;");
      expect(markdownBodyBlock).toContain("min-width: 0;");
      expect(markdownBodyBlock).toContain("max-width: 100%;");
      expect(markdownBodyBlock).toContain("overflow-wrap: anywhere;");
      expect(markdownBodyBlock).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
      expect(emptyBlock).toContain("margin: 0;");
      expect(emptyBlock).toContain("color: var(--text-muted);");
      expect(mobileBlock).toContain(".detail-section--original-prompt,");
      expect(mobileBlock).toContain(".detail-section--original-prompt .markdown-body");
      expect(mobileBlock).toContain("max-width: 100%;");
    });
  });

  describe("inline editing", () => {
    const chooseInlinePriority = (priority: TaskPriority) => {
      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId(`detail-priority-option-${priority}`));
    };
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("shows Edit button in header when task is in triage column", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = document.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("shows Edit button in header when task is in todo column", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = document.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("does not show Edit button when task is in in-progress column", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "in-progress", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = document.querySelector(".modal-edit-btn");
      expect(editButton).toBeNull();
    });

    it("does not show Edit button when already in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      const editButton = document.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
      fireEvent.click(editButton!);

      // Edit button should be hidden now
      expect(document.querySelector(".modal-edit-btn")).toBeNull();
      // But TaskForm title input should be visible
      expect(document.querySelector("#task-form-title")).toBeTruthy();
    });

    it("entering edit mode shows title input and description textarea", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task", description: "Test description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows title as h2
      expect(document.querySelector("h2.detail-title")).toBeTruthy();
      expect(document.querySelector("#task-form-title")).toBeNull();

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // Now shows edit form with TaskForm fields
      expect(document.querySelector("h2.detail-title")).toBeNull();
      expect(document.querySelector("#task-form-title")).toBeTruthy();
      expect(document.querySelector("#task-form-description")).toBeTruthy();
    });

    it("clicking Cancel exits edit mode without saving", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Modified title" } });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Should exit edit mode without saving
      expect(document.querySelector("#task-form-title")).toBeNull();
      expect(document.querySelector("h2.detail-title")?.textContent).toBe("Original title");
    });

    it("clicking Save calls updateTask with correct parameters", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = document.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(titleInput, { target: { value: "New title" } });
      fireEvent.change(descTextarea, { target: { value: "New description" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          title: "New title",
          description: "New description",
        }), undefined);
      });
    });

    it("deletes a cleared description through the confirmed task callback", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const onDeleteTask = vi.fn(async () => makeTask({ id: "FN-001" }) as Task);
      mockConfirmWithCheckbox.mockResolvedValue({ choice: "primary", checkboxValue: false });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(document.querySelector("#task-form-description")!, { target: { value: "   \n\t" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockConfirmWithCheckbox).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete Task", danger: true }));
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
      expect(mockUpdate).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({ description: "" }), undefined);
    });

    it("keeps a cleared description editable when deletion is cancelled", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const onDeleteTask = vi.fn(async () => makeTask({ id: "FN-001" }) as Task);
      mockConfirmWithCheckbox.mockResolvedValue({ choice: "cancel", checkboxValue: false });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", description: "Original description" })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(document.querySelector("#task-form-description")!, { target: { value: "" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockConfirmWithCheckbox).toHaveBeenCalledTimes(1));
      expect(onDeleteTask).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({ description: "" }), undefined);
      expect(document.querySelector("#task-form-description")).toBeTruthy();
    });

    it("does not delete a restored draft from a stale confirmation", async () => {
      let resolveConfirmation: ((value: { choice: "primary"; checkboxValue: boolean }) => void) | undefined;
      const confirmation = new Promise<{ choice: "primary"; checkboxValue: boolean }>((resolve) => {
        resolveConfirmation = resolve;
      });
      const onDeleteTask = vi.fn(async () => makeTask({ id: "FN-001" }) as Task);
      mockConfirmWithCheckbox.mockReturnValue(confirmation);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", description: "Original description" })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      const description = document.querySelector("#task-form-description")!;
      fireEvent.change(description, { target: { value: "" } });
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => expect(mockConfirmWithCheckbox).toHaveBeenCalledTimes(1));
      fireEvent.change(description, { target: { value: "Restored description" } });
      await act(async () => resolveConfirmation?.({ choice: "primary", checkboxValue: false }));

      expect(onDeleteTask).not.toHaveBeenCalled();
      expect(document.querySelector("#task-form-description")).toBeTruthy();
    });

    it("fences the description debounce and Save click to one embedded-host deletion", async () => {
      vi.useFakeTimers();
      try {
        const onDeleteTask = vi.fn(async () => makeTask({ id: "FN-001" }) as Task);
        const onRequestClose = vi.fn();
        mockConfirmWithCheckbox.mockResolvedValue({ choice: "primary", checkboxValue: false });

        render(
          <TaskDetailContent
            initialTab="definition"
            embedded
            task={makeTask({ id: "FN-001", column: "triage", description: "Original description" })}
            onOpenDetail={noopOpenDetail}
            onDeleteTask={onDeleteTask}
            onMergeTask={noopMerge}
            addToast={noop}
            onRequestClose={onRequestClose}
          />,
        );

        fireEvent.click(document.querySelector(".modal-edit-btn")!);
        fireEvent.change(document.querySelector("#task-form-description")!, { target: { value: "" } });
        fireEvent.click(screen.getByText("Save"));
        await act(async () => vi.advanceTimersByTimeAsync(1_500));

        expect(onDeleteTask).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("Save button is enabled in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const saveButton = screen.getByText("Save");
      expect(saveButton.hasAttribute("disabled")).toBe(false);
    });

    it("Save button shows 'Saving…' during save operation", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      // Delay the resolution to keep isSaving true
      mockUpdate.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: "FN-001" } as Task), 100)));

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      // Should show "Saving…" immediately
      expect(screen.getByText("Saving…")).toBeTruthy();
    });

    it("successful save shows toast and exits edit mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Updated FN-001", "success");
      });

      // Should exit edit mode
      expect(document.querySelector("#task-form-title")).toBeNull();
    });

    it("failed save shows toast with error and stays in edit mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Network error", "error");
      });

      // Should stay in edit mode
      expect(document.querySelector("#task-form-title")).toBeTruthy();
    });

    it("Escape key exits edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      expect(document.querySelector("#task-form-title")).toBeTruthy();

      // Press Escape (handled via document-level keydown listener)
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
        document.dispatchEvent(event);
      });

      // Should exit edit mode
      expect(document.querySelector("#task-form-title")).toBeNull();
    });

    it("edit mode shows both title and description fields", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // Both title and description should be present in TaskForm
      expect(document.querySelector("#task-form-title")).toBeTruthy();
      expect(document.querySelector("#task-form-description")).toBeTruthy();
    });

    it("edit mode renders model configuration and workflow steps", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // Model configuration is present via TaskForm in edit mode.
      // U6/R3: the per-step "Workflow Steps" section was removed from TaskForm;
      // workflow management for an existing task lives in the Workflow tab.
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.queryByText(/Workflow Steps/i)).toBeNull();
    });

    it("save sends only changed fields via updateTask", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", dependencies: ["FN-002"] })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const descTextarea = document.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(descTextarea, { target: { value: "Updated desc" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", {
          description: "Updated desc",
        }, undefined);
      });
    });

    it("includes priority in update payload only when changed", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", priority: "normal" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(document.querySelector("#task-priority") as HTMLSelectElement, { target: { value: "urgent" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
    });

    // FNXC:PlannerOversight 2026-07-04-00:00: the edit path clear-to-default contract — selecting a level sends the value, returning to Inherit sends null, no change emits nothing.
    it("emits plannerOversightLevel when changed from Inherit to a level", async () => {
      const { updateTask, fetchModels } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);
      vi.mocked(fetchModels).mockResolvedValue({
        models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 }],
        favoriteProviders: [],
        favoriteModels: [],
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // No change → no updateTask call.
      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      // Selecting a level sends that value.
      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      const select = await screen.findByTestId("planner-oversight-level-select");
      fireEvent.change(select, { target: { value: "observe" } });
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { plannerOversightLevel: "observe" }, undefined);
      });
    });

    it("emits plannerOversightLevel: null when changed from a level back to Inherit (clear-to-default)", async () => {
      const { updateTask, fetchModels } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);
      vi.mocked(fetchModels).mockResolvedValue({
        models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 }],
        favoriteProviders: [],
        favoriteModels: [],
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", plannerOversightLevel: "observe" as Task["plannerOversightLevel"] })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      const select = await screen.findByTestId("planner-oversight-level-select");
      expect(select).toHaveValue("observe");
      fireEvent.change(select, { target: { value: "" } });
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { plannerOversightLevel: null }, undefined);
      });
    });

    it("sends executionMode: \"fast\" when changed from standard to fast", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
    });

    it("sends executionMode: null when changed from fast to standard", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "standard" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
      });
    });

    it("keeps edit-mode optional workflow steps out of the fast-to-standard update payload", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "triage",
            title: "Test",
            description: "Desc",
            executionMode: "fast",
            enabledWorkflowSteps: ["code-review"],
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "standard" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
      });
      expect(mockUpdate.mock.calls[0]?.[1]).toEqual({ executionMode: null });
      expect(mockUpdate.mock.calls[0]?.[1]).not.toHaveProperty("enabledWorkflowSteps");
    });

    it("patches edit-mode standard-to-fast on a todo task without confirmation or replanning", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", title: "Test", description: "Desc", executionMode: "fast" }) as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", title: "Test", description: "Desc", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined));
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRebuild).not.toHaveBeenCalled();
    });

    it("confirms and replans when edit-mode executionMode changes on a todo task", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", title: "Test", description: "Desc", executionMode: null }) as Task);
      mockRebuild.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "triage", status: "needs-replan", executionMode: null }) as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "standard" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
          title: "Change execution mode and replan?",
        }));
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
        expect(mockRebuild).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockRebuild.mock.invocationCallOrder[0]);
    });

    it("omits executionMode from update payload when unchanged", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it("renders normalized priority in detail metadata", async () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: undefined })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-priority-option-normal")).toHaveAttribute("aria-pressed", "true");
    });

    it("renders priority select and execution mode toggle together and keeps both interactive", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate
        .mockResolvedValueOnce(makeTask({ id: "FN-001", column: "triage", priority: "urgent", executionMode: "standard" }) as Task)
        .mockResolvedValueOnce(makeTask({ id: "FN-001", column: "triage", priority: "urgent", executionMode: "fast" }) as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", priority: "high", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const menu = openTaskDetailActionsMenu();
      expect(menu).toContainElement(screen.getByTestId("detail-priority-option-high"));
      expect(menu).toContainElement(screen.getByTestId("detail-execution-mode-toggle"));

      chooseInlinePriority("urgent");
      await waitFor(() => expect(mockUpdate).toHaveBeenNthCalledWith(1, "FN-001", { priority: "urgent" }, undefined));
      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenNthCalledWith(2, "FN-001", { executionMode: "fast" }, undefined);
      });
    });

    it("updates priority inline and propagates successful save without moving triage tasks", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const onTaskUpdated = vi.fn();
      const addToast = vi.fn();
      const updatedTask = makeTask({
        id: "FN-001",
        column: "triage",
        status: "awaiting-approval",
        priority: "urgent",
      });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            description: "Priority metadata",
            priority: "normal",
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      chooseInlinePriority("urgent");

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
      expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
        id: "FN-001",
        column: "triage",
        status: "awaiting-approval",
        priority: "urgent",
      }));
      expect(addToast).toHaveBeenCalledWith("Priority updated to urgent", "success");
    });

    it("does not call updateTask when inline priority is unchanged", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: "high" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      chooseInlinePriority("high");

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it("reverts inline priority when save fails", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const addToast = vi.fn();
      mockUpdate.mockRejectedValueOnce(new Error("Request failed"));

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: "low" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      chooseInlinePriority("urgent");

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
      await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Request failed", "error"));
      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-priority-option-low")).toHaveAttribute("aria-pressed", "true");
    });

    it.each([
      ["desktop", undefined],
      ["mobile", "back"],
    ] as const)("patches a todo task from standard to fast in place on %s", async (_surface, mobileHeaderMode) => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      const addToast = vi.fn();
      const onTaskUpdated = vi.fn();
      const updatedTask = makeTask({ id: "FN-001", column: "todo", executionMode: "fast" });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          mobileHeaderMode={mobileHeaderMode}
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRebuild).not.toHaveBeenCalled();
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Execution mode updated to fast", "success");
    });

    it("cancels the retained fast-to-standard todo replan before update", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalled();
      });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRebuild).not.toHaveBeenCalled();
      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-execution-mode-toggle")).toHaveAttribute("aria-pressed", "true");
    });

    it.each([
      ["desktop", undefined],
      ["mobile", "back"],
    ] as const)("prompts and replans a todo task from fast to standard on %s", async (_surface, mobileHeaderMode) => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", executionMode: null }) as Task);
      mockRebuild.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "triage", status: "needs-replan", executionMode: null }) as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          mobileHeaderMode={mobileHeaderMode}
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
          message: "Changing execution mode for this task will move it back to Planning so Fusion can rebuild the plan for standard mode.",
        }));
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
        expect(mockRebuild).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockRebuild.mock.invocationCallOrder[0]);
    });

    it("patches an in-progress task from standard to fast without confirmation or replanning", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "in-progress", executionMode: "fast" }) as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "in-progress", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRebuild).not.toHaveBeenCalled();
    });

    it("updates triage inline execution mode without prompting or replanning", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      const addToast = vi.fn();
      const onTaskUpdated = vi.fn();
      const updatedTask = makeTask({ id: "FN-001", column: "triage", executionMode: "fast" });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRebuild).not.toHaveBeenCalled();
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Execution mode updated to fast", "success");
      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-execution-mode-toggle")).toHaveAttribute("aria-pressed", "true");
    });

    it("reverts to fast when the retained fast-to-standard replan fails after update", async () => {
      const { updateTask, rebuildTaskSpec } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockRebuild = vi.mocked(rebuildTaskSpec);
      const addToast = vi.fn();
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", executionMode: null }) as Task);
      mockRebuild.mockRejectedValueOnce(new Error("Replan failed"));

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "fast" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      openTaskDetailActionsMenu();
      fireEvent.click(screen.getByTestId("detail-execution-mode-toggle"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
        expect(mockRebuild).toHaveBeenCalledWith("FN-001", undefined);
      });
      await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Replan failed", "error"));
      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-execution-mode-toggle")).toHaveAttribute("aria-pressed", "true");
    });

    it("disables inline execution mode toggle while save is in-flight", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(makeTask({ executionMode: "fast" }) as Task), 100)),
      );

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", executionMode: "standard" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      openTaskDetailActionsMenu();
      const toggle = screen.getByTestId("detail-execution-mode-toggle");
      fireEvent.click(toggle);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      openTaskDetailActionsMenu();
      expect(screen.getByTestId("detail-execution-mode-toggle")).toBeDisabled();

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
    });

    it("renders no-commits-expected toggle in Details", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            noCommitsExpected: false,
            prompt: "# FN-001\n\n## Plan\n\nPlan marker text for ordering assertion.",
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const noCommitsCheckbox = screen.getByLabelText("No commits expected (decision-only task)");
      const noCommitsWrapper = noCommitsCheckbox.closest(".detail-section");
      expect(noCommitsWrapper).toBeTruthy();
      expect(document.querySelector(".detail-section--plan-prompt")).toBeNull();
      expect(document.querySelector(".detail-attachments-grid")).toBeNull();
    });

    it("toggles no-commits-expected checkbox and patches task", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", noCommitsExpected: true }) as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ id: "FN-001", column: "todo", noCommitsExpected: false })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByLabelText("No commits expected (decision-only task)"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { noCommitsExpected: true }, undefined);
      });
    });

    it("pre-populates form with existing task values", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", title: "My Task", description: "My Description" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const titleInput = document.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = document.querySelector("#task-form-description") as HTMLTextAreaElement;
      expect(titleInput.value).toBe("My Task");
      expect(descTextarea.value).toBe("My Description");
    });

    it("pre-populates working/base branch inputs and saves changed branch only", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "develop" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const workingBranchInput = document.querySelector("#task-working-branch") as HTMLInputElement;
      const baseBranchInput = document.querySelector("#task-base-branch") as HTMLInputElement;
      expect(workingBranchInput.value).toBe("feature/fn-3422");
      expect(baseBranchInput.value).toBe("develop");

      fireEvent.change(workingBranchInput, { target: { value: "feature/fn-3422-updated" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { branch: "feature/fn-3422-updated" }, undefined);
      });
    });

    it("saves changed baseBranch independently of branch", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "develop" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(document.querySelector("#task-base-branch") as HTMLInputElement, { target: { value: "release/2026-05" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { baseBranch: "release/2026-05" }, undefined);
      });
    });

    it("sends null branch fields when working/base branches are cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "main" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);
      fireEvent.change(document.querySelector("#task-working-branch") as HTMLInputElement, { target: { value: "" } });
      fireEvent.change(document.querySelector("#task-base-branch") as HTMLInputElement, { target: { value: "" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          "FN-001",
          expect.objectContaining({ branch: null, baseBranch: null }),
          undefined,
        );
      });
    });

    it("propagates auto-saved description updates via onTaskUpdated", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdateTask = vi.mocked(updateTask);
      const onTaskUpdated = vi.fn();

      const initialTask = makeTask({
        id: "FN-001",
        column: "todo",
        title: "My Task",
        description: "Old Description",
      });
      const updatedTask = {
        ...initialTask,
        description: "New Description",
      };

      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={initialTask}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={noop}
        />,
      );

      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      const descTextarea = document.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(descTextarea, { target: { value: "New Description" } });

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { description: "New Description" }, undefined);
        expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      }, { timeout: 3500 });
    });

    it("saves task-detail model changes with the active project id", async () => {
      const { fetchModels, updateTask } = await import("../../api");
      const mockFetchModels = vi.mocked(fetchModels);
      const mockUpdateTask = vi.mocked(updateTask);
      const user = userEvent.setup();

      const availableModels = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
      ];
      mockFetchModels.mockResolvedValue({
        models: availableModels,
        favoriteProviders: [],
        favoriteModels: [],
        providerInstances: {
          anthropic: { instances: [{ id: "anthropic-primary", isDefault: true }, { id: "anthropic-secondary", isDefault: false }] },
        },
      });

      const initialTask = makeTask({ id: "FN-001", column: "triage", title: "Model sync test" });
      const updatedAfterExecutor: Task = {
        ...initialTask,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        credentialInstanceId: null,
      };
      const updatedAfterExecutorInstance: Task = {
        ...updatedAfterExecutor,
        credentialInstanceId: "anthropic-secondary",
      };
      const updatedAfterValidator: Task = {
        ...updatedAfterExecutorInstance,
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
        validatorCredentialInstanceId: null,
      };

      mockUpdateTask
        .mockResolvedValueOnce(updatedAfterExecutor)
        .mockResolvedValueOnce(updatedAfterExecutorInstance)
        .mockResolvedValueOnce(updatedAfterValidator);

      const addToast = vi.fn();
      const onTaskUpdated = vi.fn((updated: Task) => {
        setStatefulTask((prev) => ({ ...prev, ...updated }));
      });
      let setStatefulTask: Dispatch<SetStateAction<TaskDetail>>;

      function StatefulModal() {
        const [task, setTask] = useState<TaskDetail>(initialTask);
        setStatefulTask = setTask;

        return (
          <TaskDetailModal
            initialTab="definition"
            task={task}
            projectId="project-alpha"
            onClose={noop}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            onTaskUpdated={onTaskUpdated}
            addToast={addToast}
          />
        );
      }

      const { container } = render(<StatefulModal />);

      await user.click(screen.getByText("Model"));
      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText("Executor Model"));
      await user.click(screen.getByText("Claude Sonnet 4.5"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          1,
          "FN-001",
          {
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            credentialInstanceId: null,
          },
          "project-alpha",
        );
      });

      await user.click(screen.getByLabelText("Executor Model"));
      await user.selectOptions(await screen.findByTestId("custom-model-dropdown-credential-instance"), "anthropic-secondary");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          2,
          "FN-001",
          {
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            credentialInstanceId: "anthropic-secondary",
          },
          "project-alpha",
        );
        expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
          credentialInstanceId: "anthropic-secondary",
        }));
      });

      await user.keyboard("{Escape}");
      await user.click(screen.getByLabelText("Reviewer Model"));
      await user.click(screen.getByText("GPT-4o"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          3,
          "FN-001",
          {
            validatorModelProvider: "openai",
            validatorModelId: "gpt-4o",
            validatorCredentialInstanceId: null,
          },
          "project-alpha",
        );
        expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
          validatorModelProvider: "openai",
          validatorModelId: "gpt-4o",
          validatorCredentialInstanceId: null,
        }));
        expect(addToast).not.toHaveBeenCalledWith(expect.any(String), "error");
      });

      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toHaveTextContent("Claude Sonnet 4.5");
        expect(screen.getByLabelText("Reviewer Model")).toHaveTextContent("GPT-4o");
      });
    });

    it("rolls back the scoped reviewer model change and shows one error toast on real failure", async () => {
      const { fetchModels, updateTask } = await import("../../api");
      const mockFetchModels = vi.mocked(fetchModels);
      const mockUpdateTask = vi.mocked(updateTask);
      const user = userEvent.setup();
      const addToast = vi.fn();

      mockFetchModels.mockResolvedValue({
        models: [
          { provider: "anthropic", id: "claude-haiku-5", name: "Claude Haiku 5", reasoning: true, contextWindow: 200000 },
          { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
        ],
        favoriteProviders: [],
        favoriteModels: [],
        providerInstances: {
          anthropic: { instances: [{ id: "anthropic-primary", isDefault: true }, { id: "anthropic-secondary", isDefault: false }] },
        },
      });
      mockUpdateTask.mockRejectedValueOnce(new Error("Task not found"));

      render(
        <TaskDetailModal
          initialTab="model"
          task={makeTask({
            id: "FN-001",
            column: "triage",
            title: "Scoped reviewer failure",
            validatorModelProvider: "anthropic",
            validatorModelId: "claude-haiku-5",
            validatorCredentialInstanceId: "anthropic-primary",
          })}
          projectId="project-alpha"
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={vi.fn()}
          addToast={addToast}
        />,
      );

      await waitFor(() => expect(screen.getByLabelText("Reviewer Model")).toBeInTheDocument());
      await user.click(screen.getByLabelText("Reviewer Model"));
      await user.click(await screen.findByText("GPT-4o"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          validatorModelProvider: "openai",
          validatorModelId: "gpt-4o",
          validatorCredentialInstanceId: null,
        }, "project-alpha");
        expect(addToast).toHaveBeenCalledTimes(1);
        expect(addToast).toHaveBeenCalledWith("Task not found", "error");
        expect(screen.getByLabelText("Reviewer Model")).toHaveTextContent("Claude Haiku 5");
      });

      await user.click(screen.getByLabelText("Reviewer Model"));
      expect(await screen.findByTestId("custom-model-dropdown-credential-instance")).toHaveValue("anthropic-primary");
    });

    it("renders Save and Cancel in the modal footer, not inside the edit form body", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // The edit form body should NOT contain the Save or Cancel action buttons
      const editForm = document.querySelector(".modal-edit-form");
      expect(editForm).toBeTruthy();
      const formButtons = Array.from(editForm!.querySelectorAll("button"));
      const formButtonTexts = formButtons.map((b) => b.textContent);
      expect(formButtonTexts).not.toContain("Save");
      expect(formButtonTexts).not.toContain("Cancel");
      expect(formButtonTexts).not.toContain("Saving…");

      // The modal-actions footer should contain the Save and Cancel buttons
      const modalActions = document.querySelector(".modal-actions");
      expect(modalActions).toBeTruthy();
      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).toContain("Cancel");
      expect(buttonTexts).toContain("Save");
    });

    it("renders keyboard hint in the modal footer when editing", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(document.querySelector(".modal-edit-btn")!);

      // The hint should be in the modal-actions footer, not inside the edit form body
      const editForm = document.querySelector(".modal-edit-form");
      expect(editForm!.querySelector(".modal-edit-hint")).toBeNull();

      const modalActions = document.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeTruthy();
    });

    it("shows normal modal actions (not edit actions) when not editing", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Should NOT be in edit mode — no edit hint, no Save/Cancel in footer
      const modalActions = document.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeNull();

      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).not.toContain("Save");
      expect(buttonTexts).not.toContain("Cancel");
      // The retained footer exposes Actions without a destination-column control.
      expect(buttonTexts).toContain("Actions");
      expect(container.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
    });
  });


  describe("comment state propagation (FN-845)", () => {
    it("passes onTaskUpdated to TaskComments when provided", async () => {
      const { addSteeringComment } = await import("../../api");
      const onTaskUpdated = vi.fn();
      const updatedTask = makeTask({
        comments: [{ id: "c1", text: "New comment", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      vi.mocked(addSteeringComment).mockResolvedValueOnce(updatedTask);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={noop}
        />,
      );

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Add a comment
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "New comment" } });
      fireEvent.click(screen.getByText("Add Comment"));

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-099", "New comment", undefined);
        expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      });
    });

    it("comment mutations still work when onTaskUpdated is not provided", async () => {
      const { addSteeringComment } = await import("../../api");
      const addToast = vi.fn();
      vi.mocked(addSteeringComment).mockResolvedValueOnce(makeTask({
        comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Add a comment — should succeed without error even without onTaskUpdated
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "Hello" } });
      fireEvent.click(screen.getByText("Add Comment"));

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-099", "Hello", undefined);
        expect(addToast).toHaveBeenCalledWith("Comment added", "success");
      });
    });
  });


  describe("agent assignment", () => {
    it("shows Assign Agent button when task has no assigned agent", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Assign Agent" })).toBeInTheDocument();
    });

    it("shows assigned agent chip and clear button when task has assignedAgentId", async () => {
      const { fetchAgent } = await import("../../api");
      vi.mocked(fetchAgent).mockResolvedValue({
        id: "agent-002",
        name: "Pipeline Helper",
        role: "executor",
        state: "active",
        metadata: {},
        heartbeatHistory: [],
        completedRuns: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as any);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ assignedAgentId: "agent-002" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Pipeline Helper")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Unassign agent" })).toBeInTheDocument();
      });
    });

    it("assigns selected agent via assignTask", async () => {
      const { fetchAgents, assignTask } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Task Runner",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);
      vi.mocked(assignTask).mockResolvedValue(makeTask({ assignedAgentId: "agent-001" }) as any);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Assign Agent" }));
      await userEvent.click(screen.getByRole("button", { name: /Task Runner/i }));

      await waitFor(() => {
        expect(assignTask).toHaveBeenCalledWith("FN-099", "agent-001", undefined);
      });
    });

    it("clears assigned agent via assignTask(null)", async () => {
      const { fetchAgent, assignTask } = await import("../../api");
      vi.mocked(fetchAgent).mockResolvedValue({
        id: "agent-005",
        name: "Doc Bot",
        role: "executor",
        state: "active",
        metadata: {},
        heartbeatHistory: [],
        completedRuns: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as any);
      vi.mocked(assignTask).mockResolvedValue(makeTask({ assignedAgentId: undefined }) as any);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ assignedAgentId: "agent-005" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Unassign agent" }));

      await waitFor(() => {
        expect(assignTask).toHaveBeenCalledWith("FN-099", null, undefined);
      });
    });
  });

  describe("optimistic opening with Task", () => {
    beforeEach(async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockReset();
    });

    it("renders immediately when opened with a Task prop (no prompt)", async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockResolvedValueOnce({
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Modal renders immediately without crashing
      /*
      FNXC:FloatingWindow 2026-07-30-06:40:
      `.modal-overlay` is no longer the modal shell — TaskDetailModal renders inside `FloatingWindow`,
      whose overlay class is `floating-window-overlay`. The only `.modal-overlay` left in this
      component is the unrelated REFINE overlay (TaskDetailModal.tsx:6612), so this assertion was
      looking for a different element entirely. Asserting the modal's own shell class instead, which
      is what "renders immediately" is actually about.
      */
      expect(document.querySelector(".task-detail-modal")).toBeTruthy();
      expect(screen.getByText("FN-200")).toBeDefined();
    });

    it("calls fetchTaskDetail on mount when prop is Task without prompt", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockResolvedValueOnce({
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-201", undefined);
      });
    });

    it("does NOT call fetchTaskDetail when prop is already a TaskDetail with prompt", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const detail: TaskDetail = {
        id: "FN-202",
        description: "Full detail task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Full spec",
      } as TaskDetail;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={detail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Give a tick for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).not.toHaveBeenCalledWith("FN-202", undefined);
    });

    it("shows loading state in spec area when detailLoading is true", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      // Set up a pending promise so loading state persists
      mockFetch.mockResolvedValueOnce(new Promise(() => {}) as any);

      const task: Task = {
        id: "FN-203",
        description: "Loading spec test",
        column: "todo",
        dependencies: [],
        steps: [{ name: "Plan", status: "in-progress" }],
        currentStep: 0,
        log: [{ timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] setup in 120ms" }],
        executionMode: "fast",
        status: "executing",
        assignedAgentId: "agent-loading",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Loading specification…")).toBeDefined();
      // Token stats now live in their own Stats tab — switch to it before
      // asserting on token-loading text.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Loading token statistics…")).toBeDefined();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expectSingleStatsRuntimeStatus("executing");
    });

    it("shows spec content after fetchTaskDetail resolves", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-204",
        description: "Async spec test",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const fullDetail: TaskDetail = {
        ...task,
        prompt: "# Async Spec\n\nThis is the loaded spec content.",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] prepare env in 120ms" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "[timing] run tests in 3400ms" },
        ],
        workflowStepResults: [
          {
            workflowStepId: "WS-101",
            workflowStepName: "Workflow QA",
            status: "passed",
            startedAt: "2026-04-24T09:10:00.000Z",
            completedAt: "2026-04-24T09:10:07.000Z",
          },
        ],
        executionMode: "fast",
        status: "executing",
        mergeRetries: 1,
        workflowStepRetries: 2,
        recoveryRetryCount: 3,
        taskDoneRetryCount: 4,
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 450,
          cachedTokens: 210,
          totalTokens: 1860,
          firstUsedAt: "2026-04-24T09:00:00.000Z",
          lastUsedAt: "2026-04-24T10:15:00.000Z",
        },
      } as TaskDetail;

      // Resolve with full detail
      mockFetch.mockResolvedValueOnce(fullDetail);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows loading
      expect(screen.getByText("Loading specification…")).toBeDefined();

      // After fetch resolves, spec content appears
      await waitFor(() => {
        const markdownBody = document.querySelector(".markdown-body");
        expect(markdownBody).toBeTruthy();
      }, { timeout: 3000 });

      // Loading indicator should be gone
      expect(screen.queryByText("Loading specification…")).toBeNull();

      // Token stats live behind the Stats tab now.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.queryByText("Loading token statistics…")).toBeNull();
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Timing events")).toBeInTheDocument();
      expect(screen.getByText("Workflow runtime")).toBeInTheDocument();
      expect(screen.getByText("Execution mode")).toBeInTheDocument();
      expect(screen.getByText("Runtime status")).toBeInTheDocument();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expectSingleStatsRuntimeStatus("executing");
      expect(screen.getAllByText((1200).toLocaleString()).length).toBeGreaterThan(0);
      expect(screen.getAllByText((450).toLocaleString()).length).toBeGreaterThan(0);
      expect(screen.getAllByText((210).toLocaleString()).length).toBeGreaterThan(0);
      expect(screen.getAllByText((1860).toLocaleString()).length).toBeGreaterThan(0);
      const firstUsed = document.querySelector('time[datetime="2026-04-24T09:00:00.000Z"]');
      const lastUsed = document.querySelector('time[datetime="2026-04-24T10:15:00.000Z"]');
      expect(firstUsed).toBeTruthy();
      expect(lastUsed).toBeTruthy();
    });

    it("preserves fullDetail.log when SSE-stripped task prop has empty log", async () => {
      // Regression: SSE strips `log` to [] in task list payloads (see
      // stripTaskListHeavyFields in packages/dashboard/src/sse.ts). The modal
      // merges live `task` over `fullDetail` to keep tokenUsage/status fresh,
      // which previously clobbered fullDetail.log and emptied the Activity tab.
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const strippedTask: Task = {
        id: "FN-LOG-1",
        description: "SSE stripped task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValue({
        ...strippedTask,
        prompt: "# Spec",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "Created task" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "Started executor", outcome: "OK" },
        ],
      } as TaskDetail);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={strippedTask}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Wait for fetchTaskDetail to resolve.
      await waitFor(() => {
        expect(document.querySelector(".markdown-body")).toBeTruthy();
      }, { timeout: 3000 });

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));

      const activityList = document.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();
      const logEntries = document.querySelectorAll(".detail-log-entry");
      expect(logEntries).toHaveLength(2);
      expect(logEntries[0].textContent).toContain("Started executor");
      expect(logEntries[1].textContent).toContain("Created task");
    });

    it("shows token stats empty state once detail is loaded without usage", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-205",
        description: "No token stats",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      mockFetch.mockResolvedValueOnce({
        ...task,
        prompt: "# Async Spec\n\nSpec without usage.",
        tokenUsage: undefined,
      } as TaskDetail);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Token stats live behind the Stats tab now — wait for the modal to
      // settle, then switch tabs and assert on the empty state.
      await waitFor(() => {
        expect(screen.queryByText("Loading specification…")).toBeNull();
      });
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      await waitFor(() => {
        expect(screen.getByText("No token usage recorded for this task yet.")).toBeInTheDocument();
      });
    });
  });

  describe("PluginSlot integration", () => {
    it("renders plugin tabs when plugins register for task-detail-tab slot", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ],
        getSlotsForId: (id: string) => id === "task-detail-tab" ? [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ] : [],
        loading: false,
        error: null,
      } as any);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Both plugin tabs should appear
      expect(screen.getByText("Plugin A Tab")).toBeDefined();
      expect(screen.getByText("Plugin B Tab")).toBeDefined();
    });

    it("shows only the selected plugin tab content when plugin tab is clicked", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ],
        getSlotsForId: (id: string) => id === "task-detail-tab" ? [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ] : [],
        loading: false,
        error: null,
      } as any);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      await userEvent.click(screen.getByText("Plugin B Tab"));

      const slots = document.querySelectorAll('[data-slot-id="task-detail-tab"]');
      expect(slots).toHaveLength(1);
      expect(slots[0]).toHaveAttribute("data-plugin-id", "plugin-b");
      expect(document.querySelector('[data-plugin-id="plugin-a"]')).toBeNull();
    });

    it("renders no extra tabs when no plugins register", () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [],
        getSlotsForId: vi.fn(() => []),
        loading: false,
        error: null,
      });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Only standard tabs should be visible (Activity, Plan, etc.) without the legacy top-level Logs tab.
      expect(screen.getByText("Plan")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
      // Plugin tabs should not exist
      expect(screen.queryByText("Plugin A Tab")).toBeNull();
    });
  });

  describe("github tracking section", () => {
    const expandGithubTracking = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
      return screen.findByRole("button", { name: "Collapse GitHub tracking details" });
    };

    it("renders after the prompt/spec section in read mode", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            prompt: "# FN-001\n\nPrompt content before tracking metadata.",
            githubTracking: {
              enabled: true,
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("GitHub tracking")).toBeInTheDocument();
      expect(screen.queryByText("Prompt content before tracking metadata.")).toBeNull();
    });

    it("renders linked issue as link when url exists", async () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            githubTracking: {
              enabled: true,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 123,
                url: "https://github.com/runfusion/fusion/issues/123",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
            issueInfo: { url: "https://github.com/runfusion/fusion/issues/123", number: 123, state: "open", title: "Issue" },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("GitHub tracking")).toBeTruthy();
      expect(screen.getByLabelText("GitHub tracking status")).toHaveTextContent("Linked");
      expect(screen.queryByRole("link", { name: "runfusion/fusion#123" })).toBeNull();

      const collapseToggle = await expandGithubTracking();

      expect(collapseToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "runfusion/fusion#123" })).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/123");
    });

    it("preserves fetched githubTracking detail when the optimistic task prop came from a slim restart listing", async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockResolvedValueOnce(
        makeTask({
          id: "FN-301",
          column: "todo",
          prompt: "# Spec",
          githubTracking: {
            enabled: true,
            repoOverride: "runfusion/fusion",
            issue: {
              owner: "runfusion",
              repo: "fusion",
              number: 301,
              url: "https://github.com/runfusion/fusion/issues/301",
              createdAt: "2026-01-01T00:00:00Z",
            },
          },
        }),
      );

      const optimisticTask = makeTask({ id: "FN-301", column: "todo" }) as Task;
      delete (optimisticTask as Partial<Task>).prompt;
      delete (optimisticTask as Partial<Task>).githubTracking;

      render(
        <TaskDetailModal
          initialTab="details"
          task={optimisticTask}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        // FN-4161 repro: the optimistic task prop came from a slim restart listing,
        // so fetched full detail must win when the prop omits githubTracking.
        expect(screen.getByLabelText("GitHub tracking status")).toHaveTextContent("Linked");
      });

      await expandGithubTracking();
      expect(await screen.findByDisplayValue("runfusion/fusion")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "runfusion/fusion#301" })).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/301");
    });

    it("shows section when tracking is disabled and task is in an eligible column", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ column: "todo", githubTracking: { enabled: false } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("GitHub tracking")).toBeTruthy();
      expect(screen.getByText("Tracking is currently disabled")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Enable GitHub tracking" })).toHaveTextContent("Enable");
    });

    it("FN-4228 shows loading state instead of disabled CTA while detail fetch is unresolved", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      let resolveFetch: ((value: TaskDetail) => void) | undefined;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const optimisticTask = makeTask({ id: "FN-001", column: "todo" });
      delete (optimisticTask as Partial<Task>).prompt;
      delete (optimisticTask as Partial<Task>).githubTracking;

      render(
        <TaskDetailModal
          initialTab="details"
          task={optimisticTask}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByLabelText("GitHub tracking status")).toHaveTextContent("Loading");
      expect(screen.getByText("Checking tracking status")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Enable GitHub tracking" })).toBeNull();
      expect(screen.getByRole("status", { name: "Loading GitHub tracking status" })).toBeInTheDocument();

      await act(async () => {
        resolveFetch?.({
          ...(makeTask({ id: "FN-001", column: "todo" }) as TaskDetail),
          prompt: "# Spec",
          githubTracking: { enabled: false },
        });
      });

      await waitFor(() => {
        expect(screen.getByLabelText("GitHub tracking status")).toHaveTextContent("Disabled");
      });
      expect(screen.getByText("Tracking is currently disabled")).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Loading GitHub tracking status" })).toBeNull();
      expect(screen.getByRole("button", { name: "Enable GitHub tracking" })).toBeInTheDocument();
    });

    it("enables GitHub tracking via the inline header button without expanding the disclosure", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const addToast = vi.fn();
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: false,
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={addToast}
        />,
      );

      const expandButton = screen.getByRole("button", { name: "Expand GitHub tracking details" });
      expect(expandButton).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(screen.getByRole("button", { name: "Enable GitHub tracking" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: true } }, undefined);
      });
      expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("Failed to update FN-001"), "error");
      expect(screen.getByRole("button", { name: "Expand GitHub tracking details" })).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: "Collapse GitHub tracking details" })).toBeNull();
    });

    it("FN-4228 keeps the inline enable button mounted and disabled while saving", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      let resolveUpdate: ((task: Task) => void) | undefined;
      mockUpdate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpdate = resolve;
          }),
      );

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: false,
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Enable GitHub tracking" }));

      const enableButton = await screen.findByRole("button", { name: "Enable GitHub tracking" });
      expect(enableButton).toBeDisabled();
      expect(screen.getByRole("status", { name: "Enabling GitHub tracking" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Expand GitHub tracking details" })).toHaveAttribute("aria-expanded", "false");

      resolveUpdate?.({
        id: "FN-001",
        githubTracking: {
          enabled: true,
          issue: {
            number: 42,
            title: "Tracked issue",
            url: "https://github.com/runfusion/fusion/issues/42",
            state: "open",
          },
        },
      } as Task);

      await waitFor(() => {
        expect(screen.queryByRole("status", { name: "Enabling GitHub tracking" })).toBeNull();
      });
    });

    it("hides the inline enable button when tracking is already enabled", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ column: "todo", githubTracking: { enabled: true } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.queryByRole("button", { name: "Enable GitHub tracking" })).toBeNull();
      expect(screen.getByRole("button", { name: "Expand GitHub tracking details" })).toBeInTheDocument();
    });

    it("hides the inline enable button when an issue is already linked", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            column: "todo",
            githubTracking: {
              enabled: false,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 456,
                url: "https://github.com/runfusion/fusion/issues/456",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.queryByRole("button", { name: "Enable GitHub tracking" })).toBeNull();
      expect(screen.getByRole("button", { name: "Expand GitHub tracking details" })).toBeInTheDocument();
    });

    it("mobile layout keeps the enable button in source order without width forcing at the 768px breakpoint", () => {
      const css = loadAllAppCss();
      const mobileCss = getMediaBlocks(css, "@media (max-width: 768px)").join("\n");
      const enableRule = getRuleBlock(mobileCss, ".detail-github-tracking-enable");
      const headerRule = getRuleBlock(mobileCss, ".detail-source-header");
      const githubSummaryRule = getRuleBlockFromSelectorList(mobileCss, ".detail-github-tracking-section .detail-source-summary");
      const sourceSummaryRule = getRuleBlock(mobileCss, ".detail-source-section .detail-source-summary");

      expect(mobileCss).toBeTruthy();
      expect(enableRule).toBeTruthy();
      expect(headerRule).toBeTruthy();
      expect(githubSummaryRule).toBeTruthy();
      expect(sourceSummaryRule).toBeTruthy();
      expect(enableRule).not.toMatch(/\border\s*:/);
      expect(enableRule).not.toMatch(/\bwidth\s*:\s*100%/);
      expect(headerRule).toMatch(/\bflex-wrap\s*:\s*wrap/);
      expect(githubSummaryRule).toMatch(/\bflex\s*:\s*1\s+1\s+auto/);
      expect(githubSummaryRule).toMatch(/\bmin-width\s*:\s*0/);
      expect(githubSummaryRule).not.toMatch(/\bflex\s*:\s*1\s+1\s+100%/);
      expect(githubSummaryRule).not.toMatch(/\bflex-basis\s*:\s*100%/);
      expect(githubSummaryRule).not.toMatch(/\bwidth\s*:\s*100%/);
      expect(sourceSummaryRule).toMatch(/\bflex\s*:\s*1\s+1\s+auto/);
    });

    it("hides section when tracking is disabled and task is not in an eligible column", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ column: "done", githubTracking: { enabled: false } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("GitHub tracking")).toBeNull();
    });

    it("shows create tracking issue action for enabled but unlinked tasks outside editable columns", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const onTaskUpdated = vi.fn();
      const addToast = vi.fn();
      const updatedTask = makeTask({
        id: "FN-001",
        column: "done",
        githubTracking: {
          enabled: true,
          issue: {
            owner: "runfusion",
            repo: "fusion",
            number: 77,
            url: "https://github.com/runfusion/fusion/issues/77",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ id: "FN-001", column: "done", githubTracking: { enabled: true } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      await expandGithubTracking();
      fireEvent.click(screen.getByRole("button", { name: "Create tracking issue" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: true } }, undefined);
      });
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Requested GitHub tracking issue creation", "info");
      expect(screen.queryByLabelText("Enable GitHub tracking")).toBeNull();
    });

    it("sends githubTracking disabled→enabled toggle payload", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: false,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 99,
                url: "https://github.com/runfusion/fusion/issues/99",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await expandGithubTracking();

      const toggle = screen.getByLabelText("Enable GitHub tracking") as HTMLInputElement;
      expect(toggle.checked).toBe(false);

      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: true } }, undefined);
      });
      expect(toggle.checked).toBe(true);
    });

    it("sends githubTracking enabled→disabled toggle payload", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "in-progress",
            githubTracking: {
              enabled: true,
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await expandGithubTracking();

      fireEvent.click(screen.getByLabelText("Enable GitHub tracking"));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: false } }, undefined);
      });
    });

    it("keeps disabled githubTracking state sticky across follow-up sparse task prop updates", async () => {
      const { updateTask, fetchTaskDetail } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const mockFetchTaskDetail = vi.mocked(fetchTaskDetail);
      const baseTask = makeTask({
        id: "FN-001",
        title: "Tracking task",
        column: "in-progress",
        githubTracking: {
          enabled: true,
          repoOverride: "runfusion/fusion",
          issue: {
            owner: "runfusion",
            repo: "fusion",
            number: 200,
            url: "https://github.com/runfusion/fusion/issues/200",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      });

      mockFetchTaskDetail.mockResolvedValue(baseTask);
      mockUpdate.mockResolvedValueOnce({
        ...baseTask,
        githubTracking: {
          enabled: false,
          repoOverride: "runfusion/fusion",
        },
      } as Task);

      let signalSparseUpdate!: () => void;
      const sparseUpdateApplied = new Promise<void>((resolve) => {
        signalSparseUpdate = resolve;
      });

      function Harness(): JSX.Element {
        const [taskState, setTaskState] = useState(baseTask);

        return (
          <TaskDetailModal
            initialTab="details"
            task={taskState}
            onClose={noop}
            onOpenDetail={noopOpenDetail}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onTaskUpdated={(nextTask) => {
              setTaskState(nextTask as TaskDetail);
              setTimeout(() => {
                setTaskState((current) => ({
                  ...current,
                  githubTracking: undefined,
                }));
                signalSparseUpdate();
              }, 0);
            }}
            addToast={noop}
          />
        );
      }

      render(<Harness />);

      await expandGithubTracking();
      const toggle = screen.getByRole("checkbox", { name: "Enable GitHub tracking" }) as HTMLInputElement;
      expect(toggle.checked).toBe(true);

      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: false } }, undefined);
      });

      await sparseUpdateApplied;

      await waitFor(() => {
        expect((screen.getByRole("checkbox", { name: "Enable GitHub tracking" }) as HTMLInputElement).checked).toBe(false);
      });

      expect(screen.queryByRole("button", { name: /create tracking issue/i })).not.toBeInTheDocument();
    });

    it("sends repo override updates and null when cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ id: "FN-001", column: "todo", githubTracking: { enabled: true, repoOverride: "runfusion/fusion" } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await expandGithubTracking();

      fireEvent.change(screen.getByPlaceholderText("owner/repo"), { target: { value: "runfusion/cli" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { repoOverride: "runfusion/cli" } }, undefined);
      });

      fireEvent.change(screen.getByPlaceholderText("owner/repo"), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { repoOverride: null } }, undefined);
      });
    });

    it("unlinks issue after confirm and skips on cancel", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      mockConfirm.mockResolvedValueOnce(false);
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: true,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 200,
                url: "https://github.com/runfusion/fusion/issues/200",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await expandGithubTracking();

      fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub issue" }));
      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalledWith("FN-001", { githubTracking: { issue: null } }, undefined);
      });

      mockConfirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub issue" }));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { issue: null } }, undefined);
      });
    });
  });
});

describe("TaskDetailModal footer quick-action parity (FN-8194)", () => {
  const renderDetail = (task: Task) => render(
    <TaskDetailModal
      initialTab="details"
      task={task}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );

  it("uses the existing file input and preserves Quick Add action order", async () => {
    renderDetail(makeTask({ id: "FN-8194", column: "todo", plannerOversightLevel: "observe" }));

    const menu = openTaskDetailActionsMenu();
    const attach = screen.getByTestId("detail-inline-attach");
    const github = screen.getByTestId("detail-inline-github-toggle");
    const oversight = await screen.findByTestId("detail-actions-oversight-heading");
    const priority = screen.getByTestId("detail-actions-priority-heading");
    const fast = screen.getByTestId("detail-execution-mode-toggle");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const fileInputClick = vi.spyOn(fileInput, "click");

    for (const [before, after] of [[attach, github], [github, oversight], [oversight, priority], [priority, fast]]) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(menu).toContainElement(attach);
    fireEvent.click(attach);
    expect(fileInputClick).toHaveBeenCalledOnce();
  });

  it("opens the shared file picker from Activity without rendering Definition", () => {
    render(
      <TaskDetailModal
        initialTab="chat"
        task={makeTask({ id: "FN-8232", column: "todo" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(fileInputs).toHaveLength(1);
    const fileInputClick = vi.spyOn(fileInputs[0], "click");

    openTaskDetailActionsMenu();
    fireEvent.click(screen.getByTestId("detail-inline-attach"));

    expect(fileInputClick).toHaveBeenCalledOnce();
  });

  it("toggles GitHub tracking through the existing update path and reflects enabled state", async () => {
    const { updateTask } = await import("../../api");
    const mockUpdate = vi.mocked(updateTask);
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-8194", column: "todo", githubTracking: { enabled: true } }) as Task);

    renderDetail(makeTask({ id: "FN-8194", column: "todo", githubTracking: { enabled: false } }));

    openTaskDetailActionsMenu();
    const toggle = screen.getByTestId("detail-inline-github-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-8194", { githubTracking: { enabled: true } }, undefined);
    });
    openTaskDetailActionsMenu();
    await waitFor(() => expect(screen.getByTestId("detail-inline-github-toggle")).toHaveAttribute("aria-pressed", "true"));
  });

  it("enables GitHub tracking for Ideas intake tasks after workflow metadata fails", async () => {
    const { updateTask, fetchBoardWorkflows } = await import("../../api");
    const mockUpdate = vi.mocked(updateTask);
    vi.mocked(fetchBoardWorkflows).mockRejectedValueOnce(new Error("workflow metadata unavailable"));
    mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-ideas", column: "ideas", githubTracking: { enabled: true } }) as Task);

    renderDetail(makeTask({ id: "FN-ideas", column: "ideas", githubTracking: { enabled: false } }));

    openTaskDetailActionsMenu();
    const toggle = screen.getByTestId("detail-inline-github-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("FN-ideas", { githubTracking: { enabled: true } }, undefined);
    });
    openTaskDetailActionsMenu();
    await waitFor(() => expect(screen.getByTestId("detail-inline-github-toggle")).toHaveAttribute("aria-pressed", "true"));
  });

  it("shows the GitHub toggle after Coding (Ideas) workflow metadata resolves", async () => {
    const { fetchBoardWorkflows } = await import("../../api");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "done", name: "Done", flags: {} }] },
        { id: "builtin:coding-ideas-v2", name: "Coding (Ideas)", columns: [{ id: "done", name: "Done", flags: {} }] },
      ],
      taskWorkflowIds: { "FN-ideas-workflow": "builtin:coding-ideas-v2" },
    });

    renderDetail(makeTask({ id: "FN-ideas-workflow", column: "done", githubTracking: { enabled: false } }));

    openTaskDetailActionsMenu();
    expect(screen.queryByTestId("detail-inline-github-toggle")).not.toBeInTheDocument();
    expect(await screen.findByTestId("detail-inline-github-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the GitHub toggle for unrelated and GitLab-tracked tasks", () => {
    const { unmount } = renderDetail(makeTask({ id: "FN-8194", column: "done", githubTracking: { enabled: true } }));
    openTaskDetailActionsMenu();
    expect(screen.queryByTestId("detail-inline-github-toggle")).not.toBeInTheDocument();
    unmount();

    renderDetail(makeTask({
      id: "FN-8195",
      column: "ideas",
      gitlabTracking: {
        item: {
          kind: "project_issue",
          projectPath: "acme/app",
          iid: 1,
          title: "GitLab issue",
          url: "https://gitlab.com/acme/app/-/issues/1",
          state: "opened",
        },
      },
    }) as Task);
    openTaskDetailActionsMenu();
    expect(screen.queryByTestId("detail-inline-github-toggle")).not.toBeInTheDocument();
  });
});

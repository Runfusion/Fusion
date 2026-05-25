import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  mockConfirmWithChoice,
  mockConfirmWithCheckbox,
  mockUsePluginUiSlots,
  expectBaseRule,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  describe("mobile responsive structure", () => {
    it("keeps inline metadata controls in a single row without a narrow-screen column fallback", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-meta-inline-controls", "display: flex;");
      expectBaseRule(css, ".detail-meta-inline-controls", "flex-wrap: nowrap;");
      expect(css).not.toMatch(/@media \(max-width: 640px\)\s*\{[^}]*\.detail-meta-inline-controls\s*\{[^}]*flex-direction:\s*column;/);
    });

    it("keeps grouped timestamp metadata inline on desktop and mobile", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-timestamps", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamps", "flex-wrap: nowrap;");
      expectBaseRule(css, ".detail-timestamp-item", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamp-separator", "color: var(--text-dim);");

      expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.detail-timestamps\s*\{[^}]*align-items:\s*center;[^}]*flex-wrap:\s*nowrap;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-timestamps\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-timestamp-separator\s*\{[^}]*display:\s*none;/);
    });
    it("renders responsive structural classes (modal-lg, overlay, spacer, tabs, detail-body)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(container.querySelector(".modal.modal-lg")).toBeTruthy();
      expect(container.querySelector(".modal-overlay.open")).toBeTruthy();
      expect(container.querySelector(".modal-actions .modal-actions-spacer")).toBeTruthy();
      expect(container.querySelector(".detail-body")).toBeTruthy();
      expect(container.querySelector(".detail-timestamps")).toBeTruthy();
      expect(container.querySelectorAll(".detail-timestamp-item").length).toBe(2);
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(10);
      expect(tabs[0].classList.contains("detail-tab-active")).toBe(true);
      expect(Array.from(tabs).slice(1).every((t) => !t.classList.contains("detail-tab-active"))).toBe(true);
      // Responsive CSS controls sizing — no inline padding/fontSize/borderBottom leaks
      expect((tabs[0] as HTMLElement).style.padding).toBe("");
      expect((tabs[0] as HTMLElement).style.fontSize).toBe("");
      expect((container.querySelector(".detail-tabs") as HTMLElement).style.borderBottom).toBe("");
    });

    it("modal-actions contains Delete and Pause buttons for non-done tasks (via Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Actions are now in a dropdown - open it first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Now the dropdown items should be visible
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Pause" })).toBeTruthy();
    });

    it("passes githubIssueAction for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);

      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask({
            githubTracking: {
              enabled: true,
              issue: {
                owner: "owner",
                repo: "repo",
                number: 42,
                url: "https://github.com/owner/repo/issues/42",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "close", allowResurrection: false });
      });
    });

    it("passes githubIssueAction=delete for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "delete", allowResurrection: false });
      });
    });

    it("passes githubIssueAction=leave for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "leave", allowResurrection: false });
      });
    });

    it("keeps legacy delete payload for untracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: false });
      });
    });

    it("prompts for dependency-removal confirmation and retries delete with explicit flag", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-100, FN-101.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100", "FN-101"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenNthCalledWith(1, {
          title: "Linked GitHub Issue",
          message: "Choose what to do with owner/repo#42 when deleting FN-099.\n\nClose the issue?",
          confirmLabel: "Close Issue",
          cancelLabel: "More Options",
        });
        expect(mockConfirm).toHaveBeenNthCalledWith(2, {
          title: "Delete Linked GitHub Issue",
          message: "Delete owner/repo#42 on GitHub, or leave it unchanged?",
          confirmLabel: "Delete Issue",
          cancelLabel: "Leave Unchanged",
          danger: true,
        });
        expect(mockConfirm).toHaveBeenNthCalledWith(3, {
          title: "Force Delete Task",
          message: "FN-099 is a dependency of FN-100, FN-101.\n\nDelete anyway by removing these dependency references first?",
          danger: true,
        });
      });

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-099", { githubIssueAction: "delete", allowResurrection: false });
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction: "delete",
          allowResurrection: false,
        });
        expect(noop).toHaveBeenCalledWith("Deleted FN-099 after removing dependency references", "info");
      });
    });

    it("does not retry delete when dependency-removal confirmation is canceled", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-102.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-102"] };
      onDeleteTask.mockRejectedValue(conflict);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(1);
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
    });

    it("does not retry delete when lineage-force confirmation is canceled", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a lineage parent by FN-104.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-104"] };
      onDeleteTask.mockRejectedValue(conflict);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(2);
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
    });

    it("shows error when dependency-removal retry fails", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-103.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-103"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(new Error("Retry failed"));

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          allowResurrection: false,
        });
        expect(noop).toHaveBeenCalledWith("Retry failed", "error");
      });
    });

    it("retries delete after lineage-conflict confirmation", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a lineage parent by FN-103.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-103"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction: "close",
          allowResurrection: false,
        });
      });
    });

    it("retries archive after lineage-conflict confirmation", async () => {
      const onArchiveTask = vi.fn();
      const conflict = new Error("Cannot archive task FN-099: still referenced as a lineage parent by FN-201.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-201"] };
      onArchiveTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          task={makeTask({ column: "done" as any })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onArchiveTask={onArchiveTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenNthCalledWith(2, "FN-099", { removeLineageReferences: true });
      });
    });

    it("does not retry archive when lineage-force confirmation is canceled", async () => {
      const onArchiveTask = vi.fn();
      const conflict = new Error("Cannot archive task FN-099: still referenced as a lineage parent by FN-202.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-202"] };
      onArchiveTask.mockRejectedValue(conflict);
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          task={makeTask({ column: "done" as any })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onArchiveTask={onArchiveTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledTimes(1);
        expect(mockConfirm).toHaveBeenCalledTimes(1);
      });
    });

    it("in-review modal-actions contains Merge & Close and Back to In Progress buttons", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Merge & Close")).toBeTruthy();

      // Back to In Progress is in secondary move options
      fireEvent.click(document.querySelector(".detail-move-btn__arrow")!);
      expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();
    });

    it("keeps Merge & Close when pull-request strategy has autoMerge enabled", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: true,
      });

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByRole("button", { name: "Merge & Close" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Start PR Review" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Check PR Status" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Finish & Close" })).toBeNull();
    });

    it("shows Start PR Review and calls onMergeTask for pull-request strategy when autoMerge is off and no PR exists", async () => {
      const { fetchSettings } = await import("../../api");
      const onMergeTask = vi.fn(async () => ({ merged: false } as MergeResult));
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={onMergeTask}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = await screen.findByRole("button", { name: "Start PR Review" });
      fireEvent.click(button);

      await waitFor(() => {
        expect(onMergeTask).toHaveBeenCalledWith("FN-099");
      });
    });

    it.each([
      [{ status: "open" as const }, "Check PR Status"],
      [{ status: "merged" as const }, "Finish & Close"],
    ])("shows %s footer label in manual PR flow", async (prInfoStatus, expectedLabel) => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });

      render(
        <TaskDetailModal
          task={makeTask({
            column: "in-review" as Column,
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: prInfoStatus.status,
              title: "Task",
              headBranch: "fusion/fn-099",
              baseBranch: "main",
              commentCount: 0,
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByRole("button", { name: expectedLabel })).toBeTruthy();
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows linked PR number in detail metadata for in-review tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column, prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "Task",
            headBranch: "fusion/fn-099",
            baseBranch: "main",
            commentCount: 0,
          } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
    });

    it("shows linked PR number in merge details for done tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "done" as Column,
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "merged",
              title: "Task",
              headBranch: "fusion/fn-099",
              baseBranch: "main",
              commentCount: 0,
            },
            mergeDetails: { prNumber: 42 },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const links = screen.getAllByRole("link", { name: "#42" });
      expect(links.length).toBeGreaterThan(0);
      expect(links[0]).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
    });

    it("shows PR automation waiting label instead of Merge & Close when awaiting PR checks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column, status: "awaiting-pr-checks", prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "Task",
            headBranch: "fusion/fn-099",
            baseBranch: "main",
            commentCount: 0,
          } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Awaiting PR checks") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows Creating PR label while PR-first automation is creating a PR", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column, status: "creating-pr" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Creating PR…") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });
  });

  describe("dependency dropdown search", () => {
    const searchTasks: Task[] = [
      { id: "FN-010", title: "Fix login bug", description: "Users cannot log in", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-020", title: "Add dark mode", description: "Theme support", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "FN-030", title: "Refactor API", description: "Clean up endpoints", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    function renderWithSearch(taskOverrides: Partial<TaskDetail> = {}) {
      return render(
        <TaskDetailModal
          task={makeTask(taskOverrides)}
          tasks={searchTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    it("shows search input when dropdown is opened", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.placeholder).toBe("Search tasks…");
    });

    it("filters tasks by search term", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-010");
    });

    it("matches task ID case-insensitively", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "fn-020" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-020");
    });

    it("matches task title", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "dark mode" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-020");
    });

    it("shows empty state when search matches nothing", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "zzz-nonexistent" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(0);
      expect(document.querySelector(".dep-dropdown-empty")?.textContent).toBe("No available tasks");
    });

    it("resets search when dropdown closes and reopens", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });
      expect(input.value).toBe("login");

      // Close by clicking again
      fireEvent.click(screen.getByText("Add Dependency"));
      expect(document.querySelector(".dep-dropdown")).toBeNull();

      // Reopen
      fireEvent.click(screen.getByText("Add Dependency"));
      const newInput = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(newInput.value).toBe("");
      // All items visible again
      expect(document.querySelectorAll(".dep-dropdown-item")).toHaveLength(3);
    });
  });

  describe("clickable dependency links", () => {
    it("renders dependency list items with clickable class and ID + label", () => {
      // Provide tasks prop to enable title lookup
      const allTasks: Task[] = [
        { id: "FN-001", title: "Fix login bug", description: "Login broken", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-002", title: "Add tests", description: "Test coverage", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLinks = container.querySelectorAll(".detail-dep-link");
      expect(depLinks).toHaveLength(2);

      // Check detail-dep-id elements
      const depIds = container.querySelectorAll(".detail-dep-id");
      expect(depIds).toHaveLength(2);
      expect(depIds[0].textContent).toBe("FN-001");
      expect(depIds[1].textContent).toBe("FN-002");

      // Check detail-dep-label elements
      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(2);
      expect(depLabels[0].textContent).toBe("Fix login bug");
      expect(depLabels[1].textContent).toBe("Add tests");
    });

    it("renders dependency label from description when title is not available", () => {
      const allTasks: Task[] = [
        { id: "FN-001", description: "Login is broken", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      expect(depLabels[0].textContent).toBe("Login is broken");
    });

    it("renders dependency ID as label when no title or description available", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          // No tasks prop - dependency not found
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      // Should fall back to the ID itself
      expect(depLabels[0].textContent).toBe("FN-001");
    });

    it("truncates long dependency labels at 40 characters", () => {
      // Title is exactly 50 chars, should be truncated to 40 with ellipsis
      const longTitle = "This is a very long task title that exceeds the limit";
      const allTasks: Task[] = [
        { id: "FN-001", title: longTitle, description: "Short desc", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      // Title is 50 chars, should be truncated to 40 with ellipsis
      // "This is a very long task title that exceed" + "…" = 41 chars
      expect(depLabels[0].textContent!.length).toBe(41); // 40 chars + ellipsis
      expect(depLabels[0].textContent).toContain("…");
    });

    it("preserves full text in title attribute for truncated labels", () => {
      const allTasks: Task[] = [
        { id: "FN-001", title: "Very long title that gets truncated in the UI but should show full text on hover", description: "Desc", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      // The title attribute should contain the full ID for context
      expect(depLink.getAttribute("title")).toContain("FN-001");
    });

    it("calls fetchTaskDetail and onOpenDetail when clicking a dependency", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const mockDetail: TaskDetail = {
        ...makeTask({ id: "FN-001", description: "Dep 1" }),
        prompt: "",
        attachments: [],
      };
      mockFetch.mockResolvedValueOnce(mockDetail);
      const onOpenDetail = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-001", undefined);
        expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
      });
    });

    it("shows error toast when dependency fetch fails", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Task not found"));
      const onOpenDetail = vi.fn();
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={addToast}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load dependency FN-001", "error");
      });
      expect(onOpenDetail).not.toHaveBeenCalled();
    });

    it("remove button click does not trigger dependency click", async () => {
      const { updateTask } = await import("../../api");
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Should not be called"));
      const onOpenDetail = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const removeButton = screen.getByTitle(/Remove dependency/);
      fireEvent.click(removeButton);

      // onOpenDetail should not be called when clicking remove
      expect(onOpenDetail).not.toHaveBeenCalled();
      // updateTask should be called to remove the dependency
      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: [] }, undefined);
      });
    });
  });

  describe("blocking section", () => {
    it("renders downstream dependents and stale annotations", () => {
      const tasks = [
        makeTask({ id: "FN-099", title: "Blocker", column: "done" as Column }),
        makeTask({ id: "FN-100", title: "Todo dependent", column: "todo" as Column, dependencies: ["FN-099"] }),
        makeTask({ id: "FN-101", title: "Stale blockedBy dependent", column: "todo" as Column, blockedBy: "FN-099" }),
      ];

      const { container } = render(
        <TaskDetailModal
          task={tasks[0]}
          tasks={tasks}
          onOpenDetail={noopOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Blocking")).toBeTruthy();
      expect(container.textContent).toContain("FN-100");
      expect(container.textContent).toContain("FN-101");
      expect(container.querySelector(".detail-blocking-item--stale")?.textContent).toBe("(stale)");
    });
  });

});

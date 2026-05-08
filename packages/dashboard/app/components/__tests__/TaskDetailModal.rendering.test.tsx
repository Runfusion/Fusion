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
  noopRetry,
  mockConfirm,
  mockUsePluginUiSlots,
  expectBaseRule,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  describe("provenance display", () => {
    it.each([
      ["dashboard_ui", undefined, "Created via Dashboard"],
      ["agent_heartbeat", "agent-123", "Created by"],
    ] as const)("renders provenance text for %s", (sourceType, sourceAgentId, expectedText) => {
      render(
        <TaskDetailModal
          task={makeTask({ sourceType, sourceAgentId })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
      if (sourceType === "agent_heartbeat" && sourceAgentId) {
        expect(screen.getByRole("button", { name: sourceAgentId })).toBeInTheDocument();
      }
    });

    it("renders parent task link for refinement provenance", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ sourceType: "task_refine", sourceParentTaskId: "FN-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(/Created via Refinement/)).toBeInTheDocument();
      const link = screen.getByRole("button", { name: "FN-001" });
      expect(link).toBeInTheDocument();
      await userEvent.click(link);
      await waitFor(() => {
        expect(noopOpenDetail).toHaveBeenCalled();
      });
    });

    it("renders issue URL for github import provenance", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            sourceType: "github_import",
            sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Created via GitHub Import (https://github.com/owner/repo/issues/42)")).toBeInTheDocument();
    });

    it("renders finding label for research provenance", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            sourceType: "research",
            sourceMetadata: {
              runId: "RR-123",
              findingLabel: "Pricing pressure in EU segment",
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

      expect(screen.getByText("Created via Research (Pricing pressure in EU segment)")).toBeInTheDocument();
    });

    it("falls back to run id for research provenance context", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            sourceType: "research",
            sourceMetadata: { runId: "RR-456" },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Created via Research (RR-456)")).toBeInTheDocument();
    });

    it.each(["unknown", undefined] as const)("omits provenance for %s source", (sourceType) => {
      render(
        <TaskDetailModal
          task={makeTask({ sourceType })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText(/Created via/)).not.toBeInTheDocument();
    });
  });

  it("renders modal wrapper structure and default close control", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".modal-overlay.open")).toBeTruthy();
    expect(container.querySelector(".modal.modal-lg.task-detail-modal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to task list" })).toBeNull();
  });

  it("renders mobile back control variant when requested", () => {
    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        mobileHeaderMode="back"
      />,
    );

    expect(screen.getByRole("button", { name: "Back to task list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("omits close control in embedded mode while rendering shared content", () => {
    const { container } = render(
      <TaskDetailContent
        task={makeTask()}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        embedded
      />,
    );

    expect(container.querySelector(".task-detail-content--embedded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "Definition" })).toBeInTheDocument();
  });

  it("styles detail-body scrollbar rules", () => {
    const css = readDashboardStylesSource();

    expectBaseRule(css, ".detail-body", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".detail-body", "scrollbar-width: thin;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-track", "background: transparent;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-thumb:hover", "background: var(--text-muted);");
  });

  it("styles agent log viewer scroll container scrollbar rules", () => {
    const css = readDashboardStylesSource();

    expectBaseRule(css, ".agent-log-viewer", "overflow: hidden;");
    expectBaseRule(css, ".agent-log-viewer-scroll", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".agent-log-viewer-scroll", "scrollbar-width: thin;");
    expectBaseRule(css, ".agent-log-viewer-scroll::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".agent-log-viewer-scroll::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".agent-log-model-header", "background: var(--bg-tertiary);");
  });

  it("renders markdown-body without detail-prompt class when prompt exists", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const markdownDiv = container.querySelector(".markdown-body");
    expect(markdownDiv).toBeTruthy();
    expect(markdownDiv!.classList.contains("detail-prompt")).toBe(false);
  });

  it("strips the leading heading from prompt and renders remaining markdown", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The leading # heading should be stripped (modal has its own header)
    expect(container.querySelector(".markdown-body h1")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders (no prompt) with detail-prompt class when prompt is absent", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: undefined })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const fallback = screen.getByText("(no prompt)");
    expect(fallback).toBeTruthy();
    expect(fallback.classList.contains("detail-prompt")).toBe(true);
    expect(fallback.classList.contains("markdown-body")).toBe(false);
  });

  it("does not render a PROMPT.md heading", () => {
    render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Some prompt content" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("PROMPT.md")).toBeNull();
  });

  it("renders Review and Comments tabs", () => {
    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Comments")).toBeTruthy();
  });

  describe("inline execution mode toggle", () => {
    it("renders standard mode as an unpressed toggle", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const toggle = screen.getByRole("button", { name: "Execution mode: standard" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveTextContent("Standard");
      expect(toggle).not.toHaveClass("detail-execution-mode-toggle--fast");
    });

    it("renders fast mode as a pressed toggle", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "todo", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const toggle = screen.getByRole("button", { name: "Execution mode: fast" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(toggle).toHaveTextContent("Fast");
      expect(toggle).toHaveClass("detail-execution-mode-toggle--fast");
    });
  });

  it("defines fast execution mode svg highlight styles with warning tokens", () => {
    const css = readDashboardStylesSource();

    expectBaseRule(css, ".detail-execution-mode-toggle--fast svg", "color: var(--color-warning);");
    expectBaseRule(
      css,
      ".detail-execution-mode-toggle--fast svg",
      "background: color-mix(in srgb, var(--color-warning) 20%, transparent);",
    );
  });

  it("appends daemon token query to attachment href/src URLs for direct browser loads", () => {
    localStorage.setItem("fn.authToken", "daemon-token");

    render(
      <TaskDetailModal
        task={makeTask({
          attachments: [
            {
              filename: "screenshot.png",
              originalName: "Screenshot",
              mimeType: "image/png",
              size: 1024,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const attachmentLink = screen.getByRole("link", { name: "Screenshot" });
    const attachmentImage = screen.getByAltText("Screenshot");

    expect(attachmentLink.getAttribute("href")).toBe(
      "/api/tasks/FN-099/attachments/screenshot.png?fn_token=daemon-token",
    );
    expect(attachmentImage.getAttribute("src")).toBe(
      "/api/tasks/FN-099/attachments/screenshot.png?fn_token=daemon-token",
    );
  });

  it("leaves attachment href/src URLs unchanged when no daemon token is present", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          attachments: [
            {
              filename: "screenshot.png",
              originalName: "Screenshot",
              mimeType: "image/png",
              size: 1024,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const attachmentLink = screen.getByRole("link", { name: "Screenshot" });
    const attachmentImage = screen.getByAltText("Screenshot");

    expect(attachmentLink.getAttribute("href")).toBe("/api/tasks/FN-099/attachments/screenshot.png");
    expect(attachmentImage.getAttribute("src")).toBe("/api/tasks/FN-099/attachments/screenshot.png");
  });

  it("renders Retry button when task status is 'failed' (in Actions dropdown)", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "failed" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    // Open Actions dropdown to see Retry
    const actionsBtn = screen.getByRole("button", { name: /actions/i });
    fireEvent.click(actionsBtn);

    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeTruthy();
  });

  it("does NOT render Retry button when task status is not 'failed'", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "executing" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    // No Retry should be visible in the Actions dropdown
    const actionsBtn = screen.getByRole("button", { name: /actions/i });
    fireEvent.click(actionsBtn);
    expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
  });

  it("does NOT render Retry button when onRetryTask is not provided", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "failed" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Retry")).toBeNull();
  });

  describe("retry action uniqueness for in-review failed tasks", () => {
    it("shows exactly one Retry button when task is in-review AND failed (in Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      // Open Actions dropdown and check for exactly one Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      const retryButtons = screen.getAllByRole("menuitem", { name: "Retry" });
      expect(retryButtons).toHaveLength(1);
    });

    it("shows exactly one Retry button when task is in-review AND stuck-killed (in Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "stuck-killed" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      // Open Actions dropdown and check for exactly one Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      const retryButtons = screen.getAllByRole("menuitem", { name: "Retry" });
      expect(retryButtons).toHaveLength(1);
    });

    it("shows Retry for a stranded planning triage task", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", status: "planning", stuckKillCount: 6 })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      const retryButtons = screen.getAllByRole("menuitem", { name: "Retry" });
      expect(retryButtons).toHaveLength(1);
    });

    it("closes modal immediately when Retry is clicked (before API call)", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => ({}) as Task);

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={noop}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Modal should close immediately (optimistic close before API call)
      expect(onClose).toHaveBeenCalledTimes(1);
      // onRetryTask should still be called with the correct task ID
      expect(onRetryTask).toHaveBeenCalledWith("FN-099");
    });

    it("shows exactly one success toast when retry succeeds", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => ({}) as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Wait for the promise to resolve
      await act(async () => {});

      // Only one toast — the success toast, no info toast
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("Retried FN-099", "success");
    });

    it("shows exactly one error toast when retry fails", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => {
        throw new Error("Server error");
      });
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Wait for the promise to reject
      await act(async () => {});

      // Only one toast — the error toast
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("Server error", "error");
    });

    it("shows in-review split button with primary action and secondary move option", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const moveBtn = screen.getByRole("button", { name: "Move to Todo" });
      expect(moveBtn).toBeTruthy();
      const chevronZone = container.querySelector(".detail-move-btn__arrow");
      expect(chevronZone).toBeTruthy();

      fireEvent.keyDown(moveBtn, { key: "ArrowDown" });
      expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Move to Todo" })).toBeNull();

      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);
      expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
    });

    it("in-review failed task shows both Retry action and secondary move option", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });
      expect(screen.getByRole("menuitem", { name: "Retry" })).toBeTruthy();
      expect(screen.getAllByRole("menuitem", { name: "Retry" })).toHaveLength(1);

      const chevronZone = document.querySelector(".detail-move-btn__arrow");
      await act(async () => {
        fireEvent.click(chevronZone!);
      });
      expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Move to Todo" })).toBeNull();
    });

    it("split-button renders with chevron when multiple transitions exist", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const moveBtn = screen.getByRole("button", { name: "Move to In Review" });
      expect(moveBtn).toBeTruthy();
      const chevronZone = container.querySelector(".detail-move-btn__arrow");
      expect(chevronZone).toBeTruthy();

      await act(async () => {
        fireEvent.click(chevronZone!);
      });
      expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Move to Planning" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Move to Done" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Move to In Review" })).toBeNull();
    });

    it("split-button renders without chevron when only one transition", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Move to Todo" })).toBeTruthy();
      expect(container.querySelector(".detail-move-btn__arrow")).toBeNull();
      expect(container.querySelector(".detail-move-split-btn__divider")).toBeNull();
    });

    it("clicking main button executes primary transition immediately", async () => {
      const onMoveTask = vi.fn().mockResolvedValue(undefined);

      render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" })}
          onClose={noop}
          onMoveTask={onMoveTask}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Move to In Review" }));
      });

      expect(onMoveTask).toHaveBeenCalledWith("FN-099", "in-review", undefined);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("chevron dropdown includes only secondary transitions", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const moveBtn = screen.getByRole("button", { name: "Move to In Review" });
      fireEvent.keyDown(moveBtn, { key: "ArrowDown" });

      expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Move to Planning" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Move to Done" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Move to In Review" })).toBeNull();

      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to Todo" }), { key: "Escape" });
      expect(screen.queryByRole("menuitem", { name: "Move to Todo" })).toBeNull();
      expect(document.activeElement).toBe(moveBtn);
    });
  });

  it("shows description exactly once for a task without title", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          title: undefined,
          description: "Fix the login bug",
          prompt: "# KB-099\n\nFix the login bug\n",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The heading "FN-099" should be stripped from the markdown
    const markdownBody = container.querySelector(".markdown-body");
    expect(markdownBody?.innerHTML).not.toContain("FN-099");
    // Description appears in the markdown body
    expect(markdownBody?.textContent).toContain("Fix the login bug");
    // The detail header shows the ID (not duplicated as markdown heading)
    expect(container.querySelector(".detail-id")?.textContent).toBe("FN-099");
    // The h2 title shows description, not the task ID
    const h2 = container.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Fix the login bug");
  });

  it("shows the title in <h2> when task.title is set", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          title: "Implement dark mode",
          description: "Add dark mode toggle to the settings page",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const h2 = container.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Implement dark mode");
  });

  describe("description truncation", () => {
    it("truncates description over 200 characters with Show more button", () => {
      const longDescription = "A".repeat(250);
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: undefined,
            description: longDescription,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("A".repeat(200) + "…");
      const toggle = container.querySelector(".detail-description-toggle");
      expect(toggle?.textContent).toBe("Show more");
    });

    it("expands full description when Show more is clicked", async () => {
      const longDescription = "B".repeat(250);
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: undefined,
            description: longDescription,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const toggle = container.querySelector(".detail-description-toggle") as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(toggle);
      });

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("B".repeat(250));
      expect(toggle.textContent).toBe("Show less");
    });

    it("collapses description when Show less is clicked", async () => {
      const longDescription = "C".repeat(250);
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: undefined,
            description: longDescription,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // First expand
      const toggle = container.querySelector(".detail-description-toggle") as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(toggle);
      });

      // Then collapse
      await act(async () => {
        fireEvent.click(toggle);
      });

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("C".repeat(200) + "…");
      expect(toggle.textContent).toBe("Show more");
    });

    it("does not show toggle for description under 200 characters", () => {
      const shortDescription = "Short description";
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: undefined,
            description: shortDescription,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe(shortDescription);
      expect(container.querySelector(".detail-description-toggle")).toBeNull();
    });

    it("does not show toggle when title is present and short", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: "Short title",
            description: "This is a longer description that would be truncated if it were shown as the main text",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("Short title");
      expect(container.querySelector(".detail-description-toggle")).toBeNull();
    });

    it("shows toggle when title exceeds 200 characters", () => {
      const longTitle = "D".repeat(250);
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            title: longTitle,
            description: "Short description",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const h2 = container.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("D".repeat(200) + "…");
      const toggle = container.querySelector(".detail-description-toggle");
      expect(toggle?.textContent).toBe("Show more");
    });

    it("resets expanded state when task changes", async () => {
      const longDescription1 = "E".repeat(250);
      const longDescription2 = "F".repeat(250);
      const { container, rerender } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            title: undefined,
            description: longDescription1,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Expand the first task
      const toggle = container.querySelector(".detail-description-toggle") as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(toggle);
      });

      // Verify expanded
      const h2Before = container.querySelector("h2.detail-title");
      expect(h2Before?.textContent).toBe("E".repeat(250));

      // Change to a different task
      rerender(
        <TaskDetailModal
          task={makeTask({
            id: "FN-002",
            title: undefined,
            description: longDescription2,
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Should be collapsed again
      const h2After = container.querySelector("h2.detail-title");
      expect(h2After?.textContent).toBe("F".repeat(200) + "…");
    });
  });

  it("always shows task.id in the detail-id badge regardless of title", () => {
    // With title
    const { container: withTitle } = render(
      <TaskDetailModal
        task={makeTask({ title: "Some title" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(withTitle.querySelector(".detail-id")?.textContent).toBe("FN-099");

    // Without title
    const { container: withoutTitle } = render(
      <TaskDetailModal
        task={makeTask({ title: undefined, description: "A description" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(withoutTitle.querySelector(".detail-id")?.textContent).toBe("FN-099");
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
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Modal renders immediately without crashing
      expect(container.querySelector(".modal-overlay")).toBeTruthy();
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
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={detail}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
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
      expect(screen.getByText("executing")).toBeInTheDocument();
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
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
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
        const markdownBody = container.querySelector(".markdown-body");
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
      expect(screen.getByText("executing")).toBeInTheDocument();
      expect(screen.getByText((1200).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((450).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((210).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((1860).toLocaleString())).toBeInTheDocument();
      const firstUsed = container.querySelector('time[datetime="2026-04-24T09:00:00.000Z"]');
      const lastUsed = container.querySelector('time[datetime="2026-04-24T10:15:00.000Z"]');
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

      mockFetch.mockResolvedValueOnce({
        ...strippedTask,
        prompt: "# Spec",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "Created task" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "Started executor", outcome: "OK" },
        ],
      } as TaskDetail);

      const { container } = render(
        <TaskDetailModal
          task={strippedTask}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Wait for fetchTaskDetail to resolve.
      await waitFor(() => {
        expect(container.querySelector(".markdown-body")).toBeTruthy();
      }, { timeout: 3000 });

      fireEvent.click(screen.getByText("Logs"));

      const activityList = container.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();
      const logEntries = container.querySelectorAll(".detail-log-entry");
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
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
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

  it("renders corrected stats timing totals in Stats tab", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          executionStartedAt: "2026-04-24T09:00:00.000Z",
          executionCompletedAt: "2026-04-24T09:04:00.000Z",
          timedExecutionMs: 120_000,
          log: [
            { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] AI execution completed in 120000ms" },
          ],
          workflowStepResults: [
            {
              workflowStepId: "WS-401",
              workflowStepName: "Workflow QA",
              status: "passed",
              startedAt: "2026-04-24T09:01:00.000Z",
              completedAt: "2026-04-24T09:02:00.000Z",
            },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stats" }));

    const totalMetric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
    const workflowMetric = screen.getByText("Workflow runtime").closest(".task-token-stats-panel__metric");

    expect(totalMetric).toHaveTextContent("4m 0s");
    expect(screen.getByText("Timed duration").closest(".task-token-stats-panel__metric")).toHaveTextContent("2m 0s");
    expect(workflowMetric).toHaveTextContent("1m 0s");
  });

});

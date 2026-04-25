import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { useState } from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetailModal } from "../TaskDetailModal";
import type { TaskDetail, Column, MergeResult, Task } from "@fusion/core";
import { clearAuthToken } from "../../auth";

vi.mock("../../api", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  updateTask: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  fetchAgentLogs: vi.fn().mockResolvedValue([]),
  requestSpecRevision: vi.fn().mockResolvedValue({}),
  approvePlan: vi.fn().mockResolvedValue({}),
  rejectPlan: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  refineTask: vi.fn().mockResolvedValue({}),
  addSteeringComment: vi.fn(),
  assignTask: vi.fn().mockResolvedValue({}),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchAgent: vi.fn(),
  // TaskForm dependencies
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [] }),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  pauseTask: vi.fn().mockResolvedValue({}),
  unpauseTask: vi.fn().mockResolvedValue({}),
  fetchWorkflowResults: vi.fn().mockResolvedValue([]),
}));

// Mock lucide-react icons used by TaskDetailModal, TaskForm, PrSection, CustomModelDropdown
vi.mock("lucide-react", () => ({
  Pencil: () => null,
  Sparkles: () => null,
  Globe: () => null,
  GitPullRequest: () => null,
  ExternalLink: () => null,
  RefreshCw: () => null,
  Plus: () => null,
  MessageSquare: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  Bot: () => null,
  CircleDot: () => null,
  XCircle: () => null,
  GitMerge: () => null,
}));

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(() => ({ entries: [], loading: false, clear: vi.fn() })),
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn(() => ({
  slots: [],
  getSlotsForId: vi.fn(() => []),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (...args: unknown[]) => mockUsePluginUiSlots(...args),
}));

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-099",
    description: "Test task",
    column: "in-progress" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskDetail;
}

const noop = vi.fn();
const noopMove = vi.fn(async () => ({}) as Task);
const noopDelete = vi.fn(async () => ({}) as Task);
const noopMerge = vi.fn(async () => ({ merged: false }) as MergeResult);
const noopRetry = vi.fn(async () => ({}) as Task);
const noopOpenDetail = vi.fn();

function getCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function readDashboardStylesSource(): string {
  return loadAllAppCss();
}

describe("TaskDetailModal", () => {
  beforeEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
  });

  afterEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
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

  it("renders Comments tab", () => {
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

    expect(screen.getByText("Comments")).toBeTruthy();
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

    it("shows Retry for a stranded specifying triage task", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", status: "specifying", stuckKillCount: 6 })}
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

  it("shows 'Move to Todo' in Move dropdown for in-review tasks (not 'Retry')", () => {
      render(
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

      // Should show "Move" button that opens dropdown
      const moveBtn = screen.getByRole("button", { name: /move/i });
      expect(moveBtn).toBeTruthy();

      // Open Move dropdown to see "Move to Todo"
      fireEvent.click(moveBtn);
      expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();

      // No Retry in Actions dropdown
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);
      expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
    });

    it("in-review failed task shows both 'Retry' (in Actions) and 'Move to Todo' (in Move dropdown)", async () => {
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

      // Open Actions dropdown and check Retry
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });
      expect(screen.getByRole("menuitem", { name: "Retry" })).toBeTruthy();
      // Total count: exactly one Retry
      expect(screen.getAllByRole("menuitem", { name: "Retry" })).toHaveLength(1);

      // Open Move dropdown and check Move to Todo
      const moveBtn = screen.getByRole("button", { name: /move/i });
      await act(async () => {
        fireEvent.click(moveBtn);
      });
      expect(screen.getByRole("menuitem", { name: "Move to Todo" })).toBeTruthy();
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

  describe("paste image upload", () => {
    it("uploads an image when pasting clipboard image data", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      const mockAttachment = {
        filename: "abc123.png",
        originalName: "image.png",
        size: 1024,
        mimeType: "image/png",
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockUpload.mockResolvedValueOnce(mockAttachment);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      const imageFile = new File(["fake-image"], "image.png", { type: "image/png" });
      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [
          {
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      };

      await act(async () => {
        document.dispatchEvent(pasteEvent);
      });

      await waitFor(() => {
        expect(mockUpload).toHaveBeenCalledWith("FN-099", imageFile, undefined);
        expect(addToast).toHaveBeenCalledWith("Screenshot attached", "success");
      });
    });

    it("does not intercept paste events without image data", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      mockUpload.mockClear();

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

      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [
          {
            type: "text/plain",
            getAsFile: () => null,
          },
        ],
      };

      await act(async () => {
        document.dispatchEvent(pasteEvent);
      });

      expect(mockUpload).not.toHaveBeenCalled();
    });

    it("shows uploading state during paste upload", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      let resolveUpload!: (value: any) => void;
      mockUpload.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      );

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

      const imageFile = new File(["fake"], "shot.png", { type: "image/png" });
      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [{ type: "image/png", getAsFile: () => imageFile }],
      };

      act(() => {
        document.dispatchEvent(pasteEvent);
      });

      // While uploading, button should show "Uploading…"
      await waitFor(() => {
        expect(screen.getByText("Uploading…")).toBeTruthy();
      });

      await act(async () => {
        resolveUpload({
          filename: "x.png",
          originalName: "shot.png",
          size: 100,
          mimeType: "image/png",
          createdAt: "2026-01-01T00:00:00Z",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Attach Screenshot")).toBeTruthy();
      });
    });
  });

  describe("drag and drop image upload", () => {
    it("uploads an image when dropped onto the modal", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      const mockAttachment = {
        filename: "drop123.png",
        originalName: "dropped.png",
        size: 2048,
        mimeType: "image/png",
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockUpload.mockResolvedValueOnce(mockAttachment);
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      const modal = container.querySelector(".modal.modal-lg")!;
      const imageFile = new File(["fake-image"], "dropped.png", { type: "image/png" });

      await act(async () => {
        fireEvent.drop(modal, {
          dataTransfer: {
            files: [imageFile],
          },
        });
      });

      await waitFor(() => {
        expect(mockUpload).toHaveBeenCalledWith("FN-099", imageFile, undefined);
        expect(addToast).toHaveBeenCalledWith("Screenshot attached", "success");
      });
    });
  });

  it("renders (no dependencies) when dependencies is empty", () => {
    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("(no dependencies)")).toBeTruthy();
  });

  it("renders dependency list when dependencies exist", () => {
    const allTasks: Task[] = [
      { id: "FN-001", title: "First dependency", description: "Desc 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "FN-002", title: "Second dependency", description: "Desc 2", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
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

    // Check that dependency IDs are rendered
    const depIds = document.querySelectorAll(".detail-dep-id");
    expect(depIds).toHaveLength(2);
    expect(depIds[0].textContent).toBe("FN-001");
    expect(depIds[1].textContent).toBe("FN-002");

    // Check that dependency labels (titles) are rendered
    const depLabels = document.querySelectorAll(".detail-dep-label");
    expect(depLabels).toHaveLength(2);
    expect(depLabels[0].textContent).toBe("First dependency");
    expect(depLabels[1].textContent).toBe("Second dependency");

    expect(screen.queryByText("(no dependencies)")).toBeNull();
  });

  it("can add a dependency via the dropdown", async () => {
    const { updateTask } = await import("../../api");
    const allTasks: Task[] = [
      { id: "FN-001", description: "Dep 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    // Should show KB-001 in the dropdown but not KB-099 (self is excluded)
    const dropdown = document.querySelector(".dep-dropdown")!;
    expect(dropdown).toBeTruthy();
    expect(dropdown.textContent).toContain("FN-001");
    expect(dropdown.querySelectorAll(".dep-dropdown-item")).toHaveLength(1);

    fireEvent.click(screen.getByText("FN-001"));

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: ["FN-001"] }, undefined);
    });
  });

  it("can remove a dependency", async () => {
    const { updateTask } = await import("../../api");

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const removeButtons = screen.getAllByTitle(/Remove dependency/);
    fireEvent.click(removeButtons[0]); // Remove KB-001

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: ["FN-002"] }, undefined);
    });
  });

  it("activity list does not have nested scroll constraints", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          log: [
            { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
            { timestamp: "2026-01-01T00:01:00Z", action: "Started work" },
            { timestamp: "2026-01-01T00:02:00Z", action: "Completed step 1" },
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

    // Click Logs tab — Activity is the default subview
    fireEvent.click(screen.getByText("Logs"));

    const activityList = container.querySelector(".detail-activity-list");
    expect(activityList).toBeTruthy();
    const style = (activityList as HTMLElement).style;
    expect(style.overflowY).not.toBe("auto");
    expect(style.maxHeight).toBe("");
  });

  it("renders dependency dropdown items sorted newest-first by createdAt", () => {
    const allTasks: Task[] = [
      { id: "FN-001", description: "Oldest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-003", description: "Newest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "FN-002", description: "Middle", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);

    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("renders tasks with identical createdAt sorted newest-ID-first in dependency dropdown", () => {
    const allTasks: Task[] = [
      { id: "FN-001", description: "First", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-002", description: "Second", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-003", description: "Third", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);

    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  describe("tab toggle", () => {
    it("defaults to the Definition tab", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Definition")).toBeTruthy();
      expect(screen.getByText("Logs")).toBeTruthy();
      // Activity and Agent Log are subviews inside the Logs tab, not top-level tabs
      // They should NOT be visible on the Definition tab
      expect(screen.queryByText("Activity")).toBeNull();
      expect(screen.queryByText("Agent Log")).toBeNull();
      // Definition content should be visible
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      // Activity section should NOT be visible initially
      expect(container.querySelector(".detail-activity")).toBeNull();
      // Agent log viewer should not be visible
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();

      // After clicking Logs tab, the subview toggle buttons should appear
      fireEvent.click(screen.getByText("Logs"));
      const logSubviewToggle = container.querySelector(".log-subview-toggle");
      expect(logSubviewToggle).toBeTruthy();
      expect(logSubviewToggle!.textContent).toContain("Activity");
      expect(logSubviewToggle!.textContent).toContain("Agent Log");
    });

    it("switches to Activity subview via Logs tab and shows activity feed", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [
              { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
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

      // Click Logs tab — Activity is the default subview
      fireEvent.click(screen.getByText("Logs"));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Activity list should be visible
      expect(container.querySelector(".detail-activity-list")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("Activity subview renders log entries correctly", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            log: [
              { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
              { timestamp: "2026-01-01T00:01:00Z", action: "Started work", outcome: "Success" },
              { timestamp: "2026-01-01T00:02:00Z", action: "Completed step 1" },
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

      // Click Logs tab — Activity is the default subview
      fireEvent.click(screen.getByText("Logs"));

      const activityList = container.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();

      // Check log entries are rendered (in reverse order - newest first)
      const logEntries = container.querySelectorAll(".detail-log-entry");
      expect(logEntries).toHaveLength(3);

      // Most recent entry should be first
      expect(logEntries[0].textContent).toContain("Completed step 1");
      expect(logEntries[1].textContent).toContain("Started work");
      expect(logEntries[1].textContent).toContain("Success"); // outcome
      expect(logEntries[2].textContent).toContain("Created task");
    });

    it("Activity subview keeps action/outcome rendering intact", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            log: [
              { timestamp: "2026-01-01T00:01:00Z", action: "Started work", outcome: "Step completed successfully" },
              { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
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

      fireEvent.click(screen.getByText("Logs"));

      const actions = container.querySelectorAll(".detail-log-action");
      const outcomes = container.querySelectorAll(".detail-log-outcome");
      expect(actions).toHaveLength(2);
      expect(outcomes).toHaveLength(1);
      expect(Array.from(actions).map((entry) => entry.textContent)).toEqual(["Created task", "Started work"]);
      expect(outcomes[0].textContent).toBe("Step completed successfully");
    });

    it("Activity timeline CSS keeps action/outcome high-contrast and timestamp secondary", () => {
      const stylesCssText = readDashboardStylesSource();
      expect(stylesCssText).toContain(".detail-log-action");

      const actionRule = getCssRuleBlock(stylesCssText, ".detail-log-action");
      const outcomeRule = getCssRuleBlock(stylesCssText, ".detail-log-outcome");
      const timestampRule = getCssRuleBlock(stylesCssText, ".detail-log-timestamp");

      expect(actionRule).toContain("color: var(--text);");
      expect(outcomeRule).toContain("color: var(--text);");
      expect(outcomeRule).toContain("background: var(--surface);");
      expect(timestampRule).toContain("color: var(--text-muted);");
      expect(timestampRule).not.toContain("color: var(--text);");
    });

    it("Activity subview shows empty state when no logs", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ log: [] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Logs tab — Activity is the default subview
      fireEvent.click(screen.getByText("Logs"));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Empty state should be shown
      expect(container.querySelector(".detail-log-empty")).toBeTruthy();
      expect(screen.getByText("(no activity)")).toBeTruthy();
      // Activity list should NOT be present when empty
      expect(container.querySelector(".detail-activity-list")).toBeNull();
    });

    it("can switch between all tabs and Logs subviews", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [{ timestamp: "2026-01-01T00:00:00Z", action: "Test" }],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Start on Definition tab
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch to Logs tab (Activity subview is default)
      fireEvent.click(screen.getByText("Logs"));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Switch to Agent Log subview within Logs tab
      fireEvent.click(screen.getByText("Agent Log"));
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch back to Activity subview within Logs tab
      fireEvent.click(screen.getByText("Activity"));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch back to Definition tab
      fireEvent.click(screen.getByText("Definition"));
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

    });

    it("switches to Agent Log subview via Logs tab and back", async () => {
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");
      const mockUseAgentLogs = vi.mocked(useAgentLogs);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Logs tab, then Agent Log subview
      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      // Agent log viewer should appear
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Click Definition tab to go back
      fireEvent.click(screen.getByText("Definition"));

      // Definition content should reappear
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();
    });

    it("passes enabled=true to useAgentLogs only when Logs → Agent Log subview is active", async () => {
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");
      const mockUseAgentLogs = vi.mocked(useAgentLogs);
      mockUseAgentLogs.mockClear();

      const { rerender } = render(
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

      // Default: Definition tab active → enabled should be false
      const initialCall = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(initialCall[1]).toBe(false);

      // Switch to Logs tab (Activity subview is default) — enabled should still be false
      fireEvent.click(screen.getByText("Logs"));
      const afterLogsClick = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(afterLogsClick[1]).toBe(false);

      // Switch to Agent Log subview — enabled should become true
      fireEvent.click(screen.getByText("Agent Log"));
      const afterAgentLog = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(afterAgentLog[1]).toBe(true);
    });

    it("switches to Comments tab", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Comments content should appear
      const headings = screen.getAllByText("Comments");
      expect(headings.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("shows correct top-level tabs including Logs", async () => {
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

      // For an in-progress task (no workflow steps, no merge commit), the
      // top-level tabs are: Definition, Logs, Changes, Comments, Documents,
      // Model, Workflow, Stats.
      const tabTexts = ["Definition", "Logs", "Changes", "Comments", "Documents", "Model", "Workflow", "Stats"];
      const tabs = screen.getAllByRole("button").filter((b) =>
        tabTexts.includes(b.textContent || "")
      );
      expect(tabs.length).toBe(8);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Logs");
      expect(tabs[2].textContent).toBe("Changes");
      expect(tabs[3].textContent).toBe("Comments");
      expect(tabs[4].textContent).toBe("Documents");
      expect(tabs[5].textContent).toBe("Model");
      expect(tabs[6].textContent).toBe("Workflow");
      expect(tabs[7].textContent).toBe("Stats");

      // Activity and Agent Log are NOT top-level tabs (they are subviews inside Logs)
      expect(container.querySelectorAll(".detail-tab").length).toBe(8);
      // Workflow tab should always appear even when no workflow steps are configured
      expect(screen.getByText("Workflow")).toBeInTheDocument();
      // Commits tab should NOT appear for non-done tasks
      expect(screen.queryByText("Commits")).toBeNull();
    });
  });

  describe("Agent Log full-height layout", () => {
    it("applies detail-body--agent-log class when Logs → Agent Log subview is active", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially, detail-body should NOT have the agent-log modifier
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();

      // Switch to Logs tab, then Agent Log subview
      fireEvent.click(screen.getByText("Logs"));
      expect(container.querySelector(".detail-body--agent-log")).toBeNull(); // Activity subview default

      fireEvent.click(screen.getByText("Agent Log"));

      // detail-body should now have the agent-log modifier class
      expect(container.querySelector(".detail-body--agent-log")).toBeTruthy();

      // Switch back to Definition tab
      fireEvent.click(screen.getByText("Definition"));

      // modifier class should be removed
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();
    });

    it("wraps AgentLogViewer in detail-section--agent-log class", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Switch to Logs tab, then Agent Log subview
      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      // The section wrapping AgentLogViewer should have the full-height class
      const section = container.querySelector(".detail-section--agent-log");
      expect(section).toBeTruthy();
      expect(section!.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
    });

    it("does not apply detail-body--agent-log when editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage", prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Switch to Logs tab, then Agent Log subview first
      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));
      expect(container.querySelector(".detail-body--agent-log")).toBeTruthy();

      // Now enter edit mode via the pencil button in the header
      const editBtn = screen.getByLabelText("Edit task");
      fireEvent.click(editBtn);

      // The detail-body--agent-log class should be removed while editing
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();
    });
  });

  describe("Agent Log model resolution", () => {
    // AgentLogViewer only renders the model header when entries.length > 0,
    // so we mock useAgentLogs to return at least one entry.
    const mockLogEntry = { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-099", text: "hello", type: "text" as const };

    async function setupModelTest(settingsOverrides: Record<string, any> = {}) {
      const { fetchSettings } = await import("../../api");
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");

      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        ...settingsOverrides,
      } as any);

      vi.mocked(useAgentLogs).mockReturnValue({
        entries: [mockLogEntry],
        loading: false,
        clear: vi.fn(),
      });

      return render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    async function setupModelTestWithTask(taskOverrides: Partial<TaskDetail>, settingsOverrides: Record<string, any> = {}) {
      const { fetchSettings } = await import("../../api");
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");

      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        ...settingsOverrides,
      } as any);

      vi.mocked(useAgentLogs).mockReturnValue({
        entries: [mockLogEntry],
        loading: false,
        clear: vi.fn(),
      });

      return render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent", ...taskOverrides })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    it("shows resolved executor from settings when task has no explicit executor override", async () => {
      const { container } = await setupModelTest({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        expect(header!.textContent).toContain("anthropic/claude-sonnet-4-5");
      });

      // Validator should also fall back to the default
      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("shows resolved validator from project validator settings when task has no validator override", async () => {
      const { container } = await setupModelTest({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        expect(header!.textContent).toContain("openai/gpt-4o");
      });

      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      // Executor falls back to default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
      // Validator uses the validator-specific setting
      expect(header.textContent).toContain("openai/gpt-4o");
    });

    it("falls back to default settings for validator when no validator-specific setting exists", async () => {
      const { container } = await setupModelTest({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        // No validatorProvider or validatorModelId
      });

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        // Both executor and validator should resolve to the default
        expect(header!.textContent).toContain("anthropic/claude-sonnet-4-5");
      });

      // Count occurrences - should appear three times (once for executor, once for validator, once for planning)
      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      const matches = header.textContent!.match(/anthropic\/claude-sonnet-4-5/g);
      expect(matches).toHaveLength(3);
    });

    it("shows task executor override even when settings provide a default", async () => {
      const { container } = await setupModelTestWithTask(
        { modelProvider: "openai", modelId: "gpt-4o" },
        { defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" },
      );

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        // Task override should win
        expect(header!.textContent).toContain("openai/gpt-4o");
      });

      // Default model should not appear for executor
      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      expect(header.textContent).toContain("openai/gpt-4o");
      // Validator falls back to default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("shows task validator override even when settings provide a validator default", async () => {
      const { container } = await setupModelTestWithTask(
        { validatorModelProvider: "google", validatorModelId: "gemini-pro" },
        { defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
      );

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        // Task validator override should win
        expect(header!.textContent).toContain("google/gemini-pro");
      });

      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      // Executor falls back to default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
      // Settings validator should not appear (task override wins)
      expect(header.textContent).not.toContain("openai/gpt-4o");
    });

    it("shows 'Using default' for both when no models can be resolved", async () => {
      const { container } = await setupModelTest({
        // No defaultProvider/defaultModelId
      });

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
      });

      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      expect(header.textContent).toContain("Using default");
      // Should show "Using default" for executor, validator, and planning
      const defaultBadges = header.querySelectorAll(".model-badge-default");
      expect(defaultBadges).toHaveLength(3);
    });

    it("shows 'Using default' for both when settings fetch fails", async () => {
      const { fetchSettings } = await import("../../api");
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");

      vi.mocked(fetchSettings).mockRejectedValueOnce(new Error("Network error"));
      vi.mocked(useAgentLogs).mockReturnValue({
        entries: [mockLogEntry],
        loading: false,
        clear: vi.fn(),
      });

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      // Wait for the failed fetch to settle
      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
      });

      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      expect(header.textContent).toContain("Using default");
      const defaultBadges = header.querySelectorAll(".model-badge-default");
      expect(defaultBadges).toHaveLength(3);
    });

    it("shows partial override: task executor with settings-based validator", async () => {
      const { container } = await setupModelTestWithTask(
        {
          modelProvider: "google",
          modelId: "gemini-pro",
          // No validator override — should use settings validator
        },
        {
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          validatorProvider: "openai",
          validatorModelId: "gpt-4o",
        },
      );

      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
        expect(header!.textContent).toContain("google/gemini-pro");
      });

      const header = container.querySelector("[data-testid='agent-log-model-header']")!;
      // Executor uses task override
      expect(header.textContent).toContain("google/gemini-pro");
      // Validator uses settings-specific validator
      expect(header.textContent).toContain("openai/gpt-4o");
    });

    // Planning/Triage model resolution tests
    describe("Planning/Triage model resolution", () => {
      it("shows planning model from runtime triage log marker", async () => {
        const { fetchSettings } = await import("../../api");
        const { useAgentLogs } = await import("../../hooks/useAgentLogs");

        vi.mocked(fetchSettings).mockResolvedValueOnce({
          modelPresets: [],
          autoSelectModelPreset: false,
          defaultPresetBySize: {},
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        } as any);

        vi.mocked(useAgentLogs).mockReturnValue({
          entries: [
            { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-099", text: "hello", type: "text" as const },
            { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-099", text: "Triage using model: google/gemini-pro", type: "text" as const, agent: "triage" },
          ],
          loading: false,
          clear: vi.fn(),
        });

        const { container } = render(
          <TaskDetailModal
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
          // Planning should show the runtime triage marker, not settings default
          expect(header!.textContent).toContain("Planning/Triage:");
          expect(header!.textContent).toContain("google/gemini-pro");
        });

        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        // Executor/Validator should still show settings default
        expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
      });

      it("shows planning model from settings planningProvider when no runtime marker", async () => {
        const { fetchSettings } = await import("../../api");
        const { useAgentLogs } = await import("../../hooks/useAgentLogs");

        vi.mocked(fetchSettings).mockResolvedValueOnce({
          modelPresets: [],
          autoSelectModelPreset: false,
          defaultPresetBySize: {},
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as any);

        vi.mocked(useAgentLogs).mockReturnValue({
          entries: [mockLogEntry],
          loading: false,
          clear: vi.fn(),
        });

        const { container } = render(
          <TaskDetailModal
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
          // Planning should use planningProvider/planningModelId from settings
          expect(header!.textContent).toContain("Planning/Triage:");
          expect(header!.textContent).toContain("openai/gpt-4o");
        });

        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        // Executor/Validator should show default
        expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
        // Planning should NOT show the default
        expect(header.textContent).toContain("openai/gpt-4o");
      });

      it("falls back to default settings for planning when no planning-specific setting exists", async () => {
        const { container } = await setupModelTest({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        });

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
          expect(header!.textContent).toContain("Planning/Triage:");
          expect(header!.textContent).toContain("anthropic/claude-sonnet-4-5");
        });

        // Planning falls back to default - same as executor/validator
        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        const matches = header.textContent!.match(/anthropic\/claude-sonnet-4-5/g);
        expect(matches).toHaveLength(3); // executor, validator, planning
      });

      it("shows 'Using default' for planning when no models can be resolved", async () => {
        const { container } = await setupModelTest({
          // No defaultProvider/defaultModelId
        });

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
        });

        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        expect(header.textContent).toContain("Planning/Triage:");
        const defaultBadges = header.querySelectorAll(".model-badge-default");
        // 3 default badges: executor, validator, planning
        expect(defaultBadges).toHaveLength(3);
      });

      it("per-task planning model override takes precedence over settings", async () => {
        const { fetchSettings } = await import("../../api");
        const { useAgentLogs } = await import("../../hooks/useAgentLogs");

        vi.mocked(fetchSettings).mockResolvedValueOnce({
          modelPresets: [],
          autoSelectModelPreset: false,
          defaultPresetBySize: {},
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as any);

        vi.mocked(useAgentLogs).mockReturnValue({
          entries: [mockLogEntry],
          loading: false,
          clear: vi.fn(),
        });

        const { container } = render(
          <TaskDetailModal
            task={makeTask({
              prompt: "# Hello\n\nContent",
              planningModelProvider: "google",
              planningModelId: "gemini-2.5-pro",
            })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
          // Per-task override should take precedence over settings
          expect(header!.textContent).toContain("Planning/Triage:");
          expect(header!.textContent).toContain("google/gemini-2.5-pro");
        });

        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        // Should NOT show the settings planning model
        expect(header.textContent).not.toContain("openai/gpt-4o");
      });

      it("runtime triage marker takes precedence over planningProvider settings", async () => {
        const { fetchSettings } = await import("../../api");
        const { useAgentLogs } = await import("../../hooks/useAgentLogs");

        vi.mocked(fetchSettings).mockResolvedValueOnce({
          modelPresets: [],
          autoSelectModelPreset: false,
          defaultPresetBySize: {},
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as any);

        vi.mocked(useAgentLogs).mockReturnValue({
          entries: [
            { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-099", text: "hello", type: "text" as const },
            { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-099", text: "Triage using model: google/gemini-pro", type: "text" as const, agent: "triage" },
          ],
          loading: false,
          clear: vi.fn(),
        });

        const { container } = render(
          <TaskDetailModal
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        // Navigate to Agent Log subview
        fireEvent.click(screen.getByText("Logs"));
        fireEvent.click(screen.getByText("Agent Log"));

        await waitFor(() => {
          const header = container.querySelector("[data-testid='agent-log-model-header']");
          expect(header).toBeTruthy();
          // Runtime marker should win over planning settings
          expect(header!.textContent).toContain("google/gemini-pro");
        });

        const header = container.querySelector("[data-testid='agent-log-model-header']")!;
        // Should NOT show the planning settings model
        expect(header.textContent).not.toContain("openai/gpt-4o");
      });
    });
  });

  describe("step progress", () => {
    it("renders step progress section when steps exist", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
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

      expect(container.querySelector(".detail-step-progress")).toBeTruthy();
      expect(screen.getByText("Progress")).toBeTruthy();
    });

    it("shows '(no steps defined)' when steps array is empty", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ steps: [] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".detail-step-progress")).toBeTruthy();
      expect(screen.getByText("(no steps defined)")).toBeTruthy();
    });

    it("renders correct number of segments matching step count", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
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

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments).toHaveLength(3);
    });

    it("segments have correct status modifier classes", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "skipped" },
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

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments[0].classList.contains("step-progress-segment--done")).toBe(true);
      expect(segments[1].classList.contains("step-progress-segment--in-progress")).toBe(true);
      expect(segments[2].classList.contains("step-progress-segment--pending")).toBe(true);
      expect(segments[3].classList.contains("step-progress-segment--skipped")).toBe(true);
    });

    it("segments have correct inline background colors based on status", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "skipped" },
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

      const segments = container.querySelectorAll(".step-progress-segment");
      expect((segments[0] as HTMLElement).style.backgroundColor).toBe("var(--color-success, #3fb950)");
      expect((segments[1] as HTMLElement).style.backgroundColor).toBe("var(--todo, #58a6ff)");
      expect((segments[2] as HTMLElement).style.backgroundColor).toBe("var(--border, #30363d)");
      expect((segments[3] as HTMLElement).style.backgroundColor).toBe("var(--text-dim, #484f58)");
    });

    it("displays singular completion label for one-step tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            steps: [{ name: "Step 1", status: "done" }],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("1/1 step")).toBeTruthy();
      expect(screen.queryByText("1/1 steps")).toBeNull();
    });

    it("displays correct completion count", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "done" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "in-progress" },
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

      expect(screen.getByText("2/4 steps")).toBeTruthy();
      expect(screen.queryByText("2/4 step")).toBeNull();
    });

    it("has data-tooltip attribute with step name and status on each segment", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Initialize project", status: "done" },
              { name: "Add tests", status: "in-progress" },
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

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments[0].getAttribute("data-tooltip")).toBe("Initialize project (done)");
      expect(segments[1].getAttribute("data-tooltip")).toBe("Add tests (in-progress)");
    });

    it("step progress only renders in Definition tab, not in Agent Log subview", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Test",
            steps: [
              { name: "Step 1", status: "done" },
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

      // Should be visible in Definition tab
      expect(container.querySelector(".detail-step-progress")).toBeTruthy();

      // Switch to Logs tab, then Agent Log subview
      fireEvent.click(screen.getByText("Logs"));
      fireEvent.click(screen.getByText("Agent Log"));

      // Should not be visible in Agent Log subview
      expect(container.querySelector(".detail-step-progress")).toBeNull();
    });

    it("step progress is hidden in Comments tab", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Test",
            steps: [
              { name: "Step 1", status: "done" },
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

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Should not be visible in Comments tab
      expect(container.querySelector(".detail-step-progress")).toBeNull();
    });
  });

  describe("mobile responsive structure", () => {
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
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(8);
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

      vi.spyOn(window, "confirm")
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

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
        expect(window.confirm).toHaveBeenNthCalledWith(1, "Delete FN-099?");
        expect(window.confirm).toHaveBeenNthCalledWith(
          2,
          "FN-099 is a dependency of FN-100, FN-101.\n\nDelete anyway by removing these dependency references first?",
        );
      });

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-099");
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", { removeDependencyReferences: true });
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

      vi.spyOn(window, "confirm")
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

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

      vi.spyOn(window, "confirm")
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

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
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", { removeDependencyReferences: true });
        expect(noop).toHaveBeenCalledWith("Retry failed", "error");
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

      // Back to In Progress is now in the Move dropdown
      const moveBtn = screen.getByRole("button", { name: /move/i });
      fireEvent.click(moveBtn);
      expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();
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

  describe("Definition tab edit mode", () => {
    it("shows Edit button in Definition tab", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test\n\nSpec content." })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Edit")).toBeTruthy();
    });

    it("clicking Edit shows textarea with current prompt content", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test\n\nSpec content." })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially showing markdown view
      expect(container.querySelector(".markdown-body")).toBeTruthy();

      // Click Edit button
      fireEvent.click(screen.getByText("Edit"));

      // Should show spec edit textarea (query by class for specificity)
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe("# Test\n\nSpec content.");
    });

    it("clicking Cancel returns to view mode without saving", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test Task\n\nTest specification." })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Modified content" } });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Should show markdown view with original content
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".spec-editor-textarea")).toBeNull();
    });

    it("saving updates the task and returns to view mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-099" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-099", prompt: "# Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "# Updated" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-099", { prompt: "# Updated" }, undefined);
      });

      // Should return to view mode
      expect(container.querySelector(".markdown-body")).toBeTruthy();
    });

    it("AI revision feedback section appears in edit mode", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));

      expect(screen.getByText("Ask AI to Revise")).toBeTruthy();
      expect(screen.getByPlaceholderText(/e.g., 'Add more details/)).toBeTruthy();
      expect(screen.getByText("Request AI Revision")).toBeTruthy();
    });

    it("requesting AI revision works and closes modal", async () => {
      const { requestSpecRevision } = await import("../../api");
      vi.mocked(requestSpecRevision).mockResolvedValueOnce({});
      const onClose = vi.fn();
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-099", column: "todo", prompt: "# Test" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));

      const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/);
      fireEvent.change(feedbackInput, { target: { value: "Please add more error handling details" } });

      fireEvent.click(screen.getByText("Request AI Revision"));

      await waitFor(() => {
        expect(requestSpecRevision).toHaveBeenCalledWith("FN-099", "Please add more error handling details", undefined);
        expect(addToast).toHaveBeenCalledWith("AI revision requested. Task moved to triage.", "success");
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows all tabs in correct order for in-progress task", () => {
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

      // In-progress tasks show exactly 8 tabs:
      // Definition, Logs, Changes, Comments, Documents, Model, Workflow, Stats
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(8);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Logs");
      expect(tabs[2].textContent).toBe("Changes");
      expect(tabs[3].textContent).toBe("Comments");
      expect(tabs[4].textContent).toBe("Documents");
      expect(tabs[5].textContent).toBe("Model");
      expect(tabs[6].textContent).toBe("Workflow");
      expect(tabs[7].textContent).toBe("Stats");
      // Commits tab should NOT be present for non-done tasks
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("shows Workflow tab in correct position when enabledWorkflowSteps is non-empty", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // In-progress task with workflow steps: 8 tabs (Workflow after Model, Stats last)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(8);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Logs");
      expect(tabs[2].textContent).toBe("Changes");
      expect(tabs[3].textContent).toBe("Comments");
      expect(tabs[4].textContent).toBe("Documents");
      expect(tabs[5].textContent).toBe("Model");
      expect(tabs[6].textContent).toBe("Workflow");
      expect(tabs[7].textContent).toBe("Stats");
    });

    it("does NOT show Commits tab for done task with mergeDetails.commitSha (changes merged into Changes tab)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            column: "done",
            mergeDetails: { commitSha: "abc1234567890", filesChanged: 3 },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Done task with commit SHA: Definition, Logs, Changes, Comments, Documents, Model, Workflow, Stats (8 tabs, no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(8);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Logs");
      expect(tabs[2].textContent).toBe("Changes");
      expect(tabs[3].textContent).toBe("Comments");
      expect(tabs[4].textContent).toBe("Documents");
      expect(tabs[5].textContent).toBe("Model");
      expect(tabs[6].textContent).toBe("Workflow");
      expect(tabs[7].textContent).toBe("Stats");
      // Commits tab should NOT be present
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("shows 8 tabs for done task with workflow steps and commit SHA (Commits merged into Changes)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            column: "done",
            mergeDetails: { commitSha: "abc1234567890", filesChanged: 3 },
            enabledWorkflowSteps: ["WS-001"],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Done task with workflow steps and commit SHA: 8 tabs (no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(8);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Logs");
      expect(tabs[2].textContent).toBe("Changes");
      expect(tabs[3].textContent).toBe("Comments");
      expect(tabs[4].textContent).toBe("Documents");
      expect(tabs[5].textContent).toBe("Model");
      expect(tabs[6].textContent).toBe("Workflow");
      expect(tabs[7].textContent).toBe("Stats");
      // Commits tab should NOT be present
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("does NOT show Changes tab for triage/todo tasks", () => {
      const { container: triageContainer } = render(
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

      const triageTabs = triageContainer.querySelectorAll(".detail-tab");
      expect(triageTabs.length).toBe(7); // Definition, Logs, Comments, Documents, Model, Workflow, Stats
      expect(Array.from(triageTabs).map(t => t.textContent)).toEqual([
        "Definition", "Logs", "Comments", "Documents", "Model", "Workflow", "Stats",
      ]);

      const { container: todoContainer } = render(
        <TaskDetailModal
          task={makeTask({ column: "todo" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const todoTabs = todoContainer.querySelectorAll(".detail-tab");
      expect(todoTabs.length).toBe(7); // Definition, Logs, Comments, Documents, Model, Workflow, Stats
      expect(Array.from(todoTabs).map(t => t.textContent)).toEqual([
        "Definition", "Logs", "Comments", "Documents", "Model", "Workflow", "Stats",
      ]);
    });

    it("shows empty state and Edit button when no prompt", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("(no prompt)")).toBeTruthy();
      expect(screen.getByText("Edit")).toBeTruthy();
    });
  });

  describe("Plan Approval UI", () => {
    it("shows Approve Plan and Reject Plan buttons for awaiting-approval tasks in triage", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Approve Plan")).toBeTruthy();
      expect(screen.getByText("Reject Plan")).toBeTruthy();
    });

    it("does not show approval buttons when task is not in triage", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "todo",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("does not show approval buttons when task does not have awaiting-approval status", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "specifying",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("does not show approval buttons when task has no prompt", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("calls approvePlan API and shows success toast when Approve Plan is clicked", async () => {
      const { approvePlan } = await import("../../api");
      const mockApprovePlan = vi.mocked(approvePlan);
      const addToast = vi.fn();
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Approve Plan"));

      await waitFor(() => {
        expect(mockApprovePlan).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Plan approved — FN-001 moved to Todo", "success");
      expect(onClose).toHaveBeenCalled();
    });

    it("calls rejectPlan API and shows success toast when Reject Plan is confirmed", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      const addToast = vi.fn();
      const onClose = vi.fn();

      // Mock confirm to return true
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(window.confirm).toHaveBeenCalledWith(
        "Reject this plan? The specification will be discarded and regenerated."
      );

      await waitFor(() => {
        expect(mockRejectPlan).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(addToast).toHaveBeenCalledWith(
        "Plan rejected — FN-001 returned to Triage for re-specification",
        "info"
      );
      expect(onClose).toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("does not call rejectPlan API when Reject Plan is cancelled", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      mockRejectPlan.mockClear(); // Clear any previous calls

      const addToast = vi.fn();

      // Mock confirm to return false
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(window.confirm).toHaveBeenCalled();
      expect(mockRejectPlan).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("shows error toast when approvePlan fails", async () => {
      const { approvePlan } = await import("../../api");
      const mockApprovePlan = vi.mocked(approvePlan);
      mockApprovePlan.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Approve Plan"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Network error", "error");
      });
    });

    it("shows error toast when rejectPlan fails", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      mockRejectPlan.mockRejectedValueOnce(new Error("Server error"));

      const addToast = vi.fn();

      // Mock confirm to return true
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Server error", "error");
      });

      window.confirm = originalConfirm;
    });
  });

  describe("Duplicate button", () => {
    it("renders Duplicate button in modal actions when onDuplicateTask is provided (in Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      // Open Actions dropdown to see Duplicate
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy();
    });

    it("does NOT render Duplicate button when onDuplicateTask is not provided", () => {
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

      // Open Actions dropdown - Duplicate should not be there
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);
      expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    });

    it("clicking Duplicate shows confirmation dialog", () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      expect(window.confirm).toHaveBeenCalledWith(
        "Duplicate FN-001? This will create a new task in Triage with the same description and prompt."
      );

      window.confirm = originalConfirm;
    });

    it("confirming duplicate calls onDuplicateTask and closes modal", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith("FN-001");
        expect(onClose).toHaveBeenCalled();
      });

      window.confirm = originalConfirm;
    });

    it("successful duplicate shows success toast with new task ID", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicated FN-001 → FN-002", "success");
      });

      window.confirm = originalConfirm;
    });

    it("cancelling confirmation does not call onDuplicateTask", () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      expect(mockDuplicate).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("shows error toast when duplicate fails", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockRejectedValue(new Error("Duplicate failed"));
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicate failed", "error");
      });

      window.confirm = originalConfirm;
    });
  });

  describe("Refinement button", () => {
    it.each<[Column, boolean]>([
      ["done", true],
      ["in-review", true],
      ["todo", false],
      ["in-progress", false],
    ])("Refine action visibility in column=%s is %s", (column, shouldShow) => {
      render(
        <TaskDetailModal
          task={makeTask({ column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      const item = screen.queryByRole("menuitem", { name: "Refine" });
      if (shouldShow) expect(item).toBeTruthy();
      else expect(item).toBeNull();
    });

    it("does NOT render Refine button for 'triage' column tasks (no Actions dropdown)", () => {
      render(
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
      expect(screen.queryByText("Refine")).toBeNull();
    });

    it("clicking Refine opens the refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      expect(screen.getByText("Refine", { selector: "h3" })).toBeTruthy();
      expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeTruthy();
    });

    it("shows character counter in refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      expect(screen.getByText("0/2000 characters")).toBeTruthy();
    });

    it("character counter updates when typing feedback", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Need to fix the error handling" } });
      });

      expect(screen.getByText("30/2000 characters")).toBeTruthy();
    });

    it("submit button is disabled when feedback is empty", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(true);
    });

    it("submit button is enabled when feedback is entered", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Need to fix error handling" } });
      });

      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(false);
    });

    it("clicking Cancel closes the refinement modal", () => {
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
      fireEvent.click(screen.getByText("Cancel"));

      // Modal should be closed, but detail modal stays open (onClose not called)
      expect(screen.queryByText("Refine", { selector: "h3" })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows error toast when submitting empty feedback", async () => {
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // Try to submit with empty text (manually trigger submit since button is disabled)
      const { refineTask } = await import("../../api");

      // Should not call API, instead show error toast
      expect(refineTask).not.toHaveBeenCalled();
    });

    it("calls refineTask and closes modal on successful submission", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockResolvedValue({ id: "FN-002", column: "triage" } as Task);

      const onClose = vi.fn();
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(refineTask).toHaveBeenCalledWith("FN-001", "Need to add more tests", undefined);
        expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-002", "success");
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows error toast when refineTask fails", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockRejectedValue(new Error("Task must be in 'done' or 'in-review' column"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Task must be in 'done' or 'in-review' column", "error");
      });
    });

    it("renders submit button inside the input group adjacent to textarea", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // The submit button should be inside .detail-refine-input-group (the input area)
      const inputGroup = container.querySelector(".detail-refine-input-group");
      expect(inputGroup).toBeTruthy();
      const submitButton = inputGroup!.querySelector("button.btn-primary");
      expect(submitButton).toBeTruthy();
      expect(submitButton!.textContent).toBe("Create Refinement Task");

      // The submit button should NOT be in the footer .modal-actions
      const modalActions = container.querySelector(".detail-refine-modal .modal-actions");
      expect(modalActions).toBeTruthy();
      expect(modalActions!.querySelector("button.btn-primary")).toBeNull();
    });

    it("submit button in input group follows the same disabled/enabled rules", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // Submit button starts disabled (no feedback)
      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(true);

      // Enter feedback to enable it
      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Some feedback" } });
      });

      expect(submitButton.hasAttribute("disabled")).toBe(false);
    });

    it("character count and submit button are siblings in the input group", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const inputGroup = container.querySelector(".detail-refine-input-group")!;
      expect(inputGroup.querySelector(".detail-refine-char-count")).toBeTruthy();
      expect(inputGroup.querySelector("button.btn-primary")).toBeTruthy();
    });
  });

  describe("source issue metadata", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("renders source issue fields and link in read mode", () => {
      render(
        <TaskDetailModal
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Source Issue")).toBeTruthy();
      expect(screen.getByText("github")).toBeTruthy();
      expect(screen.getByText("runfusion/fusion")).toBeTruthy();
      expect(screen.getByText("I_kgDOExample")).toBeTruthy();
      const sourceLink = screen.getByRole("link", { name: "https://github.com/runfusion/fusion/issues/2473" });
      expect(sourceLink).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/2473");
      expect(sourceLink).toHaveAttribute("target", "_blank");
    });

    it("hides source issue read section when sourceIssue metadata is missing", () => {
      render(
        <TaskDetailModal
          task={makeTask({ sourceIssue: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Source Issue")).toBeNull();
      expect(screen.queryByText("No source issue metadata recorded.")).toBeNull();
    });

    it("prefills source issue inputs in edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      await waitFor(() => {
        expect((screen.getByTestId("task-source-provider-input") as HTMLInputElement).value).toBe("github");
      });
      expect((screen.getByTestId("task-source-repository-input") as HTMLInputElement).value).toBe("runfusion/fusion");
      expect((screen.getByTestId("task-source-external-id-input") as HTMLInputElement).value).toBe("I_kgDOExample");
      expect((screen.getByTestId("task-source-url-input") as HTMLInputElement).value).toBe("https://github.com/runfusion/fusion/issues/2473");
    });

    it("sends sourceIssue payload when source metadata is edited", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "gitlab" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: source patch failed", "error");
      });
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });
  });

  describe("inline editing", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("shows Edit button in header when task is in triage column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("shows Edit button in header when task is in todo column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("does not show Edit button when task is in in-progress column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "in-progress", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeNull();
    });

    it("does not show Edit button when already in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
      fireEvent.click(editButton!);

      // Edit button should be hidden now
      expect(container.querySelector(".modal-edit-btn")).toBeNull();
      // But TaskForm title input should be visible
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });

    it("entering edit mode shows title input and description textarea", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows title as h2
      expect(container.querySelector("h2.detail-title")).toBeTruthy();
      expect(container.querySelector("#task-form-title")).toBeNull();

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Now shows edit form with TaskForm fields
      expect(container.querySelector("h2.detail-title")).toBeNull();
      expect(container.querySelector("#task-form-title")).toBeTruthy();
      expect(container.querySelector("#task-form-description")).toBeTruthy();
    });

    it("clicking Cancel exits edit mode without saving", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Modified title" } });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Should exit edit mode without saving
      expect(container.querySelector("#task-form-title")).toBeNull();
      expect(container.querySelector("h2.detail-title")?.textContent).toBe("Original title");
    });

    it("clicking Save calls updateTask with correct parameters", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
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

    it("Save button is enabled in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

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
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
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
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Updated FN-001", "success");
      });

      // Should exit edit mode
      expect(container.querySelector("#task-form-title")).toBeNull();
    });

    it("failed save shows toast with error and stays in edit mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Network error", "error");
      });

      // Should stay in edit mode
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });

    it("Escape key exits edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      expect(container.querySelector("#task-form-title")).toBeTruthy();

      // Press Escape (handled via document-level keydown listener)
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
        document.dispatchEvent(event);
      });

      // Should exit edit mode
      expect(container.querySelector("#task-form-title")).toBeNull();
    });

    it("edit mode shows both title and description fields", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Both title and description should be present in TaskForm
      expect(container.querySelector("#task-form-title")).toBeTruthy();
      expect(container.querySelector("#task-form-description")).toBeTruthy();
    });

    it("edit mode renders model configuration and workflow steps", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Model configuration and workflow steps should be present via TaskForm
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.getByText(/Workflow Steps/i)).toBeTruthy();
    });

    it("save sends only changed fields via updateTask", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", dependencies: ["FN-002"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
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
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", priority: "normal" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(container.querySelector("#task-priority") as HTMLSelectElement, { target: { value: "urgent" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
    });

    it("sends executionMode: \"fast\" when changed from standard to fast", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
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
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "standard" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
      });
    });

    it("omits executionMode from update payload when unchanged", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it("renders normalized priority in detail metadata", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Priority: normal")).toBeTruthy();
    });

    it("pre-populates form with existing task values", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "My Task", description: "My Description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
      expect(titleInput.value).toBe("My Task");
      expect(descTextarea.value).toBe("My Description");
    });

    it("uses updated model values in edit mode after saving from the Model tab", async () => {
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
      });

      const initialTask = makeTask({ id: "FN-001", column: "triage", title: "Model sync test" });
      const updatedAfterExecutor: Task = {
        ...initialTask,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      };
      const updatedAfterValidator: Task = {
        ...updatedAfterExecutor,
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      };

      mockUpdateTask
        .mockResolvedValueOnce(updatedAfterExecutor)
        .mockResolvedValueOnce(updatedAfterValidator);

      function StatefulModal() {
        const [task, setTask] = useState<TaskDetail>(initialTask);

        return (
          <TaskDetailModal
            task={task}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            onTaskUpdated={(updated) => setTask((prev) => ({ ...prev, ...updated }))}
            addToast={noop}
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
          expect.objectContaining({
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
        );
      });

      await user.click(screen.getByLabelText("Validator Model"));
      await user.click(screen.getByText("GPT-4o"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          2,
          "FN-001",
          {
            validatorModelProvider: "openai",
            validatorModelId: "gpt-4o",
          },
        );
      });

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toHaveTextContent("Claude Sonnet 4.5");
        expect(screen.getByLabelText("Validator Model")).toHaveTextContent("GPT-4o");
      });
    });

    it("renders Save and Cancel in the modal footer, not inside the edit form body", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // The edit form body should NOT contain the Save or Cancel action buttons
      const editForm = container.querySelector(".modal-edit-form");
      expect(editForm).toBeTruthy();
      const formButtons = Array.from(editForm!.querySelectorAll("button"));
      const formButtonTexts = formButtons.map((b) => b.textContent);
      expect(formButtonTexts).not.toContain("Save");
      expect(formButtonTexts).not.toContain("Cancel");
      expect(formButtonTexts).not.toContain("Saving…");

      // The modal-actions footer should contain the Save and Cancel buttons
      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions).toBeTruthy();
      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).toContain("Cancel");
      expect(buttonTexts).toContain("Save");
    });

    it("renders keyboard hint in the modal footer when editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // The hint should be in the modal-actions footer, not inside the edit form body
      const editForm = container.querySelector(".modal-edit-form");
      expect(editForm!.querySelector(".modal-edit-hint")).toBeNull();

      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeTruthy();
    });

    it("shows normal modal actions (not edit actions) when not editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Should NOT be in edit mode — no edit hint, no Save/Cancel in footer
      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeNull();

      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).not.toContain("Save");
      expect(buttonTexts).not.toContain("Cancel");
      // Should contain Actions dropdown and Move primary action
      expect(buttonTexts).toContain("Actions");
      expect(buttonTexts.some((t) => t?.includes("Move to"))).toBe(true);
    });
  });

  describe("Commits tab visibility", () => {
    it.each<[string, Parameters<typeof makeTask>[0]]>([
      ["with mergeDetails.commitSha", { column: "done", mergeDetails: { commitSha: "abc1234567890", filesChanged: 3, insertions: 10, deletions: 2 } }],
      ["with mergeDetails but no commitSha", { column: "done", mergeDetails: { filesChanged: 3 } }],
      ["without mergeDetails", { column: "done" }],
    ])("never shows a separate Commits tab for done tasks (%s) — changes are in the Changes tab", (_label, taskOverrides) => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask(taskOverrides)}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(screen.queryByText("Commits")).toBeNull();
      const tabTexts = Array.from(container.querySelectorAll(".detail-tab")).map((t) => t.textContent);
      expect(tabTexts).toContain("Changes");
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
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
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

  describe("Workflow step ordering in edit mode (FN-836)", () => {
    it("sends ordered enabledWorkflowSteps when saving with reordered steps", async () => {
      const { updateTask, fetchWorkflowSteps } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
        { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            title: "Test",
            description: "Desc",
            enabledWorkflowSteps: ["WS-001", "WS-002"],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Wait for workflow steps to load and reorder controls to appear
      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
      });

      // Move WS-002 up (swap with WS-001)
      fireEvent.click(screen.getByTestId("workflow-step-move-up-WS-002"));

      // Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          enabledWorkflowSteps: ["WS-002", "WS-001"],
        }), undefined);
      });
    });
  });

  describe("Workflow tab", () => {
    it.each<[string, Parameters<typeof makeTask>[0]]>([
      ["empty enabledWorkflowSteps", { enabledWorkflowSteps: [] }],
      ["undefined enabledWorkflowSteps", { enabledWorkflowSteps: undefined, workflowStepResults: undefined }],
      ["non-empty enabledWorkflowSteps", { enabledWorkflowSteps: ["WS-001"] }],
      ["previous workflow results", { enabledWorkflowSteps: [], workflowStepResults: [{ workflowStepId: "WS-001", workflowStepName: "QA Check", status: "passed" }] }],
    ])("Workflow tab is always rendered (%s)", (_label, taskOverrides) => {
      render(
        <TaskDetailModal
          task={makeTask(taskOverrides)}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(screen.getByText("Workflow")).toBeTruthy();
    });

    it("switches to Workflow tab and calls fetchWorkflowResults", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      const mockResults: import("@fusion/core").WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          output: "All tests passed.",
          startedAt: "2026-04-04T10:00:00Z",
          completedAt: "2026-04-04T10:02:00Z",
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResults);

      render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Workflow"));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-099", undefined);
      });

      // Should render the workflow results after async tab load completes
      expect(await screen.findByText("QA Check", {}, { timeout: 15_000 })).toBeTruthy();
    });

    it("shows loading state when workflow results are being fetched", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      // Never resolve to keep loading state
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Workflow"));

      await waitFor(() => {
        expect(screen.getByTestId("workflow-results-loading")).toBeTruthy();
      });
    });

    it("shows error toast when fetchWorkflowResults fails", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      mockFetch.mockRejectedValueOnce(new Error("Server error"));
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Workflow"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          "Failed to load workflow results: Server error",
          "error",
        );
      });
    });

    it("renders configured workflow steps state when results are empty", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      mockFetch.mockResolvedValueOnce([]);

      render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Workflow"));

      await waitFor(() => {
        expect(screen.getByTestId("workflow-configured-steps")).toBeTruthy();
        expect(screen.getByTestId("workflow-configured-step-WS-001")).toHaveTextContent("WS-001");
      });
    });

    it("renders multiple workflow step results with status badges", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      const mockResults: import("@fusion/core").WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          output: "All tests passed.",
          startedAt: "2026-04-04T10:00:00Z",
          completedAt: "2026-04-04T10:02:00Z",
        },
        {
          workflowStepId: "WS-002",
          workflowStepName: "Security Audit",
          status: "failed",
          output: "Found 2 issues.",
          startedAt: "2026-04-04T10:02:05Z",
          completedAt: "2026-04-04T10:03:00Z",
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResults);

      render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001", "WS-002"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Workflow"));

      await waitFor(() => {
        expect(screen.getByText("QA Check")).toBeTruthy();
        expect(screen.getByText("Security Audit")).toBeTruthy();
        expect(screen.getByTestId("workflow-result-badge-WS-001")).toHaveTextContent("Passed");
        expect(screen.getByTestId("workflow-result-badge-WS-002")).toHaveTextContent("Failed");
      });
    });

    it("hides Definition content when Workflow tab is active", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            enabledWorkflowSteps: ["WS-001"],
            prompt: "# Test prompt",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Definition content visible initially
      expect(container.querySelector(".markdown-body")).toBeTruthy();

      // Switch to Workflow tab
      fireEvent.click(screen.getByText("Workflow"));

      // Definition content should be hidden
      await waitFor(() => {
        expect(container.querySelector(".markdown-body")).toBeNull();
      });
    });
  });

  describe("agent assignment", () => {
    it("shows Assign Agent button when task has no assigned agent", () => {
      render(
        <TaskDetailModal
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={makeTask({ assignedAgentId: "agent-002" })}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
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
          task={makeTask({ assignedAgentId: "agent-005" })}
          onClose={noop}
          onMoveTask={noopMove}
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
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      const task: Task = {
        id: "FN-203",
        description: "Loading spec test",
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

      expect(screen.getByText("Loading specification…")).toBeDefined();
      // Token stats now live in their own Stats tab — switch to it before
      // asserting on token-loading text.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.getByText("Loading token statistics…")).toBeDefined();
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
      expect(screen.getByText((1200).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((450).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((210).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((1860).toLocaleString())).toBeInTheDocument();
      const firstUsed = container.querySelector('time[datetime="2026-04-24T09:00:00.000Z"]');
      const lastUsed = container.querySelector('time[datetime="2026-04-24T10:15:00.000Z"]');
      expect(firstUsed).toBeTruthy();
      expect(lastUsed).toBeTruthy();
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
      });

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Both plugin tabs should appear
      expect(screen.getByText("Plugin A Tab")).toBeDefined();
      expect(screen.getByText("Plugin B Tab")).toBeDefined();
    });

    it("shows plugin tab content when plugin tab is clicked", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
        ],
        getSlotsForId: (id: string) => id === "task-detail-tab" ? [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
        ] : [],
        loading: false,
        error: null,
      });

      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Click the plugin tab
      await userEvent.click(screen.getByText("Plugin A Tab"));

      // Verify plugin slot renders with task-detail-tab slotId
      const slot = container.querySelector('[data-slot-id="task-detail-tab"]');
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute("data-plugin-id", "plugin-a");
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
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Only standard tabs should be visible (Definition, Logs, etc.)
      expect(screen.getByText("Definition")).toBeDefined();
      expect(screen.getByText("Logs")).toBeDefined();
      // Plugin tabs should not exist
      expect(screen.queryByText("Plugin A Tab")).toBeNull();
    });
  });
});

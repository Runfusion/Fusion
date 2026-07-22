/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
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
  mockUsePluginUiSlots,
  expectBaseRule,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
  taskDetailSseSubscriptions,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

type ActivitySegmentTestValue = "current" | "feed" | "raw-logs";

const ACTIVITY_VIEW_LABELS: Record<ActivitySegmentTestValue, string> = {
  current: "Live",
  feed: "Feed",
  "raw-logs": "Raw",
};

function selectActivityView(value: ActivitySegmentTestValue) {
  if (!screen.queryByRole("menu", { name: "Activity views" })) {
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  }
  fireEvent.click(screen.getByRole("menuitem", { name: ACTIVITY_VIEW_LABELS[value] }));
}

describe("TaskDetailModal", () => {
  describe("Raw Logs model resolution", () => {
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
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      return render(
        <TaskDetailModal
          initialTab="definition"
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
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      return render(
        <TaskDetailModal
          initialTab="definition"
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

    async function openAgentLogAndExpandModelDetails(container: HTMLElement) {
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      selectActivityView("raw-logs");

      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
      });

      const expandButton = screen.getByTestId("agent-log-model-expand") as HTMLButtonElement;
      if (expandButton.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(expandButton);
      }

      return container.querySelector("[data-testid='agent-log-model-header']") as HTMLElement;
    }

    it("uses task effective settings success path for Raw Logs model display", async () => {
      const { fetchTaskEffectiveSettings, fetchSettings } = await import("../../api");
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");

      vi.mocked(fetchTaskEffectiveSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        executionProvider: "overlay-executor",
        executionModelId: "overlay-executor-model",
        validatorProvider: "overlay-reviewer",
        validatorModelId: "overlay-reviewer-model",
        planningProvider: "overlay-planner",
        planningModelId: "overlay-planner-model",
      } as any);
      vi.mocked(useAgentLogs).mockReturnValue({
        entries: [mockLogEntry],
        loading: false,
        clear: vi.fn(),
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const header = await openAgentLogAndExpandModelDetails(container);
      await waitFor(() => expect(header.textContent).toContain("overlay-executor/overlay-executor-model"));
      expect(header.textContent).toContain("overlay-reviewer/overlay-reviewer-model");
      expect(header.textContent).toContain("overlay-planner/overlay-planner-model");
      expect(header.textContent).not.toContain("fallback-provider/fallback-model");
      expect(fetchSettings).not.toHaveBeenCalled();
    });

    it("shows resolved executor from settings when task has no explicit executor override", async () => {
      const { container } = await setupModelTest({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const header = await openAgentLogAndExpandModelDetails(container);

      // Validator should also fall back to the default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("shows the project default override before the global default", async () => {
      const { container } = await setupModelTest({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4o",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const header = await openAgentLogAndExpandModelDetails(container);
      const matches = header.textContent!.match(/openai\/gpt-4o/g);
      expect(matches).toHaveLength(3);
      expect(header.textContent).not.toContain("anthropic/claude-sonnet-4-5");
    });

    it("shows resolved validator from project validator settings when task has no validator override", async () => {
      const { container } = await setupModelTest({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      const header = await openAgentLogAndExpandModelDetails(container);
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

      const header = await openAgentLogAndExpandModelDetails(container);

      // Count occurrences - should appear three times (once for executor, once for validator, once for planning)
      const matches = header.textContent!.match(/anthropic\/claude-sonnet-4-5/g);
      expect(matches).toHaveLength(3);
    });

    it("shows task executor override even when settings provide a default", async () => {
      const { container } = await setupModelTestWithTask(
        { modelProvider: "openai", modelId: "gpt-4o" },
        { defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" },
      );

      const header = await openAgentLogAndExpandModelDetails(container);

      // Default model should not appear for executor
      expect(header.textContent).toContain("openai/gpt-4o");
      // Validator falls back to default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
    });

    it("shows task validator override even when settings provide a validator default", async () => {
      const { container } = await setupModelTestWithTask(
        { validatorModelProvider: "google", validatorModelId: "gemini-pro" },
        { defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
      );

      const header = await openAgentLogAndExpandModelDetails(container);
      // Executor falls back to default
      expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");
      // Settings validator should not appear (task override wins)
      expect(header.textContent).not.toContain("openai/gpt-4o");
    });

    it("shows 'Using default' for both when no models can be resolved", async () => {
      const { container } = await setupModelTest({
        // No defaultProvider/defaultModelId
      });

      const header = await openAgentLogAndExpandModelDetails(container);
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
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Wait for the failed fetch to settle
      const header = await openAgentLogAndExpandModelDetails(container);
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

      const header = await openAgentLogAndExpandModelDetails(container);
      // Executor uses task override
      expect(header.textContent).toContain("google/gemini-pro");
      // Validator uses settings-specific validator
      expect(header.textContent).toContain("openai/gpt-4o");
    });

    // Planning model resolution tests
    describe("Planning model resolution", () => {
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
            { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-099", text: "Planning using model: google/gemini-pro (thinking effort: high)", type: "text" as const, agent: "triage" },
          ],
          loading: false,
          clear: vi.fn(),
          loadMore: vi.fn(async () => {}),
          hasMore: false,
          total: null,
          loadingMore: false,
        });

        const { container } = render(
          <TaskDetailModal
            initialTab="definition"
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        const header = await openAgentLogAndExpandModelDetails(container);

        // Planning should show the runtime triage marker, not settings default
        expect(header.textContent).toContain("Planning:");
        expect(header.textContent).toContain("google/gemini-pro");
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
          loadMore: vi.fn(async () => {}),
          hasMore: false,
          total: null,
          loadingMore: false,
        });

        const { container } = render(
          <TaskDetailModal
            initialTab="definition"
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        const header = await openAgentLogAndExpandModelDetails(container);

        // Planning should use planningProvider/planningModelId from settings
        expect(header.textContent).toContain("Planning:");
        expect(header.textContent).toContain("openai/gpt-4o");
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

        const header = await openAgentLogAndExpandModelDetails(container);

        expect(header.textContent).toContain("Planning:");
        expect(header.textContent).toContain("anthropic/claude-sonnet-4-5");

        // Planning falls back to default - same as executor/validator
        const matches = header.textContent!.match(/anthropic\/claude-sonnet-4-5/g);
        expect(matches).toHaveLength(3); // executor, validator, planning
      });

      it("shows 'Using default' for planning when no models can be resolved", async () => {
        const { container } = await setupModelTest({
          // No defaultProvider/defaultModelId
        });

        const header = await openAgentLogAndExpandModelDetails(container);
        expect(header.textContent).toContain("Planning:");
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
          loadMore: vi.fn(async () => {}),
          hasMore: false,
          total: null,
          loadingMore: false,
        });

        const { container } = render(
          <TaskDetailModal
            initialTab="definition"
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

        const header = await openAgentLogAndExpandModelDetails(container);
        // Per-task override should take precedence over settings
        expect(header.textContent).toContain("Planning:");
        expect(header.textContent).toContain("google/gemini-2.5-pro");
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
            { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-099", text: "Planning using model: google/gemini-pro", type: "text" as const, agent: "triage" },
          ],
          loading: false,
          clear: vi.fn(),
          loadMore: vi.fn(async () => {}),
          hasMore: false,
          total: null,
          loadingMore: false,
        });

        const { container } = render(
          <TaskDetailModal
            initialTab="definition"
            task={makeTask({ prompt: "# Hello\n\nContent" })}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        const header = await openAgentLogAndExpandModelDetails(container);
        // Runtime marker should win over planning settings
        expect(header.textContent).toContain("google/gemini-pro");
        // Should NOT show the planning settings model
        expect(header.textContent).not.toContain("openai/gpt-4o");
      });
    });
  });

    it("shows executor/reviewer models from runtime agent-log markers", async () => {
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
          { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-099", text: "Executor using model: openai/gpt-4o (thinking effort: high)", type: "text" as const, agent: "executor" },
          { timestamp: "2026-01-01T00:00:02Z", taskId: "FN-099", text: "Reviewer using model: google/gemini-2.5-pro (thinking effort: medium)", type: "text" as const, agent: "reviewer" },
        ],
        loading: false,
        clear: vi.fn(),
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      selectActivityView("raw-logs");
      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
      });
      const expandButton = screen.getByTestId("agent-log-model-expand") as HTMLButtonElement;
      if (expandButton.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(expandButton);
      }
      const header = container.querySelector("[data-testid='agent-log-model-header']") as HTMLElement;
      expect(header.textContent).toContain("openai/gpt-4o");
      expect(header.textContent).toContain("google/gemini-2.5-pro");
    });

    it("falls back to assigned-agent runtime model when no runtime marker exists", async () => {
      const { fetchSettings, fetchAgent } = await import("../../api");
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");

      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      } as any);
      vi.mocked(fetchAgent).mockResolvedValueOnce({
        id: "agent-1",
        name: "Agent One",
        role: "executor",
        state: "active",
        runtimeConfig: { model: "openai/gpt-4.1" },
      } as any);

      vi.mocked(useAgentLogs).mockReturnValue({
        entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "FN-099", text: "hello", type: "text" as const }],
        loading: false,
        clear: vi.fn(),
        loadMore: vi.fn(async () => {}),
        hasMore: false,
        total: null,
        loadingMore: false,
      });

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt: "# Hello\n\nContent", assignedAgentId: "agent-1", status: "executing", column: "in-progress" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      selectActivityView("raw-logs");
      await waitFor(() => {
        const header = container.querySelector("[data-testid='agent-log-model-header']");
        expect(header).toBeTruthy();
      });
      const expandButton = screen.getByTestId("agent-log-model-expand") as HTMLButtonElement;
      if (expandButton.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(expandButton);
      }
      const header = container.querySelector("[data-testid='agent-log-model-header']") as HTMLElement;
      expect(header.textContent).toContain("openai/gpt-4.1");
    });

  describe("step progress", () => {
    it("renders step progress section when steps exist", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
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
          initialTab="definition"
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
          initialTab="definition"
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
          initialTab="definition"
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

    it("renders a segment for each ENABLED workflow step, not only implementation steps", () => {
      // Regression: the detail Progress bar must include enabled optional workflow steps.
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "pending" },
            ],
            enabledWorkflowSteps: ["code-review", "browser-verification"],
            workflowStepResults: [
              { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed" },
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
      // 2 impl steps + 2 enabled workflow steps = 4 segments.
      expect(segments).toHaveLength(4);
      const workflowSegments = container.querySelectorAll(".step-progress-segment--source-workflow");
      expect(workflowSegments).toHaveLength(2);
      // code-review ran (passed → unified "done"); browser-verification enabled-not-run (pending).
      expect(segments[2].classList.contains("step-progress-segment--done")).toBe(true);
      expect(segments[3].classList.contains("step-progress-segment--pending")).toBe(true);
    });

    it("segments have correct inline background colors based on status", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "skipped" },
              { name: "Step 5", status: "mystery" },
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
      expect((segments[0] as HTMLElement).style.backgroundColor).toBe("var(--color-success)");
      expect((segments[1] as HTMLElement).style.backgroundColor).toBe("var(--in-progress)");
      expect((segments[2] as HTMLElement).style.backgroundColor).toBe("var(--border)");
      expect((segments[3] as HTMLElement).style.backgroundColor).toBe("var(--text-dim)");
      expect((segments[4] as HTMLElement).style.backgroundColor).toBe("var(--border)");
    });

    it("displays singular completion label for one-step tasks", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
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
          initialTab="definition"
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
          initialTab="definition"
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

    it("step progress only renders in Definition tab, not in Raw Logs segment", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
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

      // Switch to Activity tab, then Raw Logs segment
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      selectActivityView("raw-logs");

      // Should not be visible in Raw Logs segment
      expect(container.querySelector(".detail-step-progress")).toBeNull();
    });

    it("step progress is hidden in Comments tab", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
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


  describe("Commits tab visibility", () => {
    it.each<[string, Parameters<typeof makeTask>[0]]>([
      ["with mergeDetails.commitSha", { column: "done", mergeDetails: { commitSha: "abc1234567890", filesChanged: 3, insertions: 10, deletions: 2 } }],
      ["with mergeDetails but no commitSha", { column: "done", mergeDetails: { filesChanged: 3 } }],
      ["without mergeDetails", { column: "done" }],
    ])("never shows a separate Commits tab for done tasks (%s) — changes are in the Changes tab", (_label, taskOverrides) => {
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
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
          initialTab="definition"
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
          initialTab="definition"
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
  describe("Workflow tab", () => {
    it.each<[string, Parameters<typeof makeTask>[0]]>([
      ["empty enabledWorkflowSteps", { enabledWorkflowSteps: [] }],
      ["undefined enabledWorkflowSteps", { enabledWorkflowSteps: undefined, workflowStepResults: undefined }],
      ["non-empty enabledWorkflowSteps", { enabledWorkflowSteps: ["WS-001"] }],
      ["previous workflow results", { enabledWorkflowSteps: [], workflowStepResults: [{ workflowStepId: "WS-001", workflowStepName: "QA Check", status: "passed" }] }],
    ])("Workflow tab is always rendered (%s)", (_label, taskOverrides) => {
      render(
        <TaskDetailModal
          initialTab="definition"
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

    it("saves workflow step toggles from task edit mode", async () => {
      const { fetchBoardWorkflows, fetchWorkflowOptionalSteps, updateTask } = await import("../../api");
      vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "wf-edit",
        workflows: [{ id: "wf-edit", name: "Edit Workflow" }],
        taskWorkflowIds: { "FN-099": "wf-edit" },
      } as any);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValueOnce([
        { templateId: "code-review", name: "Code Review", phase: "pre-merge", defaultOn: true },
        { templateId: "browser-verification", name: "Browser Verification", phase: "pre-merge", defaultOn: false },
      ] as any);
      vi.mocked(updateTask).mockResolvedValueOnce(makeTask({ enabledWorkflowSteps: ["browser-verification", "code-review"] }) as any);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "todo" as any, enabledWorkflowSteps: ["browser-verification"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
      const trigger = await screen.findByTestId("task-form-edit-optional-steps");
      expect(trigger).toHaveTextContent("Steps: 1 selected");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-code-review"));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith(
          "FN-099",
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification", "code-review"] }),
          undefined,
        );
      });
    });

    it("does not reset enabled workflow steps when saving unrelated edit fields", async () => {
      const { fetchBoardWorkflows, fetchWorkflowOptionalSteps, updateTask } = await import("../../api");
      vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "wf-edit",
        workflows: [{ id: "wf-edit", name: "Edit Workflow" }],
        taskWorkflowIds: { "FN-099": "wf-edit" },
      } as any);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValueOnce([
        { templateId: "code-review", name: "Code Review", phase: "pre-merge", defaultOn: true },
        { templateId: "browser-verification", name: "Browser Verification", phase: "pre-merge", defaultOn: false },
      ] as any);
      vi.mocked(updateTask).mockResolvedValueOnce(makeTask({ title: "Edited title", enabledWorkflowSteps: ["browser-verification"] }) as any);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "todo" as any, title: "Original title", enabledWorkflowSteps: ["browser-verification"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
      await screen.findByTestId("task-form-edit-optional-steps");
      const titleInput = screen.getByRole("textbox", { name: /Title/i });
      fireEvent.change(titleInput, { target: { value: "Edited title" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith(
          "FN-099",
          expect.not.objectContaining({ enabledWorkflowSteps: expect.anything() }),
          undefined,
        );
      });
      expect(updateTask).toHaveBeenCalledWith(
        "FN-099",
        expect.objectContaining({ title: "Edited title" }),
        undefined,
      );
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
          initialTab="definition"
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
      mockFetch.mockResolvedValueOnce(new Promise(() => {}) as any);

      render(
        <TaskDetailModal
          initialTab="definition"
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
          initialTab="definition"
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

    it("updates workflow results from matching task:updated SSE events while ignoring other tasks", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      mockFetch.mockResolvedValueOnce([
        {
          workflowStepId: "WS-INITIAL",
          workflowStepName: "Initial Check",
          status: "pending",
          output: "Initial output",
        },
      ] as import("@fusion/core").WorkflowStepResult[]);

      render(
        <TaskDetailModal
          initialTab="workflow"
          task={makeTask({ id: "FN-099", enabledWorkflowSteps: ["WS-INITIAL"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByText("Initial Check", {}, { timeout: 15_000 })).toBeTruthy();
      await waitFor(() => {
        expect(taskDetailSseSubscriptions.some(({ options }) => typeof options.events?.["task:updated"] === "function")).toBe(true);
      });
      const workflowSubscription = taskDetailSseSubscriptions.find(({ options }) => typeof options.events?.["task:updated"] === "function");
      const emitTaskUpdated = workflowSubscription!.options.events!["task:updated"];

      await act(async () => {
        emitTaskUpdated(new MessageEvent("task:updated", {
          data: JSON.stringify({
            id: "FN-OTHER",
            workflowStepResults: [
              { workflowStepId: "WS-OTHER", workflowStepName: "Other Task Check", status: "failed", output: "Wrong task" },
            ],
          }),
        }));
      });

      expect(screen.queryByText("Other Task Check")).not.toBeInTheDocument();
      expect(screen.getByText("Initial Check")).toBeTruthy();

      await act(async () => {
        emitTaskUpdated(new MessageEvent("task:updated", {
          data: JSON.stringify({
            id: "FN-099",
            workflowStepResults: [
              { workflowStepId: "WS-LIVE", workflowStepName: "Live QA Check", status: "passed", output: "Updated from SSE" },
            ],
          }),
        }));
      });

      expect(await screen.findByText("Live QA Check")).toBeTruthy();
      expect(screen.getByText("Updated from SSE")).toBeTruthy();
      expect(screen.queryByText("Initial Check")).not.toBeInTheDocument();
    });

    it("clears stale workflow results immediately when switching tasks while the tab stays mounted", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      let resolveNextResults: (results: import("@fusion/core").WorkflowStepResult[]) => void = () => {};
      const nextResultsPromise = new Promise<import("@fusion/core").WorkflowStepResult[]>((resolve) => {
        resolveNextResults = resolve;
      });
      mockFetch
        .mockResolvedValueOnce([
          { workflowStepId: "WS-INITIAL", workflowStepName: "Initial Check", status: "passed", output: "Initial output" },
        ] as import("@fusion/core").WorkflowStepResult[])
        .mockReturnValueOnce(nextResultsPromise);

      const { rerender } = render(
        <TaskDetailModal
          initialTab="workflow"
          task={makeTask({ id: "FN-099", enabledWorkflowSteps: ["WS-INITIAL"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByText("Initial Check", {}, { timeout: 15_000 })).toBeTruthy();

      rerender(
        <TaskDetailModal
          initialTab="workflow"
          task={makeTask({ id: "FN-200", enabledWorkflowSteps: ["WS-NEXT"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("FN-200", undefined));
      await waitFor(() => expect(screen.queryByText("Initial Check")).not.toBeInTheDocument());
      expect(screen.getByTestId("workflow-results-loading")).toBeTruthy();

      await act(async () => {
        resolveNextResults([
          { workflowStepId: "WS-NEXT", workflowStepName: "Next Task Check", status: "passed", output: "Next output" },
        ] as import("@fusion/core").WorkflowStepResult[]);
        await nextResultsPromise;
      });

      expect(await screen.findByText("Next Task Check")).toBeTruthy();
      expect(screen.queryByText("Initial Check")).not.toBeInTheDocument();
    });

    it("renders configured workflow steps state when results are empty", async () => {
      const { fetchWorkflowResults } = await import("../../api");
      const mockFetch = vi.mocked(fetchWorkflowResults);
      mockFetch.mockResolvedValueOnce([]);

      render(
        <TaskDetailModal
          initialTab="definition"
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
          initialTab="definition"
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
          initialTab="definition"
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


});

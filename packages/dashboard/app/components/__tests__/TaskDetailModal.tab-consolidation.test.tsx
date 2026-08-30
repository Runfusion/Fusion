import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TaskDetail, TaskTokenUsage } from "@fusion/core";
import {
  makeTask,
  mockUsePluginUiSlots,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

const expectedInProgressTabs = [
  "Activity", "Chat", "Plan", "Changes", "Summary", "Stats", "Review", "Comments",
  "Dependencies", "Artifacts", "Model", "Workflow", "Details", "Terminal",
];

function tabLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
    .map((button) => button.textContent?.trim() ?? "");
}

function detail(task: TaskDetail, initialTab?: any) {
  return (
    <TaskDetailContent
      {...sharedProps}
      embedded
      task={task}
      initialTab={initialTab}
    />
  );
}

function tokenUsage(): TaskTokenUsage {
  return {
    inputTokens: 200,
    outputTokens: 100,
    cachedTokens: 20,
    cacheWriteTokens: 0,
    totalTokens: 320,
    firstUsedAt: "2026-08-28T00:00:00.000Z",
    lastUsedAt: "2026-08-28T00:01:00.000Z",
    perModel: [{
      modelProvider: "openai-codex",
      modelId: "gpt-5.5",
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 320,
      firstUsedAt: "2026-08-28T00:00:00.000Z",
      lastUsedAt: "2026-08-28T00:01:00.000Z",
    }],
  };
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  mockUsePluginUiSlots.mockReturnValue({
    slots: [],
    getSlotsForId: vi.fn(() => []),
    loading: false,
    error: null,
  });
});

describe("TaskDetailModal tab consolidation", () => {
  it("renders the consolidated desktop inventory in canonical order", () => {
    render(detail(makeTask({ column: "in-progress", worktree: "/workspace/FN-244" })));

    expect(tabLabels()).toEqual(expectedInProgressTabs);
    expect(document.querySelectorAll(".detail-tabs .detail-tab")).toHaveLength(expectedInProgressTabs.length);
    for (const removedTab of ["Cost", "Routing", "Debug", "Attachments", "Recommendations"]) {
      expect(screen.queryByRole("button", { name: removedTab })).toBeNull();
    }
  });

  it.each([
    ["logs", "Activity", "feed"],
    ["history", "Summary", "summary"],
    ["retries", "Details", "details"],
    ["recommendations", "Summary", "summary"],
    ["cost", "Stats", "stats"],
    ["attachments", "Artifacts", "artifacts"],
    ["routing", "Details", "routing"],
    ["debug", "Details", "debug"],
  ] as const)("routes legacy %s deep links to %s", (initialTab, activeLabel, body) => {
    render(detail(makeTask({ retrySummary: { total: 1 } }), initialTab));

    expect(screen.getByRole("button", { name: activeLabel })).toHaveClass("detail-tab-active");
    if (body === "feed") {
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(screen.getByRole("menuitem", { name: "Feed" })).toHaveAttribute("aria-current", "true");
    } else if (body === "summary") {
      expect(screen.getByTestId("task-summary-tab")).toBeInTheDocument();
    } else if (body === "stats") {
      expect(screen.getByTestId("task-cost-tab")).toBeInTheDocument();
    } else if (body === "artifacts") {
      expect(screen.getByRole("button", { name: "Attach Screenshot" })).toBeInTheDocument();
    } else if (body === "routing") {
      expect(screen.getByRole("button", { name: "Collapse routing details" })).toHaveAttribute("aria-expanded", "true");
    } else if (body === "debug") {
      expect(screen.getByRole("button", { name: "Collapse debug details" })).toHaveAttribute("aria-expanded", "true");
    } else {
      expect(document.querySelector(".detail-section--original-prompt")).toBeInTheDocument();
    }
  });

  it("renders completion, spend, and merge facts under exactly one consolidated owner", async () => {
    const apiModule = await import("../../api");
    vi.spyOn(apiModule, "fetchTaskDiff").mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
    const completion = "Completed exactly once in the agent report.";
    const task = makeTask({
      column: "done",
      summary: completion,
      tokenUsage: tokenUsage(),
      mergeDetails: {
        commitSha: "abcdef1234567890",
        mergedAt: "2026-08-28T01:00:00.000Z",
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
      },
    });

    render(detail(task, "summary"));

    expect(screen.getAllByText(completion)).toHaveLength(1);
    expect(screen.queryByTestId("task-cost-row")).toBeNull();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(screen.getByTestId("task-cost-row")).toBeInTheDocument();
    expect(screen.getAllByTestId("task-cost-total")).toHaveLength(1);
    expect(screen.queryByText(completion)).toBeNull();
    expect(screen.queryByText("abcdef1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(screen.getByText("No files modified.")).toBeInTheDocument());
    expect(screen.queryByText("abcdef1")).toBeNull();
    expect(screen.queryByText(completion)).toBeNull();
    expect(screen.queryByTestId("task-cost-row")).toBeNull();
  });

  it("uses the same consolidated tab strip for an embedded host", () => {
    render(detail(makeTask({ column: "in-progress" })));

    expect(tabLabels()).toEqual(expectedInProgressTabs);
  });

  it("keeps plugin tabs after the consolidated built-ins", () => {
    mockUsePluginUiSlots.mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => [{
        pluginId: "test-plugin",
        slot: { slotId: "task-detail-tab", label: "Plugin detail", componentPath: "./detail.js" },
      }]),
      loading: false,
      error: null,
    });

    render(detail(makeTask({ column: "in-progress" })));

    expect(tabLabels()).toEqual([...expectedInProgressTabs, "Plugin detail"]);
  });

  it("keeps the exact tab inventory on a narrow viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("max-width") || query.includes("max-width: 768px"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });

    render(detail(makeTask({ column: "in-progress" })));

    expect(tabLabels()).toEqual(expectedInProgressTabs);
    expect(document.querySelector(".detail-tabs")).toBeInTheDocument();
  });

  it("keeps Summary available for todo tasks", () => {
    render(detail(makeTask({ column: "todo" })));

    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-summary-tab")).toBeInTheDocument();
  });

  it("shows token totals and per-model costs together in Stats", () => {
    render(detail(makeTask({ tokenUsage: tokenUsage() }), "stats"));

    expect(screen.getByRole("region", { name: "Task execution statistics" })).toBeInTheDocument();
    expect(screen.getByTestId("task-cost-row")).toBeInTheDocument();
    expect(screen.getByTestId("task-cost-total")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cost" })).toBeNull();
  });

  it("keeps Activity limited to live operational views", () => {
    const ordinary = render(detail(makeTask({ plannerOversightLevel: "off" })));
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Live", "Feed", "Raw"]);
    expect(screen.getAllByRole("menuitem").every((item) => Boolean(item.textContent?.trim()))).toBe(true);
    ordinary.unmount();

    render(detail(makeTask({ plannerOversightLevel: "autonomous" })));
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Live", "Feed", "Raw", "Interventions"]);
  });
});

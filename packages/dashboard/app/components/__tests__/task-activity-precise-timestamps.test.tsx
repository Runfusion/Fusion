import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentLogEntry, PlannerInterventionEntry } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import { AgentLogViewer } from "../AgentLogViewer";
import { TaskChatTab } from "../TaskChatTab";
import { PlannerInterventionTimeline } from "../PlannerInterventionTimeline";
import { useAgentLogs } from "../../hooks/useAgentLogs";
import * as api from "../../api";

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(),
}));

setupTaskDetailModalHooks();

const mockedUseAgentLogs = vi.mocked(useAgentLogs);

function makeAgentEntry(timestamp: string): AgentLogEntry {
  return {
    taskId: "FN-272",
    timestamp,
    type: "text",
    agent: "executor",
    text: "timestamped activity",
  };
}

function makeIntervention(timestamp: string): PlannerInterventionEntry {
  return {
    id: "intervention-1",
    taskId: "FN-272",
    timestamp,
    stage: "executor",
    reason: "Timestamp coverage",
    action: "observe",
    outcome: "succeeded",
  };
}

describe("task activity precise timestamp invariant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 17, 14, 32, 30, 0));
    mockedUseAgentLogs.mockReturnValue({
      entries: [],
      loading: false,
      clear: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
      total: 0,
      loadingMore: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps every Activity surface on the same millisecond clock format", async () => {
    const timestamp = new Date(2026, 5, 17, 14, 32, 7, 482).toISOString();
    const expectedClock = "14:32:07.482";

    const rawLogs = render(<AgentLogViewer entries={[makeAgentEntry(timestamp)]} loading={false} />);
    expect(screen.getByTestId("agent-log-precise-timestamp")).toHaveTextContent(expectedClock);
    rawLogs.unmount();

    const feed = render(
      <TaskDetailModal
        task={makeTask({ id: "FN-272", log: [{ timestamp, action: "Timestamped activity" }] })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));
    expect(screen.getByTestId("task-activity-precise-timestamp")).toHaveTextContent(expectedClock);
    feed.unmount();

    mockedUseAgentLogs.mockReturnValue({
      entries: [makeAgentEntry(timestamp)],
      loading: false,
      clear: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
      total: 1,
      loadingMore: false,
    });
    const live = render(<TaskChatTab task={makeTask({ id: "FN-272" })} active addToast={vi.fn()} />);
    expect(screen.getByTestId("task-chat-group-time-precise")).toHaveTextContent(expectedClock);
    live.unmount();

    const plannerFetch = vi.spyOn(api, "fetchPlannerInterventionTimeline").mockResolvedValue({
      entries: [makeIntervention(timestamp)],
    });
    render(<PlannerInterventionTimeline taskId="FN-272" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("planner-intervention-entry")).toHaveTextContent(expectedClock);
    expect(plannerFetch).toHaveBeenCalledWith("FN-272", undefined);
  });
});

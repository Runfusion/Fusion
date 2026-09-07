import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useTaskRecommendations } from "../../hooks/useTaskRecommendations";
import { RecommendationsView } from "../RecommendationsView";

vi.mock("../../hooks/useTaskRecommendations", () => ({
  useTaskRecommendations: vi.fn(),
}));

const mockUseTaskRecommendations = vi.mocked(useTaskRecommendations);
const createTask = vi.fn(async () => {});
const loadMore = vi.fn(async () => {});
const refresh = vi.fn(async () => {});

const recommendationItem = {
  taskId: "FN-100",
  taskTitle: "Source task",
  taskColumn: "done",
  updatedAt: "2026-09-06T00:00:00.000Z",
  recommendation: {
    id: "follow-up-tests",
    title: "Add coverage",
    description: "Cover the remaining workflow.",
    category: "improvement" as const,
  },
};

function recommendationState(overrides: Partial<ReturnType<typeof useTaskRecommendations>> = {}): ReturnType<typeof useTaskRecommendations> {
  return {
    items: [recommendationItem],
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    totalRowCount: 1,
    truncated: false,
    refresh,
    loadMore,
    createTask,
    createStates: new Map(),
    ...overrides,
  };
}

describe("RecommendationsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTaskRecommendations.mockReturnValue(recommendationState());
  });

  it("renders recommendation details and creates the selected task", () => {
    render(<RecommendationsView projectId="proj-a" />);

    expect(screen.getByText("Add coverage")).toBeInTheDocument();
    expect(screen.getByText("Cover the remaining workflow.")).toBeInTheDocument();
    expect(screen.getByText(/FN-100/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(createTask).toHaveBeenCalledWith("FN-100", "follow-up-tests");
  });

  it("renders the empty state without recommendation rows", () => {
    mockUseTaskRecommendations.mockReturnValue(recommendationState({ items: [], totalRowCount: 0 }));
    render(<RecommendationsView projectId="proj-a" />);

    expect(screen.getByTestId("recommendations-empty")).toBeInTheDocument();
    expect(screen.queryByTestId(/^task-recommendation-/)).not.toBeInTheDocument();
  });

  it("marks a project seen once after unread data arrives and ignores rerenders", () => {
    const onSeen = vi.fn();
    const { rerender } = render(
      <RecommendationsView projectId="proj-a" unreadCount={0} onSeen={onSeen} />,
    );
    expect(onSeen).not.toHaveBeenCalled();

    rerender(<RecommendationsView projectId="proj-a" unreadCount={3} onSeen={onSeen} />);
    expect(onSeen).toHaveBeenCalledTimes(1);
    rerender(<RecommendationsView projectId="proj-a" unreadCount={4} onSeen={onSeen} />);
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it("loads more recommendations when another page is available", () => {
    mockUseTaskRecommendations.mockReturnValue(recommendationState({ hasMore: true, totalRowCount: 2 }));
    render(<RecommendationsView projectId="proj-a" />);

    fireEvent.scroll(screen.getByTestId("recommendations-auto-pagination-sentinel").parentElement!);
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("treats an undefined project as a signallable project identity", () => {
    const onSeen = vi.fn();
    const { rerender } = render(
      <RecommendationsView projectId={undefined} unreadCount={2} onSeen={onSeen} />,
    );
    expect(onSeen).toHaveBeenCalledTimes(1);

    rerender(<RecommendationsView projectId="proj-a" unreadCount={2} onSeen={onSeen} />);
    expect(onSeen).toHaveBeenCalledTimes(2);
  });

  it("re-arms the seen latch after a project switch but not another render", () => {
    const onSeen = vi.fn();
    const { rerender } = render(
      <RecommendationsView projectId="proj-a" unreadCount={3} onSeen={onSeen} />,
    );
    expect(onSeen).toHaveBeenCalledTimes(1);

    rerender(<RecommendationsView projectId="proj-b" unreadCount={4} onSeen={onSeen} />);
    expect(onSeen).toHaveBeenCalledTimes(2);
    rerender(<RecommendationsView projectId="proj-b" unreadCount={5} onSeen={onSeen} />);
    expect(onSeen).toHaveBeenCalledTimes(2);
  });

  it("opens an already-created task", () => {
    const onOpenTask = vi.fn();
    mockUseTaskRecommendations.mockReturnValue(recommendationState({
      items: [{
        ...recommendationItem,
        recommendation: { ...recommendationItem.recommendation, createdTaskId: "FN-101" },
      }],
    }));
    render(<RecommendationsView projectId="proj-a" onOpenTask={onOpenTask} />);

    fireEvent.click(screen.getByRole("button", { name: "View task" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-101");
  });
});

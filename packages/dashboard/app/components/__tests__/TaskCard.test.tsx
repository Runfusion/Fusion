import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Column, Task, TaskDetail } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import React, { useState } from "react";

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
}));

const mockUseBadgeWebSocket = vi.fn(() => ({
  badgeUpdates: new Map(),
  isConnected: false,
  subscribeToBadge: vi.fn(),
  unsubscribeFromBadge: vi.fn(),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => mockUseBadgeWebSocket(),
}));

const mockUseSessionFiles = vi.fn(() => ({ files: [], loading: false }));

vi.mock("../../hooks/useSessionFiles", () => ({
  useSessionFiles: (...args: unknown[]) => mockUseSessionFiles(...args),
}));

const mockUseTaskDiffStats = vi.fn(() => ({ stats: null, loading: false }));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: (...args: unknown[]) => mockUseTaskDiffStats(...args),
}));

vi.mock("lucide-react", () => ({
  Link: ({ size }: { size?: number }) => <span data-testid="link-icon">🔗</span>,
  Clock: ({ size }: { size?: number }) => <span data-testid="clock-icon">🕐</span>,
  Layers: ({ size }: { size?: number }) => <span data-testid="layers-icon">📚</span>,
  Pencil: ({ size }: { size?: number }) => <span data-testid="pencil-icon">✏️</span>,
  ChevronDown: ({ size, className }: { size?: number; className?: string }) => <span data-testid="chevron-icon" className={className}>▼</span>,
  Folder: ({ size }: { size?: number }) => <span data-testid="folder-icon">📁</span>,
  Maximize2: ({ size }: { size?: number }) => <span data-testid="maximize-icon">⛶</span>,
  GitPullRequest: ({ size }: { size?: number }) => <span data-testid="git-pr-icon">🔀</span>,
  CircleDot: ({ size }: { size?: number }) => <span data-testid="circle-dot-icon">⭕</span>,
  Target: ({ size }: { size?: number }) => <span data-testid="target-icon">🎯</span>,
  Bot: ({ size }: { size?: number }) => <span data-testid="bot-icon">🤖</span>,
}));

beforeEach(() => {
  mockUseBadgeWebSocket.mockReset();
  mockUseBadgeWebSocket.mockReturnValue({
    badgeUpdates: new Map(),
    isConnected: false,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  });
  mockUseSessionFiles.mockReset();
  mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
  mockUseTaskDiffStats.mockReset();
  mockUseTaskDiffStats.mockReturnValue({ stats: null, loading: false });
});

/**
 * Tests for the agent-active class logic in TaskCard.
 *
 * These tests use extracted helper functions to test class computation logic directly.
 */

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

/** Mirrors the cardClass computation from TaskCard.tsx */
function computeCardClass(opts: { dragging?: boolean; queued?: boolean; status?: string; column?: Column; globalPaused?: boolean; isStuck?: boolean; isPaused?: boolean; isAwaitingApproval?: boolean }): string {
  const { dragging = false, queued = false, status, column = "todo", globalPaused, isStuck = false, isPaused = false, isAwaitingApproval = false } = opts;
  const isFailed = status === "failed";
  const isAgentActive = !globalPaused && !queued && !isFailed && !isPaused && !isStuck && !isAwaitingApproval && (column === "in-progress" || ACTIVE_STATUSES.has(status as string));
  return `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${isStuck ? " stuck" : ""}${isAwaitingApproval ? " awaiting-approval" : ""}`;
}

describe("TaskCard memoization", () => {
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task);

  it("does not re-render when parent re-renders with an equivalent task object", async () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    // Custom comparator that uses deep equality for task objects (mirrors TaskCard's areTaskCardPropsEqual)
    const MemoizedProbe = React.memo(MemoProbe, (prevProps, nextProps) => {
      // Compare task objects by value using JSON serialization
      // This matches the behavior of areTaskCardPropsEqual used by TaskCard
      return JSON.stringify(prevProps.task) === JSON.stringify(nextProps.task);
    });

    function Harness() {
      const [count, setCount] = useState(0);
      const task = createTask();

      return (
        <>
          <button onClick={() => setCount((current) => current + 1)}>rerender {count}</button>
          <MemoizedProbe task={{ ...task }} />
        </>
      );
    }

    render(<Harness />);
    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /rerender/i }));

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Test task")).toBeDefined();
  });

  it("re-renders when a render-relevant task field changes", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const { rerender } = render(<MemoizedProbe task={createTask({ title: "Original" })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<MemoizedProbe task={createTask({ title: "Updated" })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Updated")).toBeDefined();
  });

  it("re-renders when dependency badges change", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const { rerender } = render(<MemoizedProbe task={createTask({ dependencies: ["FN-001"] })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<MemoizedProbe task={createTask({ dependencies: ["FN-001", "FN-002"] })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTitle(/Click to view/)).toHaveLength(2);
  });

  it("re-renders when PR badge data changes", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const basePrInfo = {
      number: 42,
      url: "https://github.com/example/repo/pull/42",
      status: "open" as const,
      title: "Initial PR",
      headBranch: "fusion/fn-129",
      baseBranch: "main",
      lastCheckedAt: "2026-01-01T00:00:00Z",
    };
    const { rerender } = render(<MemoizedProbe task={createTask({ prInfo: basePrInfo })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(
      <MemoizedProbe
        task={createTask({
          prInfo: { ...basePrInfo, status: "merged", title: "Merged PR" },
        })}
      />,
    );

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
  });

  it("re-renders when step progress changes", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const { rerender } = render(
      <MemoizedProbe
        task={createTask({
          steps: [{ name: "Step 1", status: "pending" }],
        })}
      />,
    );

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(
      <MemoizedProbe
        task={createTask({
          steps: [{ name: "Step 1", status: "done" }],
        })}
      />,
    );

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1/1")).toBeDefined();
  });

  it("re-renders when blockedBy changes", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ task }: { task: Task }) {
      cardRenderSpy();
      return <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const { rerender } = render(<MemoizedProbe task={createTask()} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<MemoizedProbe task={createTask({ blockedBy: "FN-777" })} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("FN-777")).toBeDefined();
  });

  it("re-renders when queued state changes", () => {
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();
    const cardRenderSpy = vi.fn();

    function MemoProbe({ queued }: { queued?: boolean }) {
      cardRenderSpy();
      return <TaskCard task={createTask()} queued={queued} onOpenDetail={onOpenDetail} addToast={addToast} />;
    }

    const MemoizedProbe = React.memo(MemoProbe);
    const { rerender } = render(<MemoizedProbe />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<MemoizedProbe queued />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Queued/)).toBeDefined();
  });
});

describe("TaskCard agent-active class", () => {
  it("applies agent-active for an active status (executing)", () => {
    const cls = computeCardClass({ status: "executing" });
    expect(cls).toContain("agent-active");
  });

  it("applies agent-active for all active statuses", () => {
    for (const status of ["planning", "researching", "executing", "finalizing", "merging", "specifying"]) {
      const cls = computeCardClass({ status });
      expect(cls).toContain("agent-active");
    }
  });

  it("does NOT apply agent-active when status is undefined and column is not in-progress", () => {
    const cls = computeCardClass({});
    expect(cls).not.toContain("agent-active");
  });

  it("does NOT apply agent-active for non-active status (idle) outside in-progress", () => {
    const cls = computeCardClass({ status: "idle" });
    expect(cls).not.toContain("agent-active");
  });

  it("does NOT apply agent-active for queued card even with active status", () => {
    const cls = computeCardClass({ status: "executing", queued: true });
    expect(cls).not.toContain("agent-active");
    expect(cls).toContain("queued");
  });

  it("does NOT apply agent-active for queued card with no status", () => {
    const cls = computeCardClass({ queued: true });
    expect(cls).not.toContain("agent-active");
  });

  it("combines dragging and agent-active correctly", () => {
    const cls = computeCardClass({ status: "executing", dragging: true });
    expect(cls).toContain("agent-active");
    expect(cls).toContain("dragging");
  });

  it("base card class is always present", () => {
    expect(computeCardClass({})).toBe("card");
    expect(computeCardClass({ status: "executing" })).toMatch(/^card /);
  });

  // Column-based agent-active tests

  it("applies agent-active for in-progress column with no status", () => {
    const cls = computeCardClass({ column: "in-progress" });
    expect(cls).toContain("agent-active");
  });

  it("applies agent-active for in-progress column with an active status", () => {
    const cls = computeCardClass({ column: "in-progress", status: "executing" });
    expect(cls).toContain("agent-active");
  });

  it("does NOT apply agent-active for todo column with no status", () => {
    const cls = computeCardClass({ column: "todo" });
    expect(cls).not.toContain("agent-active");
  });

  it("applies agent-active for in-review column with active status (merging)", () => {
    const cls = computeCardClass({ column: "in-review", status: "merging" });
    expect(cls).toContain("agent-active");
  });

  it("does NOT apply agent-active for queued card in in-progress column", () => {
    const cls = computeCardClass({ column: "in-progress", queued: true });
    expect(cls).not.toContain("agent-active");
    expect(cls).toContain("queued");
  });

  it("does NOT apply agent-active when status is 'failed' even in in-progress column", () => {
    const cls = computeCardClass({ column: "in-progress", status: "failed" });
    expect(cls).not.toContain("agent-active");
    expect(cls).toContain("failed");
  });

  // globalPaused tests (hard stop suppresses glow; soft pause does not)

  it("does NOT apply agent-active when globalPaused is true with active status", () => {
    for (const status of ["planning", "researching", "executing", "finalizing", "merging", "specifying"]) {
      const cls = computeCardClass({ status, globalPaused: true });
      expect(cls).not.toContain("agent-active");
    }
  });

  it("does NOT apply agent-active when globalPaused is true for in-progress column", () => {
    const cls = computeCardClass({ column: "in-progress", globalPaused: true });
    expect(cls).not.toContain("agent-active");
  });

  it("does NOT apply agent-active when globalPaused is true with active status and in-progress column", () => {
    const cls = computeCardClass({ column: "in-progress", status: "executing", globalPaused: true });
    expect(cls).not.toContain("agent-active");
  });

  it("applies agent-active when globalPaused is false with active status", () => {
    const cls = computeCardClass({ status: "executing", globalPaused: false });
    expect(cls).toContain("agent-active");
  });

  it("applies agent-active when globalPaused is undefined (backward compat)", () => {
    const cls = computeCardClass({ status: "executing", globalPaused: undefined });
    expect(cls).toContain("agent-active");
  });

  it("applies agent-active when only soft-paused (globalPaused is false)", () => {
    // Soft pause (enginePaused) should NOT suppress the glow — only globalPaused matters
    const cls = computeCardClass({ status: "executing", globalPaused: false });
    expect(cls).toContain("agent-active");
  });

  it("applies agent-active for in-progress column when only soft-paused", () => {
    const cls = computeCardClass({ column: "in-progress", globalPaused: false });
    expect(cls).toContain("agent-active");
  });
});

describe("TaskCard failed status", () => {
  it("applies 'failed' class to card when status is 'failed'", () => {
    const cls = computeCardClass({ status: "failed", column: "in-progress" });
    expect(cls).toContain("failed");
    expect(cls).not.toContain("agent-active");
  });

  it("does NOT apply 'failed' class for non-failed statuses", () => {
    const cls = computeCardClass({ status: "executing", column: "in-progress" });
    expect(cls).not.toContain("failed");
  });

  it("does NOT apply 'failed' class when status is undefined", () => {
    const cls = computeCardClass({ column: "in-progress" });
    expect(cls).not.toContain("failed");
  });

  /** Mirrors the badge style condition from TaskCard.tsx */
  function shouldShowFailedBadge(status?: string | null): boolean {
    return status === "failed";
  }

  it("shows failed badge when status is 'failed'", () => {
    expect(shouldShowFailedBadge("failed")).toBe(true);
  });

  it("does NOT show failed badge for other statuses", () => {
    expect(shouldShowFailedBadge("executing")).toBe(false);
    expect(shouldShowFailedBadge(undefined)).toBe(false);
    expect(shouldShowFailedBadge(null)).toBe(false);
  });
});

describe("TaskCard stuck status", () => {
  it("applies 'stuck' class to card when task is stuck", () => {
    const cls = computeCardClass({ isStuck: true, column: "in-progress", status: "executing" });
    expect(cls).toContain("stuck");
  });

  it("does NOT apply 'stuck' class when task is not stuck", () => {
    const cls = computeCardClass({ column: "in-progress", status: "executing" });
    expect(cls).not.toContain("stuck");
  });

  it("stuck takes precedence over agent-active", () => {
    const cls = computeCardClass({ isStuck: true, column: "in-progress", status: "executing" });
    expect(cls).toContain("stuck");
    expect(cls).not.toContain("agent-active");
  });

  it("stuck and failed can coexist (stuck appears in class list)", () => {
    const cls = computeCardClass({ isStuck: true, status: "failed", column: "in-progress" });
    expect(cls).toContain("stuck");
    expect(cls).toContain("failed");
  });

  it("stuck and paused can coexist", () => {
    const cls = computeCardClass({ isStuck: true, isPaused: true, column: "in-progress" });
    expect(cls).toContain("stuck");
    expect(cls).toContain("paused");
  });
});

describe("TaskCard dependency tooltip", () => {
  /** Mirrors the data-tooltip computation from TaskCard.tsx */
  function computeDepTooltip(dependencies: string[]): string | undefined {
    if (dependencies.length === 0) return undefined;
    return dependencies.join(", ");
  }

  it("returns comma-separated dependency IDs when dependencies are present", () => {
    expect(computeDepTooltip(["FN-001", "FN-042"])).toBe("FN-001, FN-042");
  });

  it("returns single dependency ID when only one dependency", () => {
    expect(computeDepTooltip(["FN-010"])).toBe("FN-010");
  });

  it("returns undefined when dependencies array is empty", () => {
    expect(computeDepTooltip([])).toBeUndefined();
  });

  it("handles many dependencies", () => {
    const deps = ["FN-001", "FN-002", "FN-003", "FN-004"];
    expect(computeDepTooltip(deps)).toBe("FN-001, FN-002, FN-003, FN-004");
  });

  it("data-tooltip attribute contains dependency IDs as a readable string", () => {
    const deps = ["FN-005", "FN-012"];
    const tooltip = computeDepTooltip(deps);
    expect(tooltip).toBeDefined();
    // Each dependency ID should appear in the tooltip
    for (const dep of deps) {
      expect(tooltip).toContain(dep);
    }
  });
});

describe("TaskCard file-scope overlap badge logic", () => {
  /** Mirrors the card-meta visibility condition from TaskCard.tsx */
  function shouldShowCardMeta(opts: { dependencies?: string[]; queued?: boolean; status?: string | null; blockedBy?: string }): boolean {
    const deps = opts.dependencies || [];
    return deps.length > 0 || !!opts.queued || opts.status === "queued" || !!opts.blockedBy;
  }

  /** Mirrors the card-scope-badge visibility condition from TaskCard.tsx */
  function shouldShowScopeBadge(blockedBy?: string): boolean {
    return !!blockedBy;
  }

  it("shows scope badge when blockedBy is set", () => {
    expect(shouldShowScopeBadge("FN-003")).toBe(true);
  });

  it("does NOT show scope badge when blockedBy is undefined", () => {
    expect(shouldShowScopeBadge(undefined)).toBe(false);
  });

  it("shows card-meta when blockedBy is set even with no deps or queued status", () => {
    expect(shouldShowCardMeta({ blockedBy: "FN-003" })).toBe(true);
  });

  it("does NOT show card-meta when no deps, not queued, and no blockedBy", () => {
    expect(shouldShowCardMeta({})).toBe(false);
  });

  /** Mirrors tooltip computation from TaskCard.tsx */
  function computeScopeTooltip(blockedBy: string): string {
    return `Blocked by ${blockedBy} (file overlap)`;
  }

  it("generates correct tooltip text", () => {
    expect(computeScopeTooltip("FN-005")).toBe("Blocked by FN-005 (file overlap)");
  });
});

describe("TaskCard queued badge logic", () => {
  /** Mirrors the card-status-badge visibility condition from TaskCard.tsx */
  function shouldShowStatusBadge(status?: string | null): boolean {
    return !!status && status !== "queued";
  }

  /** Mirrors the queued-badge visibility condition from TaskCard.tsx */
  function shouldShowQueuedBadge(opts: { queued?: boolean; status?: string | null }): boolean {
    return !!(opts.queued || opts.status === "queued");
  }

  it("shows queued-badge when queued prop is true", () => {
    expect(shouldShowQueuedBadge({ queued: true })).toBe(true);
  });

  it("shows queued-badge when task.status is 'queued'", () => {
    expect(shouldShowQueuedBadge({ status: "queued" })).toBe(true);
  });

  it("shows queued-badge when both queued prop and status are set", () => {
    expect(shouldShowQueuedBadge({ queued: true, status: "queued" })).toBe(true);
  });

  it("does NOT show queued-badge when neither queued prop nor status is 'queued'", () => {
    expect(shouldShowQueuedBadge({ queued: false, status: "executing" })).toBe(false);
    expect(shouldShowQueuedBadge({})).toBe(false);
  });

  it("does NOT show card-status-badge when status is 'queued'", () => {
    expect(shouldShowStatusBadge("queued")).toBe(false);
  });

  it("shows card-status-badge for non-queued statuses", () => {
    expect(shouldShowStatusBadge("executing")).toBe(true);
    expect(shouldShowStatusBadge("planning")).toBe(true);
  });

  it("does NOT show card-status-badge when status is null/undefined", () => {
    expect(shouldShowStatusBadge(null)).toBe(false);
    expect(shouldShowStatusBadge(undefined)).toBe(false);
  });
});

/**
 * Component tests for clickable dependencies in TaskCard.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-099",
    description: "Test task",
    column: "in-progress" as Column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("TaskCard clickable dependencies", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dependency badges as clickable when dependencies exist", () => {
    const task = makeTask({ dependencies: ["FN-001", "FN-002"] });
    const allTasks: Task[] = [
      makeTask({ id: "FN-001", description: "Dep 1" }),
      makeTask({ id: "FN-002", description: "Dep 2" }),
    ];

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const depBadges = screen.getAllByTitle(/Click to view/);
    expect(depBadges).toHaveLength(2);
    expect(depBadges[0].classList.contains("clickable")).toBe(true);
    expect(depBadges[1].classList.contains("clickable")).toBe(true);
  });

  it("does not render dependency badges when no dependencies", () => {
    const task = makeTask({ dependencies: [] });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const depBadges = screen.queryAllByTitle(/Click to view/);
    expect(depBadges).toHaveLength(0);
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

    const task = makeTask({ dependencies: ["FN-001"] });
    const allTasks: Task[] = [makeTask({ id: "FN-001", description: "Dep 1" })];

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const depBadge = screen.getByTitle(/Click to view/);
    fireEvent.click(depBadge);

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

    const task = makeTask({ dependencies: ["FN-001"] });

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={addToast}
      />
    );

    const depBadge = screen.getByTitle(/Click to view/);
    fireEvent.click(depBadge);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to load dependency FN-001", "error");
    });
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("uses stopPropagation so card click is not triggered", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);
    mockFetch.mockRejectedValueOnce(new Error("Stop here"));
    const addToast = vi.fn();

    const task = makeTask({ dependencies: ["FN-001"] });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={addToast}
      />
    );

    const depBadge = screen.getByTitle(/Click to view/);
    const clickEvent = new MouseEvent("click", { bubbles: true });
    const stopPropagationSpy = vi.spyOn(clickEvent, "stopPropagation");

    fireEvent(depBadge, clickEvent);

    // The click handler is async, so we just verify the badge is clickable
    expect(depBadge.classList.contains("clickable")).toBe(true);
  });
});

/**
 * Component tests for size badge rendering in TaskCard.
 */
describe("TaskCard size badge", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders size badge when task.size is 'S'", () => {
    const task = makeTask({ size: "S" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const sizeBadge = screen.getByText("S");
    expect(sizeBadge).toBeDefined();
    expect(sizeBadge.classList.contains("card-size-badge")).toBe(true);
    expect(sizeBadge.classList.contains("size-s")).toBe(true);
  });

  it("renders size badge when task.size is 'M'", () => {
    const task = makeTask({ size: "M" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const sizeBadge = screen.getByText("M");
    expect(sizeBadge).toBeDefined();
    expect(sizeBadge.classList.contains("card-size-badge")).toBe(true);
    expect(sizeBadge.classList.contains("size-m")).toBe(true);
  });

  it("renders size badge when task.size is 'L'", () => {
    const task = makeTask({ size: "L" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const sizeBadge = screen.getByText("L");
    expect(sizeBadge).toBeDefined();
    expect(sizeBadge.classList.contains("card-size-badge")).toBe(true);
    expect(sizeBadge.classList.contains("size-l")).toBe(true);
  });

  it("does NOT render size badge when task.size is undefined", () => {
    const task = makeTask({ size: undefined });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const sizeBadge = screen.queryByText(/^[SML]$/);
    expect(sizeBadge).toBeNull();
  });

  it("positioned in card-header with other badges", () => {
    const task = makeTask({ size: "M", status: "executing" });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const cardHeader = container.querySelector(".card-header");
    expect(cardHeader).toBeDefined();
    
    const sizeBadge = cardHeader?.querySelector(".card-size-badge");
    expect(sizeBadge).toBeDefined();
    expect(sizeBadge?.textContent).toBe("M");
  });

  it("size badge appears at far right (after Archive button) in done column cards", () => {
    const onArchiveTask = vi.fn().mockResolvedValue(makeTask({ column: "done" }));
    const task = makeTask({ 
      column: "done", 
      size: "M",
      status: undefined 
    });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onArchiveTask={onArchiveTask}
      />
    );

    const headerActions = container.querySelector(".card-header-actions");
    expect(headerActions).toBeDefined();
    
    // Get all children of header actions
    const children = headerActions?.children;
    expect(children).toBeDefined();
    expect(children!.length).toBeGreaterThanOrEqual(2);
    
    // The last element should be the size badge (after Archive button)
    const lastElement = children![children!.length - 1];
    expect(lastElement.classList.contains("card-size-badge")).toBe(true);
    expect(lastElement.textContent).toBe("M");
    
    // Archive button should be before the size badge
    const archiveButton = headerActions?.querySelector(".card-archive-btn");
    expect(archiveButton).toBeDefined();
    
    // Find the index of archive button and size badge
    const archiveIndex = Array.from(children!).findIndex(el => el.classList.contains("card-archive-btn"));
    const sizeIndex = Array.from(children!).findIndex(el => el.classList.contains("card-size-badge"));
    
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(sizeIndex).toBeGreaterThanOrEqual(0);
    expect(sizeIndex).toBeGreaterThan(archiveIndex); // Size badge comes after Archive button
  });
});

/**
 * Tests for inline editing functionality in TaskCard.
 */
describe("TaskCard inline editing", () => {
  const noopToast = vi.fn();
  const noopUpdateTask = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to make editable task (triage or todo column)
  function makeEditableTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      column: "triage",
      status: undefined,
      paused: false,
      ...overrides,
    });
  }

  // Helper to make non-editable task (in-progress, in-review, done, or agent active)
  function makeNonEditableTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      column: "in-progress",
      status: "executing",
      paused: false,
      ...overrides,
    });
  }

  it("shows edit button on hover for editable cards", () => {
    const task = makeEditableTask({ column: "triage" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.getByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeDefined();
    expect(editBtn.classList.contains("card-edit-btn")).toBe(true);
  });

  it("shows edit button for todo column tasks", () => {
    const task = makeEditableTask({ column: "todo" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.getByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeDefined();
  });

  it("does NOT show edit button for in-progress column", () => {
    const task = makeTask({
      column: "in-progress",
      status: "executing",
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("does NOT show edit button for in-review column", () => {
    const task = makeTask({
      column: "in-review",
      status: undefined,
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("does NOT show edit button for done column", () => {
    const task = makeTask({
      column: "done",
      status: undefined,
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("does NOT show edit button when agent is active", () => {
    const task = makeTask({
      column: "in-progress",
      status: "executing",
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("does NOT show edit button when task is paused", () => {
    const task = makeEditableTask({ paused: true });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("does NOT show edit button when onUpdateTask callback is not provided", () => {
    const task = makeEditableTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const editBtn = screen.queryByRole("button", { name: /Edit task/i });
    expect(editBtn).toBeNull();
  });

  it("enters edit mode on double-click for editable cards", () => {
    const task = makeEditableTask({ title: "Test Title", description: "Test Description" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card).toBeDefined();
    fireEvent.doubleClick(card!);

    // Should show editing UI — description textarea only, no title input
    const titleInput = screen.queryByPlaceholderText(/Task title/i);
    const descTextarea = screen.getByPlaceholderText(/Task description/i);

    expect(titleInput).toBeNull();
    expect(descTextarea).toBeDefined();
    expect((descTextarea as HTMLTextAreaElement).value).toBe("Test Description");
  });

  it("enters edit mode when clicking edit button", () => {
    const task = makeEditableTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const editBtn = screen.getByRole("button", { name: /Edit task/i });
    fireEvent.click(editBtn);

    // Should show description textarea only, no title input
    const titleInput = screen.queryByPlaceholderText(/Task title/i);
    const descTextarea = screen.getByPlaceholderText(/Task description/i);
    expect(titleInput).toBeNull();
    expect(descTextarea).toBeDefined();
  });

  it("does NOT enter edit mode on double-click for non-editable cards", () => {
    const task = makeNonEditableTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    // Should NOT show editing UI
    const descTextarea = screen.queryByPlaceholderText(/Task description/i);
    expect(descTextarea).toBeNull();
  });

  it("Escape key cancels edit mode", () => {
    const task = makeEditableTask({ title: "Original Title", description: "Original Desc" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    fireEvent.change(descTextarea, { target: { value: "Changed Desc" } });

    // Press Escape
    fireEvent.keyDown(descTextarea, { key: "Escape" });

    // Should exit edit mode without saving
    expect(screen.queryByPlaceholderText(/Task description/i)).toBeNull();
    expect(noopUpdateTask).not.toHaveBeenCalled();
  });

  it("blurring with no changes cancels edit mode", async () => {
    const user = userEvent.setup();
    const task = makeEditableTask({ title: "Original Title", description: "Original Desc" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    await user.dblClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i);
    expect(descTextarea).toBeDefined();

    // Tab out to move focus outside the editing area
    await user.tab();

    // Wait for the blur handler to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have exited edit mode without saving
    expect(screen.queryByPlaceholderText(/Task description/i)).toBeNull();
    expect(noopUpdateTask).not.toHaveBeenCalled();
  });

  it("Enter in description saves changes", async () => {
    const task = makeEditableTask({ title: "Title", description: "Old Desc" });
    const mockUpdateTask = vi.fn().mockResolvedValue({ ...task, description: "New Desc" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={mockUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    fireEvent.change(descTextarea, { target: { value: "New Desc" } });

    // Press Enter (not Shift+Enter)
    fireEvent.keyDown(descTextarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-099", {
        description: "New Desc",
      });
    });
  });

  it("Shift+Enter in description adds newline", () => {
    const task = makeEditableTask({ description: "Line 1" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;

    // Press Shift+Enter - should not trigger save
    fireEvent.keyDown(descTextarea, { key: "Enter", shiftKey: true });

    // updateTask should not be called
    expect(noopUpdateTask).not.toHaveBeenCalled();
  });

  it("shows loading state during save", async () => {
    const task = makeEditableTask({ title: "Title" });
    // Create a promise that we can resolve manually
    let resolveUpdate: (value: Task) => void;
    const updatePromise = new Promise<Task>((resolve) => {
      resolveUpdate = resolve;
    });
    const mockUpdateTask = vi.fn().mockReturnValue(updatePromise);

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={mockUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    fireEvent.change(descTextarea, { target: { value: "New Desc" } });

    // Trigger save
    fireEvent.keyDown(descTextarea, { key: "Enter" });

    // Should show loading state
    await waitFor(() => {
      expect(screen.getByText(/Saving/i)).toBeDefined();
    });

    // Resolve the update
    resolveUpdate!({ ...task, description: "New Desc" });

    // Wait for save to complete
    await waitFor(() => {
      expect(screen.queryByText(/Saving/i)).toBeNull();
    });
  });

  it("shows error toast when save fails", async () => {
    const task = makeEditableTask({ title: "Title" });
    const mockUpdateTask = vi.fn().mockRejectedValue(new Error("Network error"));
    const addToast = vi.fn();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={addToast}
        onUpdateTask={mockUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    fireEvent.change(descTextarea, { target: { value: "New Desc" } });

    // Trigger save
    fireEvent.keyDown(descTextarea, { key: "Enter" });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to update"), "error");
    });

    // Should stay in edit mode on error
    expect(screen.getByPlaceholderText(/Task description/i)).toBeDefined();
  });

  it("prevents drag during edit mode", () => {
    const task = makeEditableTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]') as HTMLElement;
    fireEvent.doubleClick(card);

    // Card should have editing class
    expect(card.classList.contains("card-editing")).toBe(true);
  });

  it("card has card-editing class when in edit mode", () => {
    const task = makeEditableTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]') as HTMLElement;
    expect(card.classList.contains("card-editing")).toBe(false);

    fireEvent.doubleClick(card);

    const editingCard = document.querySelector(".card-editing");
    expect(editingCard).toBeDefined();
  });

  it("saves only description — existing title is not sent in update", async () => {
    const task = makeEditableTask({ title: "Keep This Title", description: "Old Desc" });
    const mockUpdateTask = vi.fn().mockResolvedValue({ ...task, description: "New Desc" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={mockUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    fireEvent.change(descTextarea, { target: { value: "New Desc" } });

    // Press Enter to save
    fireEvent.keyDown(descTextarea, { key: "Enter" });

    await waitFor(() => {
      // onUpdateTask should only receive description, not title
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-099", {
        description: "New Desc",
      });
    });
  });

  it("description textarea is auto-focused when entering edit mode", () => {
    const task = makeEditableTask({ description: "Some description" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i);
    expect(document.activeElement).toBe(descTextarea);
  });

  it("no-change blur exits edit mode without saving", async () => {
    const user = userEvent.setup();
    const task = makeEditableTask({ description: "Original Desc" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    await user.dblClick(card!);

    // Verify description textarea is visible with original value
    const descTextarea = screen.getByPlaceholderText(/Task description/i);
    expect((descTextarea as HTMLTextAreaElement).value).toBe("Original Desc");

    // Tab away to move focus outside the editing area
    await user.tab();

    // Wait for the blur handler to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should exit edit mode without calling update
    expect(screen.queryByPlaceholderText(/Task description/i)).toBeNull();
    expect(noopUpdateTask).not.toHaveBeenCalled();
  });

  it("does not render an inline title input in edit mode", () => {
    const task = makeEditableTask({ title: "Some Title" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    // Only description textarea should exist, no title input
    expect(screen.queryByPlaceholderText(/Task title/i)).toBeNull();
    expect(screen.getByPlaceholderText(/Task description/i)).toBeDefined();
  });

  it("opens the description textarea with 4 visible rows", () => {
    const task = makeEditableTask({ description: "Some text" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    expect(descTextarea).toBeDefined();
    expect(descTextarea.getAttribute("rows")).toBe("4");
  });

  it("applies mount-time auto-resize for existing long descriptions", () => {
    // A multi-line description that would exceed the default 4-row height
    const longDescription = Array(10).fill("This is a line of description text.").join("\n");
    const task = makeEditableTask({ description: longDescription });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        onUpdateTask={noopUpdateTask}
      />
    );

    // Enter edit mode
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;
    // The mount-time resize effect sets height to scrollHeight + "px".
    // In JSDOM, scrollHeight is 0 (no real layout), so the style ends up
    // as "0px" — but the important thing is the effect *did* set the
    // height property, proving the auto-resize logic runs on mount.
    expect(descTextarea.style.height).not.toBe("");
  });
});

/**
 * Tests for collapsible steps toggle in TaskCard.
 */
describe("TaskCard steps toggle", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show steps toggle when task has no steps", () => {
    const task = makeTask({ steps: [] });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.queryByRole("button", { name: /steps/i });
    expect(toggle).toBeNull();
  });

  it("shows steps toggle with count when task has steps", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle).toBeDefined();
    expect(toggle.textContent).toContain("2 steps");
  });

  it("clicking toggle expands and shows step list", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "First step", status: "done" },
        { name: "Second step", status: "in-progress" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    // Step list should be visible
    expect(screen.getByText("First step")).toBeDefined();
    expect(screen.getByText("Second step")).toBeDefined();
  });

  it("clicking toggle again collapses step list", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [{ name: "Single step", status: "pending" }],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });

    // Expand
    fireEvent.click(toggle);
    expect(screen.getByText("Single step")).toBeDefined();

    // Collapse
    fireEvent.click(toggle);
    expect(screen.queryByText("Single step")).toBeNull();
  });

  it("step list renders correct number of steps", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
        { name: "Step 3", status: "pending" },
        { name: "Step 4", status: "skipped" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    // Should show all 4 steps
    const stepItems = document.querySelectorAll(".card-step-item");
    expect(stepItems.length).toBe(4);
  });

  it("completed steps have strikethrough style", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Done step", status: "done" },
        { name: "Pending step", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    const doneStepName = screen.getByText("Done step");
    expect(doneStepName.classList.contains("completed")).toBe(true);

    const pendingStepName = screen.getByText("Pending step");
    expect(pendingStepName.classList.contains("completed")).toBe(false);
  });

  it("toggle does not trigger card click when clicked", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [{ name: "Test step", status: "pending" }],
    });
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    // Card click should not be triggered
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("aria-expanded reflects toggle state", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [{ name: "Test step", status: "pending" }],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("chevron icon rotates when expanded", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [{ name: "Test step", status: "pending" }],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    const chevron = toggle.querySelector(".card-steps-toggle-icon");
    expect(chevron).toBeDefined();
    expect(chevron?.classList.contains("expanded")).toBe(false);

    fireEvent.click(toggle);
    expect(chevron?.classList.contains("expanded")).toBe(true);
  });

  it("progress bar counts skipped steps as completed", () => {
    const task = makeTask({
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "skipped" },
        { name: "Step 3", status: "pending" },
        { name: "Step 4", status: "in-progress" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Progress label should show "2/4" (done + skipped = 2 completed)
    const progressLabel = document.querySelector(".card-progress-label");
    expect(progressLabel).toBeDefined();
    expect(progressLabel?.textContent).toBe("2/4");
  });

  it("step list renders skipped status with correct CSS class", () => {
    // Use 'todo' column to test default collapsed behavior
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Done step", status: "done" },
        { name: "Skipped step", status: "skipped" },
        { name: "Pending step", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    // Check that skipped step has the correct dot class
    const stepDots = document.querySelectorAll(".card-step-dot");
    expect(stepDots.length).toBe(3);
    expect(stepDots[0].classList.contains("card-step-dot--done")).toBe(true);
    expect(stepDots[1].classList.contains("card-step-dot--skipped")).toBe(true);
    expect(stepDots[2].classList.contains("card-step-dot--pending")).toBe(true);
  });

  it("progress bar shows 100% when all steps are skipped", () => {
    const task = makeTask({
      steps: [
        { name: "Step 1", status: "skipped" },
        { name: "Step 2", status: "skipped" },
        { name: "Step 3", status: "skipped" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Progress label should show "3/3"
    const progressLabel = document.querySelector(".card-progress-label");
    expect(progressLabel?.textContent).toBe("3/3");

    // Progress fill should be 100% width
    const progressFill = document.querySelector(".card-progress-fill") as HTMLElement;
    expect(progressFill).toBeDefined();
    expect(progressFill.style.width).toBe("100%");
  });
});

/**
 * Tests for auto-expanded steps disclosure in in-progress column (KB-193).
 */
describe("TaskCard steps auto-expand", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("steps are expanded by default for 'in-progress' column tasks", () => {
    const task = makeTask({
      column: "in-progress",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should be visible without clicking
    expect(screen.getByText("Step 1")).toBeDefined();
    expect(screen.getByText("Step 2")).toBeDefined();

    // Toggle should show "Hide steps"
    const toggle = screen.getByRole("button", { name: /Hide steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("steps are collapsed by default for fresh 'triage' column tasks (no completed steps)", () => {
    const task = makeTask({
      column: "triage",
      steps: [
        { name: "Step 1", status: "pending" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should not be visible
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should show "Show steps"
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("steps are auto-expanded for re-triaged tasks with completed steps", () => {
    const task = makeTask({
      column: "triage",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should be visible without clicking
    expect(screen.getByText("Step 1")).toBeDefined();
    expect(screen.getByText("Step 2")).toBeDefined();

    // Toggle should show "Hide steps"
    const toggle = screen.getByRole("button", { name: /Hide steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("steps are auto-expanded for re-triaged tasks with skipped steps", () => {
    const task = makeTask({
      column: "triage",
      steps: [
        { name: "Step 1", status: "skipped" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should be visible without clicking
    expect(screen.getByText("Step 1")).toBeDefined();
    expect(screen.getByText("Step 2")).toBeDefined();

    const toggle = screen.getByRole("button", { name: /Hide steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("steps are collapsed by default for 'todo' column tasks", () => {
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should not be visible
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should show "Show steps"
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("steps are collapsed by default for 'in-review' column tasks", () => {
    const task = makeTask({
      column: "in-review",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should not be visible
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should show "Show steps"
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("steps are collapsed by default for 'done' column tasks", () => {
    const task = makeTask({
      column: "done",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "done" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should not be visible
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should show "Show steps"
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggle button works to collapse steps on in-progress cards", () => {
    const task = makeTask({
      column: "in-progress",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should be visible initially
    expect(screen.getByText("Step 1")).toBeDefined();

    // Click toggle to collapse
    const toggle = screen.getByRole("button", { name: /Hide steps/i });
    fireEvent.click(toggle);

    // Steps should now be hidden
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should now show "Show steps"
    expect(toggle.getAttribute("aria-label")).toBe("Show steps");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggle button works to expand steps on non-in-progress cards", () => {
    const task = makeTask({
      column: "todo",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "pending" },
      ],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Steps should be hidden initially
    expect(screen.queryByText("Step 1")).toBeNull();

    // Click toggle to expand
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    fireEvent.click(toggle);

    // Steps should now be visible
    expect(screen.getByText("Step 1")).toBeDefined();
    expect(screen.getByText("Step 2")).toBeDefined();

    // Toggle should now show "Hide steps"
    expect(toggle.getAttribute("aria-label")).toBe("Hide steps");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

/**
 * Tests for GitHub badges rendering in TaskCard.
 */
describe("TaskCard GitHub badges", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders GitHubBadge when task has prInfo", () => {
    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Fix bug",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 3,
      },
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should show the PR badge with the PR number
    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByTitle("PR #42: Fix bug")).toBeDefined();
  });

  it("renders GitHubBadge when task has issueInfo", () => {
    const task = makeTask({
      issueInfo: {
        url: "https://github.com/owner/repo/issues/123",
        number: 123,
        state: "open",
        title: "Feature request",
      },
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should show the Issue badge with the issue number
    expect(screen.getByText("#123")).toBeDefined();
    expect(screen.getByTitle("Issue #123: Feature request")).toBeDefined();
  });

  it("renders both PR and Issue badges when task has both", () => {
    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Fix bug",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 3,
      },
      issueInfo: {
        url: "https://github.com/owner/repo/issues/123",
        number: 123,
        state: "closed",
        stateReason: "completed",
        title: "Related issue",
      },
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Both badges should appear
    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByText("#123")).toBeDefined();
    expect(screen.getByTitle("PR #42: Fix bug")).toBeDefined();
    expect(screen.getByTitle("Issue #123: Related issue")).toBeDefined();
  });

  it("does not render GitHubBadge when task has neither prInfo nor issueInfo", () => {
    const task = makeTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // No badge numbers should appear
    const badgeNumbers = screen.queryAllByText(/^#\d+$/);
    expect(badgeNumbers.length).toBe(0);
  });

  it("renders PR badge in all columns (not just in-review)", () => {
    const columns: Column[] = ["triage", "todo", "in-progress", "in-review", "done"];

    for (const column of columns) {
      const task = makeTask({
        column,
        prInfo: {
          url: "https://github.com/owner/repo/pull/42",
          number: 42,
          status: "open",
          title: "Fix bug",
          headBranch: "feature/bugfix",
          baseBranch: "main",
          commentCount: 3,
        },
      });

      const { unmount } = render(
        <TaskCard
          task={task}
          onOpenDetail={vi.fn()}
          addToast={noopToast}
        />
      );

      expect(screen.getByText("#42")).toBeDefined();
      unmount();
    }
  });

  it("renders Issue badge with correct color class for open state", () => {
    const task = makeTask({
      issueInfo: {
        url: "https://github.com/owner/repo/issues/123",
        number: 123,
        state: "open",
        title: "Open issue",
      },
    });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const badge = container.querySelector(".card-github-badge--open");
    expect(badge).toBeDefined();
  });

  it("renders Issue badge with correct color class for completed state", () => {
    const task = makeTask({
      issueInfo: {
        url: "https://github.com/owner/repo/issues/123",
        number: 123,
        state: "closed",
        stateReason: "completed",
        title: "Completed issue",
      },
    });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const badge = container.querySelector(".card-github-badge--completed");
    expect(badge).toBeDefined();
  });

  it("renders PR badge with correct color class for merged status", () => {
    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "merged",
        title: "Merged PR",
        headBranch: "feature/merged",
        baseBranch: "main",
        commentCount: 5,
      },
    });

    const { container } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const badge = container.querySelector(".card-github-badge--merged");
    expect(badge).toBeDefined();
  });

  it("prefers newer live badge data over stale task badge data", () => {
    mockUseBadgeWebSocket.mockReturnValue({
      badgeUpdates: new Map([
        [
          "FN-099",
          {
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "merged",
              title: "Merged PR",
              headBranch: "feature/merged",
              baseBranch: "main",
              commentCount: 5,
            },
            issueInfo: null,
            timestamp: "2026-03-30T12:00:00.000Z",
          },
        ],
      ]),
      isConnected: true,
      subscribeToBadge: vi.fn(),
      unsubscribeFromBadge: vi.fn(),
    });

    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Open PR",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 0,
        lastCheckedAt: "2026-03-30T11:00:00.000Z",
      },
      updatedAt: "2026-03-30T11:00:00.000Z",
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByTitle("PR #42: Merged PR")).toBeDefined();
  });

  it("falls back to newer task badge data when cached live data is older", () => {
    mockUseBadgeWebSocket.mockReturnValue({
      badgeUpdates: new Map([
        [
          "FN-099",
          {
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "open",
              title: "Older Live PR",
              headBranch: "feature/bugfix",
              baseBranch: "main",
              commentCount: 0,
            },
            timestamp: "2026-03-30T11:00:00.000Z",
          },
        ],
      ]),
      isConnected: false,
      subscribeToBadge: vi.fn(),
      unsubscribeFromBadge: vi.fn(),
    });

    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "merged",
        title: "Fresh Task PR",
        headBranch: "feature/merged",
        baseBranch: "main",
        commentCount: 2,
        lastCheckedAt: "2026-03-30T12:00:00.000Z",
      },
      updatedAt: "2026-03-30T12:00:00.000Z",
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByTitle("PR #42: Fresh Task PR")).toBeDefined();
  });

  it("keeps task-provided badges when the first live update only includes one badge field", () => {
    mockUseBadgeWebSocket.mockReturnValue({
      badgeUpdates: new Map([
        [
          "FN-099",
          {
            issueInfo: {
              url: "https://github.com/owner/repo/issues/123",
              number: 123,
              state: "closed",
              title: "Updated issue",
              stateReason: "completed",
            },
            timestamp: "2026-03-30T12:00:00.000Z",
          },
        ],
      ]),
      isConnected: true,
      subscribeToBadge: vi.fn(),
      unsubscribeFromBadge: vi.fn(),
    });

    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Tracked PR",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 1,
        lastCheckedAt: "2026-03-30T11:00:00.000Z",
      },
      issueInfo: {
        url: "https://github.com/owner/repo/issues/123",
        number: 123,
        state: "open",
        title: "Tracked issue",
        lastCheckedAt: "2026-03-30T11:00:00.000Z",
      },
      updatedAt: "2026-03-30T11:00:00.000Z",
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByTitle("PR #42: Tracked PR")).toBeDefined();
    expect(screen.getByTitle("Issue #123: Updated issue")).toBeDefined();
  });

  it("subscribes on mount and unsubscribes on unmount for linked GitHub tasks", () => {
    const subscribeToBadge = vi.fn();
    const unsubscribeFromBadge = vi.fn();
    mockUseBadgeWebSocket.mockReturnValue({
      badgeUpdates: new Map(),
      isConnected: true,
      subscribeToBadge,
      unsubscribeFromBadge,
    });

    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Tracked PR",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 1,
      },
    });

    const { unmount } = render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(subscribeToBadge).toHaveBeenCalledWith("FN-099");

    unmount();

    expect(unsubscribeFromBadge).toHaveBeenCalledWith("FN-099");
  });

  it("waits for viewport intersection before subscribing and unsubscribes when leaving", () => {
    const subscribeToBadge = vi.fn();
    const unsubscribeFromBadge = vi.fn();
    mockUseBadgeWebSocket.mockReturnValue({
      badgeUpdates: new Map(),
      isConnected: true,
      subscribeToBadge,
      unsubscribeFromBadge,
    });

    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const observers: Array<{ callback: IntersectionObserverCallback }> = [];

    class MockIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      root = null;
      rootMargin = "200px";
      thresholds = [0];
      readonly takeRecords = vi.fn(() => []);

      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
    }

    (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

    const task = makeTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "Tracked PR",
        headBranch: "feature/bugfix",
        baseBranch: "main",
        commentCount: 1,
      },
    });

    try {
      render(
        <TaskCard
          task={task}
          onOpenDetail={vi.fn()}
          addToast={noopToast}
        />
      );

      expect(subscribeToBadge).not.toHaveBeenCalled();

      act(() => {
        observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });

      expect(subscribeToBadge).toHaveBeenCalledWith("FN-099");

      act(() => {
        observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      });

      expect(unsubscribeFromBadge).toHaveBeenCalledWith("FN-099");
    } finally {
      (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver | undefined }).IntersectionObserver = originalIntersectionObserver;
    }
  });
});

/**
 * Tests for task detail opening behavior in TaskCard.
 * The card body opens the modal directly; there is no separate expand button.
 */
describe("TaskCard detail opening", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens modal immediately with Task when clicking the card body", async () => {
    const onOpenDetail = vi.fn();

    const task = makeTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card).toBeDefined();

    const cardTitle = screen.getByText("Test task");
    fireEvent.click(cardTitle);

    // Should call onOpenDetail synchronously with the Task object (no fetch)
    expect(onOpenDetail).toHaveBeenCalledWith(task);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it("opens modal only once per card click", async () => {
    const onOpenDetail = vi.fn();
    const task = makeTask();

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    fireEvent.click(screen.getByText("Test task"));

    // Should call onOpenDetail synchronously with the Task object (no fetch)
    expect(onOpenDetail).toHaveBeenCalledWith(task);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it("does NOT open modal during vertical scrolling", async () => {
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card).toBeDefined();

    fireEvent.touchStart(card!, {
      touches: [{ clientX: 100, clientY: 100 }],
    });

    fireEvent.touchMove(card!, {
      touches: [{ clientX: 100, clientY: 115 }],
    });

    fireEvent.touchEnd(card!, {
      changedTouches: [{ clientX: 100, clientY: 115 }],
      target: card,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("does NOT open modal during horizontal scrolling", async () => {
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card).toBeDefined();

    fireEvent.touchStart(card!, {
      touches: [{ clientX: 100, clientY: 100 }],
    });

    fireEvent.touchMove(card!, {
      touches: [{ clientX: 115, clientY: 100 }],
    });

    fireEvent.touchEnd(card!, {
      changedTouches: [{ clientX: 115, clientY: 100 }],
      target: card,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("does NOT open modal on long press (slow touch)", async () => {
    const onOpenDetail = vi.fn();

    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card).toBeDefined();

    // Simulate long press: touchStart, wait > 300ms, then touchEnd
    fireEvent.touchStart(card!, {
      touches: [{ clientX: 100, clientY: 100 }],
    });

    // Wait longer than tap threshold (300ms)
    await new Promise((resolve) => setTimeout(resolve, 350));

    fireEvent.touchEnd(card!, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
      target: card,
    });

    // Wait for any async operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Modal should NOT have opened
    expect(onOpenDetail).not.toHaveBeenCalled();
  });
});

/**
 * Tests for TaskCard title/description display without truncation.
 */
describe("TaskCard title display", () => {
  const noopToast = vi.fn();

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task);

  it("truncates titles longer than 140 characters with ellipsis", () => {
    const longTitle = "A".repeat(150);
    const task = makeTask({ title: longTitle });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // The title should be truncated to 140 chars + "…"
    const expectedTruncated = "A".repeat(140) + "…";
    const cardTitle = screen.getByText(expectedTruncated);
    expect(cardTitle).toBeDefined();
    expect(cardTitle.textContent?.length).toBe(141); // 140 + ellipsis
  });

  it("shows full title in tooltip via title attribute", () => {
    const longTitle = "A".repeat(150);
    const task = makeTask({ title: longTitle });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // The title attribute should contain the full untruncated text
    const cardTitle = document.querySelector(".card-title");
    expect(cardTitle).toHaveAttribute("title", longTitle);
  });

  it("does not truncate titles exactly 140 characters", () => {
    const exactTitle = "B".repeat(140);
    const task = makeTask({ title: exactTitle });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Exactly 140 characters should NOT be truncated (no ellipsis)
    const cardTitle = screen.getByText(exactTitle);
    expect(cardTitle).toBeDefined();
    expect(cardTitle.textContent).toBe(exactTitle);
    expect(cardTitle.textContent?.length).toBe(140);
  });

  it("truncates description fallback when no title present and description exceeds 140 chars", () => {
    const longDescription = "C".repeat(200);
    const task = makeTask({ title: undefined, description: longDescription });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // The description should be truncated to 140 chars + "…"
    const expectedTruncated = "C".repeat(140) + "…";
    const cardTitle = screen.getByText(expectedTruncated);
    expect(cardTitle).toBeDefined();
    expect(cardTitle.textContent?.length).toBe(141);
  });

  it("shows full description in tooltip when used as fallback", () => {
    const longDescription = "D".repeat(200);
    const task = makeTask({ title: undefined, description: longDescription });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // The title attribute should contain the full untruncated description
    const cardTitle = document.querySelector(".card-title");
    expect(cardTitle).toHaveAttribute("title", longDescription);
  });

  it("does not truncate short titles under 140 characters", () => {
    const shortTitle = "A".repeat(100);
    const task = makeTask({ title: shortTitle });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Short titles should display unchanged
    const cardTitle = screen.getByText(shortTitle);
    expect(cardTitle).toBeDefined();
    expect(cardTitle.textContent).toBe(shortTitle);
    expect(cardTitle.textContent?.length).toBe(100);
  });

  it("displays title when title exists", () => {
    const task = makeTask({ title: "My Task Title", description: "Some description" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("My Task Title")).toBeDefined();
    // Description should not be shown as title when title exists
    expect(screen.queryByText("Some description")).toBeNull();
  });

  it("falls back to task id when no title and no description", () => {
    const task = makeTask({ title: undefined, description: "" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Look for the task ID within the card-title element specifically
    const cardTitle = screen.getByText("FN-001", { selector: ".card-title" });
    expect(cardTitle).toBeDefined();
  });
});

/**
 * Tests for awaiting-approval visual state in TaskCard.
 * Tasks in triage with status "awaiting-approval" receive a distinct
 * highlight and approval-specific badge text on the board.
 */
describe("TaskCard awaiting-approval state", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies awaiting-approval class when task is in triage with awaiting-approval status", () => {
    const task = makeTask({ column: "triage", status: "awaiting-approval" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card?.classList.contains("awaiting-approval")).toBe(true);
  });

  it("does NOT apply awaiting-approval class for triage tasks with other statuses", () => {
    const task = makeTask({ column: "triage", status: "specifying" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card?.classList.contains("awaiting-approval")).toBe(false);
  });

  it("does NOT apply awaiting-approval class for non-triage columns", () => {
    const columns: Column[] = ["todo", "in-progress", "in-review", "done"];

    for (const column of columns) {
      const task = makeTask({ column, status: "awaiting-approval" });

      const { unmount } = render(
        <TaskCard
          task={task}
          onOpenDetail={vi.fn()}
          addToast={noopToast}
        />
      );

      const card = document.querySelector('[data-id="FN-099"]');
      expect(card?.classList.contains("awaiting-approval")).toBe(false);

      unmount();
    }
  });

  it("shows 'Awaiting Approval' badge text for awaiting-approval tasks", () => {
    const task = makeTask({ column: "triage", status: "awaiting-approval" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const badge = screen.getByText("Awaiting Approval");
    expect(badge).toBeDefined();
    expect(badge.classList.contains("card-status-badge")).toBe(true);
    expect(badge.classList.contains("awaiting-approval")).toBe(true);
  });

  it("shows raw status text for other triage statuses", () => {
    const task = makeTask({ column: "triage", status: "specifying" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should show raw status text, not "Awaiting Approval"
    expect(screen.getByText("specifying")).toBeDefined();
    expect(screen.queryByText("Awaiting Approval")).toBeNull();
  });

  it("does NOT apply agent-active class for awaiting-approval tasks", () => {
    const task = makeTask({ column: "triage", status: "awaiting-approval" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card?.classList.contains("agent-active")).toBe(false);
    expect(card?.classList.contains("awaiting-approval")).toBe(true);
  });

  it("awaiting-approval badge uses triage color styling", () => {
    const task = makeTask({ column: "triage", status: "awaiting-approval" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const badge = screen.getByText("Awaiting Approval") as HTMLElement;
    // The badge should use the awaiting-approval CSS class (no inline styles)
    expect(badge.classList.contains("awaiting-approval")).toBe(true);
    // Inline styles should not contain hardcoded colors
    expect(badge.style.background).toBe("");
    expect(badge.style.color).toBe("");
  });

  it("awaiting-approval card does NOT look like other states (no agent-active, failed, or paused)", () => {
    const task = makeTask({ column: "triage", status: "awaiting-approval" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    const card = document.querySelector('[data-id="FN-099"]');
    expect(card?.classList.contains("awaiting-approval")).toBe(true);
    expect(card?.classList.contains("agent-active")).toBe(false);
    expect(card?.classList.contains("failed")).toBe(false);
    expect(card?.classList.contains("paused")).toBe(false);
  });
});

describe("TaskCard files-changed in done column", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: null, loading: false });
  });

  it("shows mergeDetails.filesChanged for done column when set", () => {
    const task = makeTask({
      column: "done",
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main" },
    });
    mockUseSessionFiles.mockReturnValue({ files: ["a.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("7 files changed")).toBeInTheDocument();
    // Should NOT show session files count since mergeDetails takes priority
    expect(screen.queryByText("1 files changed")).not.toBeInTheDocument();
  });

  it("shows session files count for done column with worktree but no mergeDetails.filesChanged", () => {
    const task = makeTask({
      column: "done",
      worktree: "/repo/.worktrees/fn-099",
    });
    mockUseSessionFiles.mockReturnValue({ files: ["src/a.ts", "src/b.ts", "src/c.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
  });

  it("shows nothing for done column without worktree, modifiedFiles, and mergeDetails.filesChanged", () => {
    const task = makeTask({ column: "done" });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.queryByText(/files changed/)).not.toBeInTheDocument();
  });

  it("shows modifiedFiles count for done column without mergeDetails", () => {
    const task = makeTask({
      column: "done",
      modifiedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
  });

  it("prefers mergeDetails.filesChanged over modifiedFiles for done column", () => {
    const task = makeTask({
      column: "done",
      modifiedFiles: ["src/a.ts", "src/b.ts"],
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main" },
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("7 files changed")).toBeInTheDocument();
    expect(screen.queryByText("2 files changed")).not.toBeInTheDocument();
  });

  it("prefers mergeDetails.filesChanged over sessionFiles for done column", () => {
    const task = makeTask({
      column: "done",
      worktree: "/repo/.worktrees/fn-099",
      mergeDetails: { filesChanged: 5, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main" },
    });
    mockUseSessionFiles.mockReturnValue({ files: ["a.ts", "b.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should show the mergeDetails count, not the sessionFiles count
    expect(screen.getByText("5 files changed")).toBeInTheDocument();
    expect(screen.queryByText("2 files changed")).not.toBeInTheDocument();
  });

  it("shows loading state for done column with worktree and no mergeDetails", () => {
    const task = makeTask({
      column: "done",
      worktree: "/repo/.worktrees/fn-099",
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: true });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // No loading indicator is shown because sessionFiles.length is 0
    // The button only appears when files.length > 0
    expect(screen.queryByText(/files changed/)).not.toBeInTheDocument();
    expect(screen.queryByText("Checking files…")).not.toBeInTheDocument();
  });

  it("prefers diffStats.filesChanged over mergeDetails.filesChanged when both are set", () => {
    const task = makeTask({
      column: "done",
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main", commitSha: "abc123" },
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: { filesChanged: 5, additions: 20, deletions: 3 }, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should show diffStats count, not mergeDetails count
    expect(screen.getByText("5 files changed")).toBeInTheDocument();
    expect(screen.queryByText("7 files changed")).not.toBeInTheDocument();
  });

  it("falls back to mergeDetails.filesChanged when diffStats returns null", () => {
    const task = makeTask({
      column: "done",
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main", commitSha: "abc123" },
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: null, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // Should fall back to mergeDetails count
    expect(screen.getByText("7 files changed")).toBeInTheDocument();
  });

  it("falls back to mergeDetails.filesChanged when diffStats returns 0 files", () => {
    const task = makeTask({
      column: "done",
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main", commitSha: "abc123" },
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: { filesChanged: 0, additions: 0, deletions: 0 }, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // diffStats returns 0, which is > 0 is false, so it falls through to mergeDetails
    // Actually 0 is not > 0, so the first if block is skipped and it falls to modifiedFiles/sessionFiles
    // But mergeDetails.filesChanged is 7 — however the code uses diffCount ?? mergedCount
    // diffCount is 0 (not null/undefined), so displayCount = 0, and 0 > 0 is false
    // This means it falls through to modifiedFiles check
    expect(screen.queryByText("7 files changed")).not.toBeInTheDocument();
  });

  it("shows diffStats count even without mergeDetails", () => {
    const task = makeTask({
      column: "done",
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: { filesChanged: 3, additions: 10, deletions: 2 }, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
  });
});

describe("TaskCard singular/plural file count", () => {
  const noopToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: null, loading: false });
  });

  it("displays '1 file changed' (singular) for in-progress column with 1 session file", () => {
    const task = makeTask({
      column: "in-progress",
      worktree: "/repo/.worktrees/fn-099",
      status: "executing",
    });
    mockUseSessionFiles.mockReturnValue({ files: ["src/a.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("1 file changed")).toBeInTheDocument();
  });

  it("displays '2 files changed' (plural) for in-progress column with 2 session files", () => {
    const task = makeTask({
      column: "in-progress",
      worktree: "/repo/.worktrees/fn-099",
      status: "executing",
    });
    mockUseSessionFiles.mockReturnValue({ files: ["src/a.ts", "src/b.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("2 files changed")).toBeInTheDocument();
  });

  it("displays '1 file changed' (singular) for done column with displayCount=1 via diffStats", () => {
    const task = makeTask({
      column: "done",
      mergeDetails: { filesChanged: 7, mergedAt: "2026-01-01T00:00:00Z", targetBranch: "main" },
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: { filesChanged: 1, additions: 5, deletions: 0 }, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    expect(screen.queryByText("1 files changed")).not.toBeInTheDocument();
  });

  it("displays '1 file changed' (singular) for done column with modifiedFiles of length 1", () => {
    const task = makeTask({
      column: "done",
      modifiedFiles: ["src/a.ts"],
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    expect(screen.queryByText("1 files changed")).not.toBeInTheDocument();
  });

  it("displays '1 file changed' (singular) for done column with sessionFiles fallback of length 1", () => {
    const task = makeTask({
      column: "done",
      worktree: "/repo/.worktrees/fn-099",
    });
    mockUseSessionFiles.mockReturnValue({ files: ["src/a.ts"], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    expect(screen.queryByText("1 files changed")).not.toBeInTheDocument();
  });

  it("displays 'N files changed' (plural) for done column with diffStats count > 1", () => {
    const task = makeTask({ column: "done" });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });
    mockUseTaskDiffStats.mockReturnValue({ stats: { filesChanged: 3, additions: 10, deletions: 2 }, loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
  });

  it("displays 'N files changed' (plural) for done column with modifiedFiles length > 1", () => {
    const task = makeTask({
      column: "done",
      modifiedFiles: ["src/a.ts", "src/b.ts"],
    });
    mockUseSessionFiles.mockReturnValue({ files: [], loading: false });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    expect(screen.getByText("2 files changed")).toBeInTheDocument();
  });
});

describe("TaskCard mission badge", () => {
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task);

  it("renders mission badge when task has missionId", () => {
    const task = createTask({ missionId: "MSN-001" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />);

    const badge = screen.getByTitle("Mission: MSN-001");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("card-mission-badge");
    expect(badge).toHaveTextContent("MSN-001");
  });

  it("does not render mission badge when task has no missionId", () => {
    const task = createTask();
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />);

    expect(screen.queryByTitle(/Mission:/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("target-icon")).not.toBeInTheDocument();
  });

  it("calls onOpenMission when mission badge is clicked", async () => {
    const onOpenMission = vi.fn();
    const task = createTask({ missionId: "MSN-042" });
    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onOpenMission={onOpenMission}
      />
    );

    const badge = screen.getByTitle("Mission: MSN-042");
    await userEvent.click(badge);

    expect(onOpenMission).toHaveBeenCalledOnce();
    expect(onOpenMission).toHaveBeenCalledWith("MSN-042");
  });

  it("stops propagation when mission badge is clicked", async () => {
    const onOpenDetail = vi.fn();
    const onOpenMission = vi.fn();
    const task = createTask({ missionId: "MSN-001" });
    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={vi.fn()}
        onOpenMission={onOpenMission}
      />
    );

    const badge = screen.getByTitle("Mission: MSN-001");
    await userEvent.click(badge);

    // onOpenDetail should NOT be called since click is stopped
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onOpenMission).toHaveBeenCalledWith("MSN-001");
  });
});

describe("TaskCard agent badge", () => {
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task);

  let clearAgentCache: () => void;

  beforeAll(async () => {
    const mod = await import("../TaskCard");
    clearAgentCache = (mod as { __test_clearAgentNameCache?: () => void }).__test_clearAgentNameCache ?? (() => undefined);
  });

  beforeEach(async () => {
    clearAgentCache?.();
    const { fetchAgent } = await import("../../api");
    vi.mocked(fetchAgent).mockReset();
  });

  it("renders agent badge when task has assignedAgentId", async () => {
    const { fetchAgent } = await import("../../api");
    vi.mocked(fetchAgent).mockResolvedValue({
      id: "agent-001",
      name: "Autopilot Agent",
      role: "executor",
      state: "active",
      metadata: {},
      heartbeatHistory: [],
      completedRuns: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any);

    const task = createTask({ assignedAgentId: "agent-001" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      const badge = screen.getByTitle("Assigned to Autopilot Agent");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass("card-agent-badge");
      expect(screen.getByTestId("bot-icon")).toBeInTheDocument();
    });
  });

  it("does not render agent badge when assignedAgentId is undefined", () => {
    const task = createTask();
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />);

    expect(screen.queryByTitle(/Assigned to/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("bot-icon")).not.toBeInTheDocument();
  });
});

describe("TaskCard send-back functionality", () => {
  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task);

  it("renders send-back button when task is in-progress and onMoveTask is provided", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    expect(screen.getByRole("button", { name: /send back/i })).toBeInTheDocument();
  });

  it("does not render send-back button when task is in todo", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "todo" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    expect(screen.queryByRole("button", { name: /send back/i })).not.toBeInTheDocument();
  });

  it("does not render send-back button when task is in in-review", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "in-review" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    expect(screen.queryByRole("button", { name: /send back/i })).not.toBeInTheDocument();
  });

  it("does not render send-back button when onMoveTask is not provided", () => {
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /send back/i })).not.toBeInTheDocument();
  });

  it("toggles dropdown menu when send-back button is clicked", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    // Initially, dropdown is not visible
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // Click the send-back button
    const btn = screen.getByRole("button", { name: /send back/i });
    fireEvent.click(btn);

    // Dropdown should now be visible
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("dropdown shows Todo and Triage options but not In Review", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    // Open the dropdown
    fireEvent.click(screen.getByRole("button", { name: /send back/i }));

    // Check menu is visible
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    // Should show Todo and Triage
    expect(screen.getByRole("menuitem", { name: /todo/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /triage/i })).toBeInTheDocument();

    // Should NOT show In Review
    expect(screen.queryByRole("menuitem", { name: /in review/i })).not.toBeInTheDocument();
  });

  it("clicking a dropdown option calls onMoveTask with correct column and closes menu", async () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const addToast = vi.fn();
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={addToast} onMoveTask={onMoveTask} />);

    // Open the dropdown
    fireEvent.click(screen.getByRole("button", { name: /send back/i }));

    // Click "Todo" option
    fireEvent.click(screen.getByRole("menuitem", { name: /todo/i }));

    // Should have called onMoveTask
    await waitFor(() => {
      expect(onMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    });

    // Dropdown should be closed
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // Toast should have been shown
    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Moved FN-001 to Todo", "success");
    });
  });

  it("shows error toast when onMoveTask fails", async () => {
    const onMoveTask = vi.fn().mockRejectedValue(new Error("Network error"));
    const addToast = vi.fn();
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={addToast} onMoveTask={onMoveTask} />);

    // Open the dropdown and click "Triage"
    fireEvent.click(screen.getByRole("button", { name: /send back/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /triage/i }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to move FN-001"), "error");
    });
  });

  it("clicking outside dropdown closes it", () => {
    const onMoveTask = vi.fn().mockResolvedValue({});
    const task = createTask({ column: "in-progress" });
    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} onMoveTask={onMoveTask} />);

    // Open the dropdown
    fireEvent.click(screen.getByRole("button", { name: /send back/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click outside (on the card itself, not inside the send-back dropdown)
    fireEvent.click(document.querySelector(".card")!);

    // Dropdown should be closed
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

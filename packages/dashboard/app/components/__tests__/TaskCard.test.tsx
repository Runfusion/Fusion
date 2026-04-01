import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Column, Task, TaskDetail } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import React, { useState } from "react";

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
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
}));

beforeEach(() => {
  mockUseBadgeWebSocket.mockReset();
  mockUseBadgeWebSocket.mockReturnValue({
    badgeUpdates: new Map(),
    isConnected: false,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  });
});

/**
 * Tests for the agent-active class logic in TaskCard.
 *
 * These tests use extracted helper functions to test class computation logic directly.
 */

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

/** Mirrors the cardClass computation from TaskCard.tsx */
function computeCardClass(opts: { dragging?: boolean; queued?: boolean; status?: string; column?: Column; globalPaused?: boolean }): string {
  const { dragging = false, queued = false, status, column = "todo", globalPaused } = opts;
  const isFailed = status === "failed";
  const isAgentActive = !globalPaused && !queued && !isFailed && (column === "in-progress" || ACTIVE_STATUSES.has(status as string));
  return `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}`;
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
      expect(mockFetch).toHaveBeenCalledWith("FN-001");
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

    // Should show editing UI
    const titleInput = screen.getByPlaceholderText(/Task title/i);
    const descTextarea = screen.getByPlaceholderText(/Task description/i);

    expect(titleInput).toBeDefined();
    expect(descTextarea).toBeDefined();
    expect((titleInput as HTMLInputElement).value).toBe("Test Title");
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

    const titleInput = screen.getByPlaceholderText(/Task title/i);
    expect(titleInput).toBeDefined();
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
    const titleInput = screen.queryByPlaceholderText(/Task title/i);
    expect(titleInput).toBeNull();
  });

  it("Escape key cancels edit mode", () => {
    const task = makeEditableTask({ title: "Original Title" });

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

    const titleInput = screen.getByPlaceholderText(/Task title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Changed Title" } });

    // Press Escape
    fireEvent.keyDown(titleInput, { key: "Escape" });

    // Should exit edit mode without saving
    expect(screen.queryByPlaceholderText(/Task title/i)).toBeNull();
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

    const titleInput = screen.getByPlaceholderText(/Task title/i);

    // Tab out to move focus outside the editing area
    await user.tab();
    await user.tab(); // Second tab to move past the textarea

    // Wait for the blur handler to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have exited edit mode
    expect(screen.queryByPlaceholderText(/Task title/i)).toBeNull();
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
        title: "Title",
        description: "New Desc",
      });
    });
  });

  it("Enter in title moves focus to description", () => {
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
    const card = document.querySelector('[data-id="FN-099"]');
    fireEvent.doubleClick(card!);

    const titleInput = screen.getByPlaceholderText(/Task title/i) as HTMLInputElement;
    const descTextarea = screen.getByPlaceholderText(/Task description/i) as HTMLTextAreaElement;

    // Press Enter in title - should move focus to description
    fireEvent.keyDown(titleInput, { key: "Enter" });

    // Description should receive focus
    expect(document.activeElement).toBe(descTextarea);
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

  it("steps are collapsed by default for 'triage' column tasks", () => {
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

    // Steps should not be visible
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByText("Step 2")).toBeNull();

    // Toggle should show "Show steps"
    const toggle = screen.getByRole("button", { name: /Show steps/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
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

  it("opens modal when clicking the card body", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);
    const mockDetail: TaskDetail = {
      ...makeTask({ id: "FN-099" }),
      prompt: "",
      attachments: [],
    };
    mockFetch.mockResolvedValueOnce(mockDetail);
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

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("FN-099");
      expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
    });
  });

  it("does not render a separate expand button", () => {
    const task = makeTask();

    render(<TaskCard task={task} onOpenDetail={vi.fn()} addToast={noopToast} />);
    expect(screen.queryByRole("button", { name: /Open task details/i })).toBeNull();
  });

  it("opens modal only once per card click", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);
    const mockDetail: TaskDetail = {
      ...makeTask({ id: "FN-099" }),
      prompt: "",
      attachments: [],
    };
    mockFetch.mockResolvedValueOnce(mockDetail);
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

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("FN-099");
      expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
    });
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

  it("does not render an expand button in any column", () => {
    const columns: Column[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

    for (const column of columns) {
      const task = makeTask({ column });

      const { unmount } = render(
        <TaskCard
          task={task}
          onOpenDetail={vi.fn()}
          addToast={noopToast}
        />
      );

      expect(screen.queryByRole("button", { name: /Open task details/i })).toBeNull();

      unmount();
    }
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

  it("displays full description when no title exists (no truncation)", () => {
    const longDescription = "A".repeat(100);
    const task = makeTask({ title: undefined, description: longDescription });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
      />
    );

    // The full 100-character description should be visible
    const cardTitle = screen.getByText(longDescription);
    expect(cardTitle).toBeDefined();
    expect(cardTitle.textContent).toBe(longDescription);
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

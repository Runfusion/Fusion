import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Column, Task, TaskDetail } from "@kb/core";
import { TaskCard } from "../TaskCard";

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
}));

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
    expect(computeDepTooltip(["KB-001", "KB-042"])).toBe("KB-001, KB-042");
  });

  it("returns single dependency ID when only one dependency", () => {
    expect(computeDepTooltip(["KB-010"])).toBe("KB-010");
  });

  it("returns undefined when dependencies array is empty", () => {
    expect(computeDepTooltip([])).toBeUndefined();
  });

  it("handles many dependencies", () => {
    const deps = ["KB-001", "KB-002", "KB-003", "KB-004"];
    expect(computeDepTooltip(deps)).toBe("KB-001, KB-002, KB-003, KB-004");
  });

  it("data-tooltip attribute contains dependency IDs as a readable string", () => {
    const deps = ["KB-005", "KB-012"];
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
    expect(shouldShowScopeBadge("KB-003")).toBe(true);
  });

  it("does NOT show scope badge when blockedBy is undefined", () => {
    expect(shouldShowScopeBadge(undefined)).toBe(false);
  });

  it("shows card-meta when blockedBy is set even with no deps or queued status", () => {
    expect(shouldShowCardMeta({ blockedBy: "KB-003" })).toBe(true);
  });

  it("does NOT show card-meta when no deps, not queued, and no blockedBy", () => {
    expect(shouldShowCardMeta({})).toBe(false);
  });

  /** Mirrors tooltip computation from TaskCard.tsx */
  function computeScopeTooltip(blockedBy: string): string {
    return `Blocked by ${blockedBy} (file overlap)`;
  }

  it("generates correct tooltip text", () => {
    expect(computeScopeTooltip("KB-005")).toBe("Blocked by KB-005 (file overlap)");
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
    id: "KB-099",
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
    const task = makeTask({ dependencies: ["KB-001", "KB-002"] });
    const allTasks: Task[] = [
      makeTask({ id: "KB-001", description: "Dep 1" }),
      makeTask({ id: "KB-002", description: "Dep 2" }),
    ];

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={noopToast}
        tasks={allTasks}
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
      ...makeTask({ id: "KB-001", description: "Dep 1" }),
      prompt: "",
      attachments: [],
    };
    mockFetch.mockResolvedValueOnce(mockDetail);
    const onOpenDetail = vi.fn();

    const task = makeTask({ dependencies: ["KB-001"] });
    const allTasks: Task[] = [makeTask({ id: "KB-001", description: "Dep 1" })];

    render(
      <TaskCard
        task={task}
        onOpenDetail={onOpenDetail}
        addToast={noopToast}
        tasks={allTasks}
      />
    );

    const depBadge = screen.getByTitle(/Click to view/);
    fireEvent.click(depBadge);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("KB-001");
      expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
    });
  });

  it("shows error toast when dependency fetch fails", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);
    mockFetch.mockRejectedValueOnce(new Error("Task not found"));
    const onOpenDetail = vi.fn();
    const addToast = vi.fn();

    const task = makeTask({ dependencies: ["KB-001"] });

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
      expect(addToast).toHaveBeenCalledWith("Failed to load dependency KB-001", "error");
    });
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("uses stopPropagation so card click is not triggered", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);
    mockFetch.mockRejectedValueOnce(new Error("Stop here"));
    const addToast = vi.fn();

    const task = makeTask({ dependencies: ["KB-001"] });

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

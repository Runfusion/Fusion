import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { TaskChangesTab } from "../TaskChangesTab";

const useTaskDiffStatsMock = vi.fn();
const fetchTaskDiffMock = vi.fn();
const fetchTaskCommitAssociationsMock = vi.fn();

vi.mock("../../hooks/useTaskDiffStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTaskDiffStats")>();
  return {
    ...actual,
    useTaskDiffStats: (...args: unknown[]) => useTaskDiffStatsMock(...args),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchTaskDiff: (...args: unknown[]) => fetchTaskDiffMock(...args),
    fetchTaskCommitAssociations: (...args: unknown[]) => fetchTaskCommitAssociationsMock(...args),
  };
});

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Link: () => null,
  GitBranch: () => null,
  Clock: () => null,
  Pencil: () => null,
  Layers: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  GitPullRequest: () => null,
  CircleDot: () => null,
  Target: () => null,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => null,
  FileCode: () => null,
  ChevronRight: () => null,
  ChevronLeft: () => null,
  AlertCircle: () => null,
  GitCommit: () => null,
  WrapText: () => null,
  Maximize2: () => null,
  };
});

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../ChangesDiffModal", () => ({ ChangesDiffModal: () => null }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../utils/highlightDiff", () => ({ highlightDiff: (diff: string) => diff }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-4521",
    title: "Parity",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    columnMovedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("TaskCard/TaskChangesTab files-changed parity", () => {
  beforeEach(() => {
    useTaskDiffStatsMock.mockReset();
    fetchTaskDiffMock.mockReset();
    fetchTaskCommitAssociationsMock.mockReset();
    fetchTaskCommitAssociationsMock.mockResolvedValue({ taskId: "FN-4521", lineageId: null, associations: [] });
  });

  it.each([
    ["in-progress", undefined, undefined],
    ["in-review", undefined, undefined],
    ["done", undefined, { commitSha: "abc123" }],
  ] as const)("keeps counts aligned for %s", async (column, worktree, mergeDetails) => {
    const stats = { filesChanged: 3, additions: 5, deletions: 2 };
    useTaskDiffStatsMock.mockReturnValue({ stats, loading: false });
    fetchTaskDiffMock.mockResolvedValue({
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@" },
        { path: "b.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" },
        { path: "c.ts", status: "added", additions: 3, deletions: 1, patch: "@@" },
      ],
      stats,
    });

    const task = makeTask({ column, worktree, mergeDetails });

    const { container } = render(
      <>
        <TaskCard task={task} onOpenDetail={() => {}} addToast={() => {}} />
        <TaskChangesTab taskId={task.id} worktree={worktree} column={column} mergeDetails={mergeDetails} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Files Changed \(3\)/)).toBeTruthy();
    });
    expect(container.textContent).toContain("3 files changed");
  });
});

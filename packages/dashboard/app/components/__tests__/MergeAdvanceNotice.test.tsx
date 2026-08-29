import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MergeAdvanceNotice from "../MergeAdvanceNotice";

const mocked = vi.hoisted(() => ({
  useMergeAdvanceNotice: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  dismiss: vi.fn(),
  clearPushError: vi.fn(),
  setForceWithLease: vi.fn(),
  setConflictState: vi.fn(),
  stashModal: vi.fn(() => null),
}));

vi.mock("../../hooks/useMergeAdvanceNotice", () => ({ useMergeAdvanceNotice: mocked.useMergeAdvanceNotice }));
vi.mock("../StashConflictModal", () => ({ default: mocked.stashModal }));

function baseHookState(overrides: Record<string, unknown> = {}) {
  return {
    notice: {
      taskId: "FN-1",
      integrationBranch: "trunk",
      toSha: "abcdef123456",
      userCheckout: { worktreePath: "/repo", dirty: false, untrackedCount: 0 },
    },
    dismiss: mocked.dismiss,
    pull: mocked.pull,
    pullState: "idle",
    conflictState: null,
    setConflictState: mocked.setConflictState,
    pushStatus: {
      integrationBranch: "trunk",
      aheadCount: 2,
      remoteSha: "abcdef123456",
      canPush: true,
      disabledReason: undefined,
    },
    pushState: "idle",
    push: mocked.push,
    clearPushError: mocked.clearPushError,
    forceWithLease: false,
    setForceWithLease: mocked.setForceWithLease,
    ...overrides,
  };
}

describe("MergeAdvanceNotice push affordance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocked.stashModal.mockImplementation(() => null);
  });

  it("renders push section only when aheadCount > 0", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState());
    const { rerender } = render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByText(/Push trunk to origin — ahead by 2 commits\./)).toBeInTheDocument();
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushStatus: { integrationBranch: "trunk", aheadCount: 0, canPush: false, remoteSha: null } }));
    rerender(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.queryByText(/Push trunk to origin/)).toBeNull();
  });

  it("push button interactions and force-with-lease styling", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState());
    const { rerender } = render(<MergeAdvanceNotice projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Push to origin" }));
    expect(mocked.push).toHaveBeenCalledTimes(1);

    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushState: "pending" }));
    rerender(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByRole("button", { name: "Pushing…" })).toBeDisabled();

    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ forceWithLease: true }));
    rerender(<MergeAdvanceNotice projectId="p1" />);
    const warningButton = screen.getByRole("button", { name: "Push (force-with-lease)" });
    expect(warningButton.className).toContain("btn-warning");
  });

  it.each([
    ["no-remote", "No `origin` remote configured."],
    ["no-upstream", "Branch has no upstream on origin."],
    ["merge-locked", "Push paused — a Fusion merge is in progress."],
  ])("shows disabled copy for %s", (reason, copy) => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushStatus: { integrationBranch: "trunk", aheadCount: 2, canPush: false, disabledReason: reason } }));
    render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("hides section for not-ahead and not-a-git-repo", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushStatus: { integrationBranch: "trunk", aheadCount: 0, canPush: false, disabledReason: "not-ahead" } }));
    const { rerender } = render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.queryByText(/Push trunk to origin/)).toBeNull();
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushStatus: { integrationBranch: "trunk", aheadCount: 0, canPush: false, disabledReason: "not-a-git-repo" } }));
    rerender(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.queryByText(/Push trunk to origin/)).toBeNull();
  });

  it("advanced toggle updates forceWithLease", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState());
    render(<MergeAdvanceNotice projectId="p1" />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(mocked.setForceWithLease).toHaveBeenCalledWith(true);
  });

  it("rejected-non-ff shows Smart Pull action", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushState: { error: "Remote diverged", outcome: "rejected-non-ff" } }));
    render(<MergeAdvanceNotice projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Smart Pull" }));
    expect(mocked.pull).toHaveBeenCalledTimes(1);
  });

  it("rejected-other/failed shows stderr and dismiss", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pushState: { error: "Push failed", outcome: "rejected-other", stderr: "fatal" } }));
    render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByText("fatal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mocked.clearPushError).toHaveBeenCalledTimes(1);
  });

  it("push and pull state stay independent", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ pullState: "idle", pushState: { error: "locked", outcome: "merge-locked" } }));
    render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  });

  it("shows pull and dirty stash copy when checkout is dirty", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({ notice: { ...baseHookState().notice, userCheckout: { worktreePath: "/repo", dirty: true, untrackedCount: 2 } } }));
    render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeInTheDocument();
    expect(screen.getByText(/local changes will be auto-stashed and restored/)).toBeInTheDocument();
  });

  it("hides pull button while stash conflict modal is open", () => {
    mocked.stashModal.mockImplementation(() => null);
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({
      conflictState: {
        stashSha: "abc1234",
        stashLabel: "fusion-auto",
        conflictedFiles: ["src/a.ts"],
        autostashOutcome: "conflict-needs-manual",
      },
    }));
    render(<MergeAdvanceNotice projectId="p1" />);
    expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
  });

  it("does not dismiss notice when modal closes without dropping stash", () => {
    mocked.useMergeAdvanceNotice.mockReturnValue(baseHookState({
      conflictState: {
        stashSha: "abc1234",
        stashLabel: "fusion-auto",
        conflictedFiles: ["src/a.ts"],
        autostashOutcome: "conflict-needs-manual",
      },
    }));
    render(<MergeAdvanceNotice projectId="p1" />);
    const modalProps = mocked.stashModal.mock.calls.at(-1)?.[0] as { onClose: (stashDropped?: boolean) => void };
    modalProps.onClose(false);
    expect(mocked.dismiss).not.toHaveBeenCalled();
  });
});

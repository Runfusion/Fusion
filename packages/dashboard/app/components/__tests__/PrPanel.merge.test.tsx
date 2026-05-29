import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrPanel } from "../PrPanel";
import { mergePr, refreshPrStatus } from "../../api";

vi.mock("../../api", () => ({
  refreshPrStatus: vi.fn(),
  fetchPrChecks: vi.fn().mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: new Date().toISOString() }),
  fetchPrReviews: vi.fn().mockResolvedValue({ snapshot: { decision: null, items: [] }, comments: [] }),
  mergePr: vi.fn().mockResolvedValue({ prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 } }),
  setAutoMergeOnGreen: vi.fn().mockResolvedValue({ prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, autoMergeOnGreen: true } }),
}));

describe("PrPanel merge controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-refreshes status once on mount for open non-draft PRs", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 },
      checks: [],
      reviewDecision: null,
      blockingReasons: [],
      mergeReady: false,
    });

    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 }} />);

    await waitFor(() => {
      expect(refreshPrStatus).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { status: "closed" as const, draft: false },
    { status: "merged" as const, draft: false },
    { status: "open" as const, draft: true },
  ])("does not auto-refresh for non-eligible PRs %#", async (state) => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: state.status, title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, draft: state.draft },
      checks: [],
      reviewDecision: null,
      blockingReasons: [],
      mergeReady: false,
    });

    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, ...state }} />);

    await waitFor(() => {
      expect(refreshPrStatus).not.toHaveBeenCalled();
    });
  });
  it.each([
    [{ status: "open", draft: false }, true],
    [{ status: "open", draft: true }, false],
    [{ status: "open", isDraft: true }, false],
    [{ status: "closed", draft: false }, false],
    [{ status: "merged", draft: false }, false],
  ] as const)("shows merge controls matrix %#", (state, expected) => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, ...state }} />);
    expect(screen.queryByText("Merge pull request") !== null).toBe(expected);
  });

  it("shows merged banner", () => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 }} />);
    expect(screen.getByText("Merged — task moved to Done")).toBeInTheDocument();
  });

  it("merges targeted PR card when multiple PRs are rendered", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0 },
      checks: [],
      reviewDecision: null,
      blockingReasons: [],
      mergeReady: true,
      all: [
        { prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "A", headBranch: "h1", baseBranch: "main", commentCount: 0 }, checks: [], reviewDecision: null, blockingReasons: [], mergeReady: false },
        { prInfo: { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0, mergeable: "clean" }, checks: [], reviewDecision: null, blockingReasons: [], mergeReady: true },
      ],
      primary: { prInfo: { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0 }, checks: [], reviewDecision: null, blockingReasons: [], mergeReady: true },
    });
    const onPrUpdated = vi.fn();
    render(
      <PrPanel
        taskId="FN-1"
        prAuthAvailable
        onPrUpdated={onPrUpdated}
        addToast={() => {}}
        prInfos={[
          { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "A", headBranch: "h1", baseBranch: "main", commentCount: 0 },
          { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0, mergeable: "clean" },
        ]}
      />,
    );

    await screen.findAllByRole("button", { name: "Merge pull request" });
    fireEvent.click(screen.getAllByRole("button", { name: "Merge pull request" })[1]!);
    expect(mergePr).toHaveBeenCalledWith("FN-1", "squash", undefined, 2);
  });

  it("enables merge on first render when mergeable is clean", () => {
    render(
      <PrPanel
        taskId="FN-1"
        prAuthAvailable
        onPrUpdated={() => {}}
        addToast={() => {}}
        prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, mergeable: "clean" }}
      />, 
    );

    const mergeButton = screen.getByRole("button", { name: "Merge pull request" });
    expect(mergeButton).toBeEnabled();
    fireEvent.click(mergeButton);
    expect(mergePr).toHaveBeenCalledWith("FN-1", "squash", undefined, 1);
  });

  it.each([
    ["conflicting", "conflicting" as const],
    ["unknown", "unknown" as const],
  ])("keeps merge disabled when mergeable is %s", (label, mergeable) => {
    render(
      <PrPanel
        taskId="FN-1"
        prAuthAvailable
        onPrUpdated={() => {}}
        addToast={() => {}}
        prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, mergeable }}
      />,
    );

    expect(screen.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
  });

  it("keeps merge disabled when mergeable is undefined", () => {
    render(
      <PrPanel
        taskId="FN-1"
        prAuthAvailable
        onPrUpdated={() => {}}
        addToast={() => {}}
        prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 }}
      />,
    );

    expect(screen.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
  });

  it("shows error block and retry", () => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, lastMergeError: "boom" }} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
});

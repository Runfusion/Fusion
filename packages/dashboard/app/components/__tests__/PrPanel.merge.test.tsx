import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
        { prInfo: { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0 }, checks: [], reviewDecision: null, blockingReasons: [], mergeReady: true },
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
          { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "B", headBranch: "h2", baseBranch: "main", commentCount: 0 },
        ]}
      />,
    );

    fireEvent.click(screen.getAllByTitle("Refresh PR status")[1]!);
    await screen.findAllByRole("button", { name: "Merge pull request" });
    fireEvent.click(screen.getAllByRole("button", { name: "Merge pull request" })[1]!);
    expect(mergePr).toHaveBeenCalledWith("FN-1", "squash", undefined, 2);
  });

  it("shows error block and retry", () => {
    render(<PrPanel taskId="FN-1" prAuthAvailable onPrUpdated={() => {}} addToast={() => {}} prInfo={{ url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0, lastMergeError: "boom" }} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
});

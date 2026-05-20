import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PrPanel } from "../PrPanel";

vi.mock("../../api", () => ({
  refreshPrStatus: vi.fn(),
  fetchPrChecks: vi.fn(),
  fetchPrReviews: vi.fn(),
  mergePr: vi.fn(),
  reclaimPrConflict: vi.fn(),
  setAutoMergeOnGreen: vi.fn(),
  unlinkPr: vi.fn(),
}));

import { refreshPrStatus, fetchPrChecks, fetchPrReviews, mergePr, reclaimPrConflict, setAutoMergeOnGreen, unlinkPr } from "../../api";

const originalClipboard = navigator.clipboard;
const mockAddToast = vi.fn();
const mockOnPrUpdated = vi.fn();
const mockOnRequestCreatePr = vi.fn();

const mockPrInfo = {
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  status: "open" as const,
  title: "Fix the bug",
  headBranch: "fusion/fn-001",
  baseBranch: "main",
  commentCount: 3,
  lastCommentAt: "2026-01-01T00:00:00.000Z",
};

const checksByRollup = {
  success: [{ name: "build", required: true, state: "success", detailsUrl: "https://ci.example/build" }],
  failure: [{ name: "build", required: true, state: "failure", detailsUrl: "https://ci.example/build" }],
  pending: [{ name: "build", required: true, state: "pending", detailsUrl: "https://ci.example/build" }],
  none: [],
} as const;

describe("PrPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchPrChecks as ReturnType<typeof vi.fn>).mockResolvedValue({
      checks: [],
      rollup: "unknown",
      lastCheckedAt: new Date().toISOString(),
    });
    (fetchPrReviews as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: { decision: null, items: [] }, comments: [] });
    (mergePr as ReturnType<typeof vi.fn>).mockResolvedValue({ prInfo: { ...mockPrInfo, status: "merged" } });
    (setAutoMergeOnGreen as ReturnType<typeof vi.fn>).mockResolvedValue({ prInfo: { ...mockPrInfo, autoMergeOnGreen: true } });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("renders create button and calls onRequestCreatePr", () => {
    render(
      <PrPanel
        taskId="FN-001"
        prAuthAvailable={true}
        onRequestCreatePr={mockOnRequestCreatePr}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Create PR/i }));
    expect(mockOnRequestCreatePr).toHaveBeenCalledTimes(1);
  });

  it("does not render input or textarea in no-PR state", () => {
    render(<PrPanel taskId="FN-001" prAuthAvailable={true} onRequestCreatePr={mockOnRequestCreatePr} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("disables create button and shows auth hint when pr auth unavailable", () => {
    render(<PrPanel taskId="FN-001" prAuthAvailable={false} onRequestCreatePr={mockOnRequestCreatePr} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    const button = screen.getByRole("button", { name: /Create PR/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/gh auth login/i)).toBeInTheDocument();
  });

  it("shows creating-pr automation hint", () => {
    render(<PrPanel taskId="FN-001" automationStatus="creating-pr" prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    expect(screen.getByText(/creating a pull request automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create PR/i })).toBeNull();
  });

  it("shows autoMerge hint in no-PR state", () => {
    render(<PrPanel taskId="FN-001" autoMerge={true} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    expect(screen.getByText(/Auto-merge will handle this task automatically./i)).toBeInTheDocument();
  });

  it("renders PR details when prInfo exists", () => {
    render(<PrPanel taskId="FN-001" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("fusion/fn-001")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on GitHub/i })).toBeInTheDocument();
  });

  it("refreshes PR status and updates toast/callback", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { ...mockPrInfo, status: "merged" },
      checks: [],
      reviewDecision: null,
      blockingReasons: [],
      primary: {
        prInfo: { ...mockPrInfo, status: "merged" },
        checks: [],
        reviewDecision: null,
        blockingReasons: [],
        mergeReady: false,
      },
      all: [{
        prInfo: { ...mockPrInfo, status: "merged" },
        checks: [],
        reviewDecision: null,
        blockingReasons: [],
        mergeReady: false,
      }],
      mergeReady: false,
    });

    render(<PrPanel taskId="FN-001" projectId="project-1" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);

    fireEvent.click(screen.getByTitle("Refresh PR status"));

    await waitFor(() => {
      expect(refreshPrStatus).toHaveBeenCalledWith("FN-001", "project-1");
    });
    expect(mockOnPrUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: "merged" }));
    expect(mockAddToast).toHaveBeenCalledWith("PR status refreshed", "success");
  });

  it("renders checks rollup after refresh", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: mockPrInfo,
      checks: [
        { name: "build", required: true, state: "success" },
        { name: "lint", required: false, state: "failure" },
        { name: "e2e", required: true, state: "pending" },
      ],
      reviewDecision: null,
      blockingReasons: [],
    });

    render(<PrPanel taskId="FN-001" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    fireEvent.click(screen.getByTitle("Refresh PR status"));

    expect(await screen.findByText("1 passing, 1 failing, 1 pending")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("e2e")).toBeInTheDocument();
    expect(screen.getAllByText("Required").length).toBe(2);
  });

  it("handles undefined checks payload without rendering checks list", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: mockPrInfo,
      checks: undefined,
      reviewDecision: null,
      blockingReasons: [],
    });

    render(<PrPanel taskId="FN-001" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    fireEvent.click(screen.getByTitle("Refresh PR status"));

    expect(await screen.findByText(/No checks reported yet/i)).toBeInTheDocument();
  });

  it.each([
    { status: "open", rollup: "success", expectMerge: true, expectReadonly: false, expectChecksVisible: true },
    { status: "draft", rollup: "failure", expectMerge: false, expectReadonly: true, expectChecksVisible: true },
    { status: "merged", rollup: "pending", expectMerge: false, expectReadonly: true, expectChecksVisible: false },
    { status: "closed", rollup: "none", expectMerge: false, expectReadonly: true, expectChecksVisible: false },
  ])("handles state=$status and checks=$rollup", async ({ status, rollup, expectMerge, expectReadonly, expectChecksVisible }) => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { ...mockPrInfo, status, draft: status === "draft" },
      checks: checksByRollup[rollup],
      reviewDecision: null,
      blockingReasons: status === "open" && rollup === "success" ? [] : ["waiting"],
      mergeReady: status === "open" && rollup === "success",
    });

    render(<PrPanel taskId="FN-001" prInfo={{ ...mockPrInfo, status, draft: status === "draft" }} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    fireEvent.click(screen.getByTitle("Refresh PR status"));

    await screen.findByText(/View on GitHub/i);
    if (expectChecksVisible) {
      expect(screen.getByText(/passing, .*failing, .*pending/i)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/passing, .*failing, .*pending/i)).toBeNull();
    }

    const mergeButton = screen.queryByRole("button", { name: /merge pull request/i });
    if (expectMerge) {
      expect(mergeButton).toBeInTheDocument();
    } else {
      expect(mergeButton).toBeNull();
    }

    if (expectReadonly) {
      expect(screen.queryByRole("combobox")).toBeNull();
    }
  });

  it("renders review decision states", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ prInfo: mockPrInfo, checks: [], reviewDecision: "CHANGES_REQUESTED", blockingReasons: [] })
      .mockResolvedValueOnce({ prInfo: mockPrInfo, checks: [], reviewDecision: "APPROVED", blockingReasons: [] })
      .mockResolvedValueOnce({ prInfo: mockPrInfo, checks: [], reviewDecision: null, blockingReasons: [] });

    render(<PrPanel taskId="FN-001" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);

    fireEvent.click(screen.getByTitle("Refresh PR status"));
    expect(await screen.findByText("CHANGES_REQUESTED")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Refresh PR status"));
    expect(await screen.findByText("APPROVED")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Refresh PR status"));
    expect(await screen.findByText("No reviews yet")).toBeInTheDocument();
  });

  it("renders conflict hint and retries conflict reclaim", async () => {
    (reclaimPrConflict as ReturnType<typeof vi.fn>).mockResolvedValue({ queued: true });
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: { ...mockPrInfo, mergeable: "conflicting" },
      checks: [],
      reviewDecision: null,
      blockingReasons: ["conflict"],
      mergeReady: false,
    });

    render(
      <PrPanel
        taskId="FN-001"
        projectId="project-1"
        prInfo={{ ...mockPrInfo, mergeable: "conflicting" }}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Retry conflict reclaim/i }));

    await waitFor(() => {
      expect(reclaimPrConflict).toHaveBeenCalledWith("FN-001", "project-1");
      expect(refreshPrStatus).toHaveBeenCalledWith("FN-001", "project-1");
    });
  });

  it("shows reviewer feedback hint when changes are requested and task is in todo", async () => {
    (fetchPrReviews as ReturnType<typeof vi.fn>).mockResolvedValue({
      snapshot: {
        decision: "CHANGES_REQUESTED",
        items: [
          {
            id: "gh-review-1",
            state: "CHANGES_REQUESTED",
            body: "Please split this function",
            author: { login: "reviewer" },
            htmlUrl: "https://github.com/owner/repo/pull/42#review-1",
          },
        ],
      },
      comments: [],
    });

    render(<PrPanel taskId="FN-001" taskColumn="todo" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);

    expect(await screen.findByText(/Auto-moved to Todo/i)).toBeInTheDocument();
    expect(screen.getByText(/Please split this function/i)).toBeInTheDocument();
  });

  it("renders conflict diagnostics subsection with files and commands", () => {
    render(
      <PrPanel
        taskId="FN-001"
        prInfo={{
          ...mockPrInfo,
          mergeable: "conflicting",
          conflictDiagnostics: {
            conflictingFiles: ["packages/dashboard/src/github.ts", "packages/core/src/types.ts"],
            suggestedCommands: ["git fetch origin", "git checkout fusion/fn-001", "git rebase origin/main", "# Resolve conflicts then: git add <files> && git rebase --continue"],
            capturedAt: "2026-05-18T00:00:00.000Z",
          },
        }}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    expect(screen.getByText("packages/dashboard/src/github.ts")).toBeInTheDocument();
    expect(screen.getByText("packages/core/src/types.ts")).toBeInTheDocument();
    expect(screen.getByText(/git checkout fusion\/fn-001/)).toBeInTheDocument();
  });

  it("hides conflict diagnostics subsection when not conflicting and no diagnostics", () => {
    render(<PrPanel taskId="FN-001" prInfo={{ ...mockPrInfo, mergeable: "clean" }} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    expect(screen.queryByText("Conflicts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-check conflicts" })).toBeNull();
  });

  it("copies suggested commands from diagnostics", async () => {
    render(
      <PrPanel
        taskId="FN-001"
        prInfo={{
          ...mockPrInfo,
          mergeable: "conflicting",
          conflictDiagnostics: {
            conflictingFiles: ["packages/dashboard/src/github.ts"],
            suggestedCommands: ["git fetch origin", "git checkout fusion/fn-001"],
            capturedAt: "2026-05-18T00:00:00.000Z",
          },
        }}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("git fetch origin\ngit checkout fusion/fn-001");
    });
  });

  it("renders multi-pr summary and unlinks targeted PR", async () => {
    const onPrUnlinked = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <PrPanel
        taskId="FN-001"
        projectId="project-1"
        prInfos={[mockPrInfo, { ...mockPrInfo, number: 99, url: "https://github.com/owner/repo/pull/99", title: "Another" }]}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        onPrUnlinked={onPrUnlinked}
        addToast={mockAddToast}
      />,
    );

    expect(screen.getByText("2 pull requests")).toBeInTheDocument();
    expect(document.querySelector(".pr-panel-summary-badge")?.textContent).toBe("open");
    fireEvent.click(screen.getAllByRole("button", { name: "Unlink" })[1]!);
    await waitFor(() => expect(unlinkPr).toHaveBeenCalledWith("FN-001", 99, "project-1"));
    expect(onPrUnlinked).toHaveBeenCalledWith(99);
    confirmSpy.mockRestore();
  });

  it("uses worst rollup state badge for multi-pr summary", () => {
    render(
      <PrPanel
        taskId="FN-001"
        prInfos={[{ ...mockPrInfo, mergeable: "conflicting" as const }, { ...mockPrInfo, number: 100, url: "https://github.com/owner/repo/pull/100" }]}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    expect(screen.getByText("conflicting")).toBeInTheDocument();
  });

  it("re-check conflicts triggers refreshPrStatus", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ prInfo: mockPrInfo, checks: [], reviewDecision: null, blockingReasons: [] });
    render(
      <PrPanel
        taskId="FN-001"
        projectId="project-1"
        prInfo={{
          ...mockPrInfo,
          mergeable: "conflicting",
          conflictDiagnostics: {
            conflictingFiles: ["packages/dashboard/src/github.ts"],
            suggestedCommands: ["git fetch origin"],
            capturedAt: "2026-05-18T00:00:00.000Z",
          },
        }}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-check conflicts" }));
    await waitFor(() => {
      expect(refreshPrStatus).toHaveBeenCalledWith("FN-001", "project-1");
    });
  });

  it("shows conflict hint from blocking reasons after refresh", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      prInfo: mockPrInfo,
      checks: [],
      reviewDecision: null,
      blockingReasons: ["merge conflict"],
      mergeReady: false,
    });

    render(
      <PrPanel
        taskId="FN-001"
        prInfo={mockPrInfo}
        prAuthAvailable={true}
        onPrUpdated={mockOnPrUpdated}
        addToast={mockAddToast}
      />,
    );

    fireEvent.click(screen.getByTitle("Refresh PR status"));
    expect(await screen.findByRole("button", { name: /Retry conflict reclaim/i })).toBeInTheDocument();
  });

  it("shows inline structured refresh error and retries", async () => {
    (refreshPrStatus as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(Object.assign(new Error("auth failed"), {
        details: {
          githubError: {
            code: "not-authenticated",
            message: "GitHub CLI is not authenticated.",
            hint: "Run 'gh auth login' to authenticate with GitHub.",
            action: { kind: "shell", command: "gh auth login" },
            retryable: true,
          },
        },
      }))
      .mockResolvedValueOnce({ prInfo: mockPrInfo, checks: [], reviewDecision: null, blockingReasons: [] });

    render(<PrPanel taskId="FN-001" prInfo={mockPrInfo} prAuthAvailable={true} onPrUpdated={mockOnPrUpdated} addToast={mockAddToast} />);
    fireEvent.click(screen.getByTitle("Refresh PR status"));

    expect((await screen.findAllByText(/gh auth login/i)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(refreshPrStatus).toHaveBeenCalledTimes(2);
    });
  });
});

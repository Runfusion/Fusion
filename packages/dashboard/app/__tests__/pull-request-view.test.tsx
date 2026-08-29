import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PullRequestView, type PrDetail } from "../components/PullRequestView";

// Icons → simple stubs so assertions key on text/testids, not SVG internals.
vi.mock("lucide-react", () => {
  const Stub = () => <span />;
  return {
    AlertTriangle: Stub,
    CheckCircle: Stub,
    Clock: Stub,
    ExternalLink: Stub,
    GitMerge: Stub,
    GitPullRequest: Stub,
    MessageSquare: Stub,
    RotateCcw: Stub,
    ThumbsUp: Stub,
    XCircle: Stub,
  };
});

function makeSummary(over: Partial<PrDetail["summary"]> = {}): PrDetail["summary"] {
  return {
    mergeable: "clean",
    reviewDecision: "APPROVED",
    checksRollup: "success",
    conflicting: false,
    autoMerge: false,
    autoMergeReason: "Ready to merge",
    autoMergeReady: true,
    actionable: true,
    active: true,
    pendingThreads: 0,
    disagreedThreads: 0,
    ...over,
  };
}

function makeDetail(over: Partial<PrDetail> = {}): PrDetail {
  const id = over.id ?? "PR-1";
  return {
    id,
    sourceType: "task",
    sourceId: "FN-1",
    repo: "owner/repo",
    headBranch: "feature/x",
    state: "open",
    prNumber: 42,
    prUrl: "https://example/pr/42",
    mergeable: "clean",
    checksRollup: "success",
    reviewDecision: "APPROVED",
    autoMerge: false,
    unverified: false,
    responseRounds: 0,
    threads: [],
    summary: makeSummary(over.summary),
    ...over,
  };
}

function makeList(): PrDetail[] {
  return [
    makeDetail({ id: "PR-1", repo: "owner/repo", headBranch: "feature/x", prNumber: 42 }),
    makeDetail({ id: "PR-2", repo: "owner/other", headBranch: "feature/y", prNumber: 7 }),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PullRequestView list mode", () => {
  it("renders project PRs when mounted without an id or detail", async () => {
    render(<PullRequestView loadPullRequests={vi.fn(async () => makeList())} />);

    const list = await screen.findByTestId("pr-list");
    expect(list).toBeTruthy();
    expect(screen.getAllByTestId("pr-list-item")).toHaveLength(2);
    expect(screen.getByText("owner/repo")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.queryByTestId("pr-view-empty")).toBeNull();
  });

  it("shows a bounded loading state while the list fetch is in flight", async () => {
    const pending = deferred<PrDetail[]>();
    render(<PullRequestView loadPullRequests={() => pending.promise} />);

    expect(await screen.findByTestId("pr-list-loading")).toBeTruthy();
    pending.resolve(makeList());
    expect(await screen.findByTestId("pr-list")).toBeTruthy();
    expect(screen.queryByTestId("pr-list-loading")).toBeNull();
  });

  it("shows the list empty state for zero active PRs without spinning", async () => {
    render(<PullRequestView loadPullRequests={vi.fn(async () => [])} />);

    expect(await screen.findByTestId("pr-list-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-list-loading")).toBeNull();
    expect(screen.queryByTestId("pr-view-empty")).toBeNull();
  });

  it("shows a list error state when the list fetch fails", async () => {
    render(<PullRequestView loadPullRequests={vi.fn(async () => { throw new Error("network down"); })} />);

    expect(await screen.findByTestId("pr-list-error")).toHaveTextContent("network down");
    expect(screen.queryByTestId("pr-list-loading")).toBeNull();
  });

  it("loads selected PR detail and returns back to the list", async () => {
    const list = makeList();
    const loadPullRequest = vi.fn(async (id: string) => makeDetail({ id, repo: "owner/selected", prNumber: 99 }));
    render(<PullRequestView loadPullRequests={vi.fn(async () => list)} loadPullRequest={loadPullRequest} />);

    fireEvent.click((await screen.findAllByTestId("pr-list-item"))[1]);

    await waitFor(() => expect(loadPullRequest).toHaveBeenCalledWith("PR-2"));
    expect(await screen.findByTestId("pr-view")).toBeTruthy();
    expect(screen.getByText("owner/selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pr-back-to-list"));
    expect(await screen.findByTestId("pr-list")).toBeTruthy();
  });

  it("does not enter list mode for parent-supplied detail, explicit null detail, or explicit ids", async () => {
    const loadPullRequests = vi.fn(async () => makeList());
    const { rerender } = render(<PullRequestView detail={makeDetail()} loadPullRequests={loadPullRequests} />);

    expect(screen.getByTestId("pr-view")).toBeTruthy();
    expect(screen.queryByTestId("pr-list")).toBeNull();
    expect(screen.queryByTestId("pr-back-to-list")).toBeNull();
    expect(loadPullRequests).not.toHaveBeenCalled();

    rerender(<PullRequestView detail={null} loadPullRequests={loadPullRequests} />);
    expect(screen.getByTestId("pr-view-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-list")).toBeNull();
    expect(screen.queryByTestId("pr-back-to-list")).toBeNull();
    expect(loadPullRequests).not.toHaveBeenCalled();

    const loadPullRequest = vi.fn(async () => makeDetail({ id: "PR-9", repo: "owner/explicit" }));
    rerender(<PullRequestView pullRequestId="PR-9" loadPullRequest={loadPullRequest} loadPullRequests={loadPullRequests} />);

    await waitFor(() => expect(loadPullRequest).toHaveBeenCalledWith("PR-9"));
    expect(await screen.findByText("owner/explicit")).toBeTruthy();
    expect(screen.queryByTestId("pr-list")).toBeNull();
    expect(screen.queryByTestId("pr-back-to-list")).toBeNull();
    expect(loadPullRequests).not.toHaveBeenCalled();
  });

  it("enters list mode when a host forwards an undefined detail prop", async () => {
    const loadPullRequests = vi.fn(async () => makeList());
    render(<PullRequestView detail={undefined} loadPullRequests={loadPullRequests} />);

    expect(await screen.findByTestId("pr-list")).toBeTruthy();
    expect(screen.getAllByTestId("pr-list-item")).toHaveLength(2);
    expect(screen.queryByTestId("pr-view-empty")).toBeNull();
    expect(loadPullRequests).toHaveBeenCalledTimes(1);
  });

  it("refreshes the list on fusion store-changed events", async () => {
    const loadPullRequests = vi
      .fn<() => Promise<PrDetail[]>>()
      .mockResolvedValueOnce([makeDetail({ id: "PR-1", repo: "owner/first", prNumber: 1 })])
      .mockResolvedValueOnce([makeDetail({ id: "PR-2", repo: "owner/second", prNumber: 2 })]);
    render(<PullRequestView loadPullRequests={loadPullRequests} />);

    expect(await screen.findByText("owner/first")).toBeTruthy();
    window.dispatchEvent(new Event("fusion:store-changed"));

    await waitFor(() => expect(loadPullRequests).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("owner/second")).toBeTruthy();
    expect(screen.queryByText("owner/first")).toBeNull();
  });
});

describe("PullRequestView per-node-state rendering", () => {
  it("creating → 'Creating PR…' placeholder", () => {
    render(<PullRequestView detail={makeDetail({ state: "creating" })} />);
    expect(screen.getByTestId("pr-view").dataset.state).toBe("creating");
    expect(screen.getByTestId("pr-creating").textContent).toContain("Creating PR");
  });

  it("failed → failure reason + Retry PR creation action", async () => {
    const onAction = vi.fn(async () => makeDetail({ state: "creating" }));
    render(
      <PullRequestView
        detail={makeDetail({ state: "failed", failureReason: "gh auth missing" })}
        onAction={onAction}
      />,
    );
    expect(screen.getByTestId("pr-failed").textContent).toContain("gh auth missing");
    fireEvent.click(screen.getByTestId("pr-retry-create"));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("retry-create", "PR-1", undefined));
  });

  it("unverified → 'Verifying with GitHub…', checks/threads hidden, merge disabled", () => {
    render(
      <PullRequestView
        detail={makeDetail({ unverified: true, threads: [
          { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "pending", updatedAt: 0 },
        ] })}
      />,
    );
    expect(screen.getByTestId("pr-unverified").textContent).toContain("Verifying with GitHub");
    expect(screen.queryByTestId("pr-threads")).toBeNull();
    expect(screen.queryByTestId("pr-summary")).toBeNull();
    expect((screen.getByTestId("pr-merge") as HTMLButtonElement).disabled).toBe(true);
  });

  it("responding → banner with N pending threads, respond/retry disabled, per-thread pending markers", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          state: "responding",
          summary: makeSummary({ pendingThreads: 3 }),
          threads: [
            { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "pending", updatedAt: 0 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("pr-responding").textContent).toContain("3 threads pending");
    expect((screen.getByTestId("pr-retry") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("pr-thread-pending")).toBeTruthy();
  });

  it("open/await-review → action bar (Approve/Retry/Merge/Close) + auto-merge gate reason", () => {
    render(<PullRequestView detail={makeDetail({ summary: makeSummary({ autoMergeReason: "Waiting for approval" }) })} />);
    expect(screen.getByTestId("pr-action-bar")).toBeTruthy();
    expect(screen.getByTestId("pr-approve")).toBeTruthy();
    expect(screen.getByTestId("pr-retry")).toBeTruthy();
    expect(screen.getByTestId("pr-merge")).toBeTruthy();
    expect(screen.getByTestId("pr-close")).toBeTruthy();
    expect(screen.getByTestId("pr-automerge-gate").textContent).toBe("Waiting for approval");
  });

  it("conflict → Merge disabled + 'Resolve conflicts on GitHub' link", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          mergeable: "conflicting",
          summary: makeSummary({ conflicting: true, autoMergeReason: "Blocked: conflict" }),
        })}
      />,
    );
    expect((screen.getByTestId("pr-merge") as HTMLButtonElement).disabled).toBe(true);
    const link = screen.getByTestId("pr-conflict-link") as HTMLAnchorElement;
    expect(link.textContent).toContain("Resolve conflicts on GitHub");
    expect(link.href).toContain("/pr/42");
  });

  it("agent disagreements are visually distinguished from human-awaiting threads", () => {
    render(
      <PullRequestView
        detail={makeDetail({
          threads: [
            { prEntityId: "PR-1", threadId: "T1", headOid: "a", outcome: "disagreed", updatedAt: 0 },
            { prEntityId: "PR-1", threadId: "T2", headOid: "a", outcome: "pending", updatedAt: 0 },
          ],
        })}
      />,
    );
    const disagreed = screen.getByTestId("pr-thread-disagreed");
    expect(disagreed.dataset.agentDisagreement).toBe("true");
    expect(disagreed.className).toContain("pr-thread--agent-disagreement");
    const pending = screen.getByTestId("pr-thread-pending");
    expect(pending.dataset.agentDisagreement).toBe("false");
  });

  it("merge uses a single confirm step, then fires the merge action", async () => {
    const onAction = vi.fn(async () => makeDetail());
    render(<PullRequestView detail={makeDetail()} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("pr-merge"));
    // Single-confirm: a confirm control appears (no heavy modal).
    const confirm = await screen.findByTestId("pr-merge-confirm");
    fireEvent.click(confirm);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("merge", "PR-1", undefined));
  });

  it("auto-merge toggle dispatches the automerge action with enabled flag", async () => {
    const onAction = vi.fn(async () => makeDetail({ autoMerge: true }));
    render(<PullRequestView detail={makeDetail({ autoMerge: false })} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("pr-automerge").querySelector("input")!);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("automerge", "PR-1", { enabled: true }));
  });
});

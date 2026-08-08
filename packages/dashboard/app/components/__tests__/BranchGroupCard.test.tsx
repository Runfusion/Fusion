import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BranchGroupCard } from "../BranchGroupCard";
import { ApiRequestError } from "../../api";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";

const apiGetBranchGroup = vi.fn();
const apiPromoteBranchGroup = vi.fn();
const apiAbandonBranchGroup = vi.fn();
const apiAssignTaskBranchGroup = vi.fn();

type SseSubscription = {
  url: string;
  options: {
    events?: Record<string, (event: MessageEvent) => void>;
    onReconnect?: () => void;
  };
};

const sseSubscriptions: SseSubscription[] = [];

vi.mock("../../api", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiGetBranchGroup: (...args: unknown[]) => apiGetBranchGroup(...args),
  apiPromoteBranchGroup: (...args: unknown[]) => apiPromoteBranchGroup(...args),
  apiAbandonBranchGroup: (...args: unknown[]) => apiAbandonBranchGroup(...args),
  apiAssignTaskBranchGroup: (...args: unknown[]) => apiAssignTaskBranchGroup(...args),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (url: string, options: SseSubscription["options"]) => {
    sseSubscriptions.push({ url, options });
    return () => {};
  },
}));

vi.mock("lucide-react", () => ({
  CheckCircle2: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  CircleDashed: () => null,
  ExternalLink: () => null,
  GitBranch: () => null,
  GitPullRequest: () => null,
  Loader2: () => null,
}));

async function expandBranchGroup() {
  const toggle = await screen.findByRole("button", { name: /expand branch group/i });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: /collapse branch group/i })).toHaveAttribute("aria-expanded", "true");
}

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: "BG-1",
    sourceType: "planning",
    sourceId: "PS-1",
    branchName: "feature/shared",
    autoMerge: false,
    prState: "none",
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [
      { taskId: "FN-1", title: "one", column: "done", landed: true },
      { taskId: "FN-2", title: "two", column: "in-review", landed: false },
    ],
    completion: { landed: 1, total: 2, complete: false },
    ...overrides,
  };
}

describe("BranchGroupCard", () => {
  beforeEach(() => {
    apiGetBranchGroup.mockReset();
    apiPromoteBranchGroup.mockReset();
    apiAbandonBranchGroup.mockReset();
    apiAssignTaskBranchGroup.mockReset();
    sseSubscriptions.length = 0;
  });

  it("requires advisory confirmation before sending one promotion request", async () => {
    apiGetBranchGroup.mockResolvedValue({ group: makeGroup({
      completion: { landed: 2, total: 2, complete: true },
      members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }],
      advisories: [{
        taskId: "FN-1",
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed",
        verdict: "APPROVE_WITH_NOTES",
        notes: "Check error path.",
        findings: [{ id: "finding-1", title: "Handle empty response", body: "Guard the API response before reading its payload.", filePath: "src/client.ts", line: 42 }],
      }],
    }) });
    apiPromoteBranchGroup.mockResolvedValue({});
    const onOpenReviewTask = vi.fn();
    render(<BranchGroupCard groupId="BG-1" onOpenReviewTask={onOpenReviewTask} />);
    await expandBranchGroup();
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(onOpenReviewTask).toHaveBeenCalledWith("FN-1");
    fireEvent.click(screen.getByRole("button", { name: /open pr/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm group promotion/i });
    expect(dialog).toHaveTextContent("Check error path.");
    expect(dialog).toHaveTextContent("APPROVE_WITH_NOTES");
    expect(dialog).toHaveTextContent("Handle empty response");
    expect(dialog).toHaveTextContent("Guard the API response before reading its payload.");
    expect(dialog).toHaveTextContent("src/client.ts:42");
    fireEvent.click(within(dialog).getByRole("button", { name: /review/i }));
    expect(onOpenReviewTask).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(apiPromoteBranchGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /open pr/i }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /confirm group promotion/i })).getByRole("button", { name: /open pr/i }));
    await waitFor(() => expect(apiPromoteBranchGroup).toHaveBeenCalledTimes(1));
  });

  it("hides promote control while incomplete", async () => {
    apiGetBranchGroup.mockResolvedValue({ group: makeGroup() });
    render(<BranchGroupCard groupId="BG-1" />);
    await screen.findByText("1 of 2 members finished");
    await expandBranchGroup();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main/i })).toBeNull();
  });

  it("FN-7438: guides users to reset a stale branch group reference and clears only this task", async () => {
    apiGetBranchGroup.mockRejectedValue(new ApiRequestError("Branch group not found", 404));
    apiAssignTaskBranchGroup.mockResolvedValue({ taskId: "FN-1", groupId: null });
    const onBranchGroupReset = vi.fn();

    render(<BranchGroupCard groupId="BG-missing" taskId="FN-1" projectId="proj-a" onBranchGroupReset={onBranchGroupReset} />);

    expect(await screen.findByText("Stale branch group reference")).toBeInTheDocument();
    expect(screen.getByText(/Reset only this task's branch group/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand branch group/i })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    const reset = screen.getByRole("button", { name: /reset branch group for this task/i });
    fireEvent.click(reset);

    await waitFor(() => {
      expect(apiAssignTaskBranchGroup).toHaveBeenCalledWith({ taskId: "FN-1", groupId: null }, "proj-a");
      expect(onBranchGroupReset).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps transient branch-group load failures separate from stale-reference reset UI", async () => {
    apiGetBranchGroup.mockRejectedValue(new Error("network down"));

    render(<BranchGroupCard groupId="BG-1" taskId="FN-1" />);

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset branch group for this task/i })).toBeNull();
  });

  it("shows promote and calls API when complete + autoMerge off", async () => {
    apiGetBranchGroup
      .mockResolvedValueOnce({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }, { taskId: "FN-2", title: "two", column: "done", landed: true }] }) })
      .mockResolvedValueOnce({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }, { taskId: "FN-2", title: "two", column: "done", landed: true }], prState: "open", prNumber: 22, prUrl: "https://example/pr/22" }) });
    apiPromoteBranchGroup.mockResolvedValue({ groupId: "BG-1", prState: "open" });

    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    const button = await screen.findByRole("button", { name: /open pr/i });
    fireEvent.click(button);
    fireEvent.click(within(await screen.findByRole("dialog", { name: /confirm group promotion/i })).getByRole("button", { name: /open pr/i }));

    await waitFor(() => {
      expect(apiPromoteBranchGroup).toHaveBeenCalledWith("BG-1", undefined);
    });
  });

  it("shows auto-merge badge when complete and autoMerge is on", async () => {
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({
        autoMerge: true,
        completion: { landed: 2, total: 2, complete: true },
        members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }, { taskId: "FN-2", title: "two", column: "done", landed: true }],
      }),
    });

    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    expect(await screen.findByText("Auto-merge enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main/i })).toBeNull();
  });

  it("renders tracked group PR link when present", async () => {
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }, { taskId: "FN-2", title: "two", column: "done", landed: true }], prState: "open", prNumber: 9, prUrl: "https://example/pr/9" }),
    });
    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    expect(await screen.findByRole("link", { name: /pr #9/i })).toBeInTheDocument();
  });

  const completeMembers = [
    { taskId: "FN-1", title: "one", column: "done", landed: true },
    { taskId: "FN-2", title: "two", column: "done", landed: true },
  ];

  it("shows Abandon control while group PR is open", async () => {
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers, prState: "open", prNumber: 11, prUrl: "https://example/pr/11" }),
    });
    apiAbandonBranchGroup.mockResolvedValue({ groupId: "BG-1", group: makeGroup({ status: "abandoned", prState: "closed" }) });

    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    const abandon = await screen.findByRole("button", { name: /abandon group/i });
    fireEvent.click(abandon);

    await waitFor(() => {
      expect(apiAbandonBranchGroup).toHaveBeenCalledWith("BG-1", undefined);
    });
  });

  it("keeps Abandon reachable but hides promote when completion reverts while PR is open", async () => {
    // Regression: a member moving back (in-progress → todo) flips completion to
    // false. The card must still let the user abandon (and close) the open PR,
    // while the promote control stays gated on completion.
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({
        completion: { landed: 1, total: 2, complete: false },
        members: [
          { taskId: "FN-1", title: "one", column: "done", landed: true },
          { taskId: "FN-2", title: "two", column: "in-progress", landed: false },
        ],
        prState: "open",
        prNumber: 14,
        prUrl: "https://example/pr/14",
      }),
    });

    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    expect(await screen.findByRole("button", { name: /abandon group/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main/i })).toBeNull();
  });

  it("shows terminal merged state and hides promote/abandon", async () => {
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers, prState: "merged", prNumber: 5, prUrl: "https://example/pr/5" }),
    });
    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    expect(await screen.findByText("Group PR merged")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main|abandon group/i })).toBeNull();
  });

  it("shows terminal closed state", async () => {
    apiGetBranchGroup.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers, prState: "closed", prNumber: 6, prUrl: "https://example/pr/6" }),
    });
    render(<BranchGroupCard groupId="BG-1" />);
    await expandBranchGroup();
    expect(await screen.findByText("Group PR closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main|abandon group/i })).toBeNull();
  });

  it("starts populated groups collapsed and expands via toggle", async () => {
    apiGetBranchGroup.mockResolvedValue({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }) });
    render(<BranchGroupCard groupId="BG-1" />);

    expect(await screen.findByText("2 of 2 members finished")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /expand branch group/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("FN-1 · one")).toBeNull();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main|abandon group/i })).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /collapse branch group/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("FN-1 · one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open pr/i })).toBeInTheDocument();
  });


  it("refetches on task:moved and updates completion, progress, member landed state, and completion-gated actions", async () => {
    apiGetBranchGroup
      .mockResolvedValueOnce({ group: makeGroup() })
      .mockResolvedValueOnce({
        group: makeGroup({
          completion: { landed: 2, total: 2, complete: true },
          members: [
            { taskId: "FN-1", title: "one", column: "done", landed: true },
            { taskId: "FN-2", title: "two", column: "done", landed: true },
          ],
        }),
      });

    render(<BranchGroupCard groupId="BG-1" />);
    await screen.findByText("1 of 2 members finished");
    await expandBranchGroup();

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.queryByRole("button", { name: /open pr/i })).toBeNull();

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:moved"]?.(new MessageEvent("task:moved", { data: JSON.stringify({ task: { id: "FN-2" } }) }));
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "2");
    expect(screen.getByText("FN-2 · two").closest("li")?.querySelector(".status-dot")).toHaveClass("status-dot--online");
    expect(screen.getByRole("button", { name: /open pr/i })).toBeInTheDocument();
  });

  it("refetches on membership lifecycle events and updates member rows without remounting", async () => {
    apiGetBranchGroup
      .mockResolvedValueOnce({ group: makeGroup() })
      .mockResolvedValueOnce({
        group: makeGroup({
          completion: { landed: 1, total: 1, complete: true },
          members: [{ taskId: "FN-1", title: "one", column: "done", landed: true }],
        }),
      });

    render(<BranchGroupCard groupId="BG-1" projectId="proj-a" />);
    await screen.findByText("1 of 2 members finished");
    await expandBranchGroup();
    expect(screen.getByText("FN-2 · two")).toBeInTheDocument();

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:deleted"]?.(new MessageEvent("task:deleted", { data: JSON.stringify({ id: "FN-2", projectId: "proj-a" }) }));
    });

    expect(await screen.findByText("1 of 1 members finished")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "1");
    expect(screen.queryByText("FN-2 · two")).toBeNull();
  });

  it("ignores task lifecycle events for another project when payloads include a project id", async () => {
    apiGetBranchGroup.mockResolvedValue({ group: makeGroup() });

    render(<BranchGroupCard groupId="BG-1" projectId="proj-a" />);
    await screen.findByText("1 of 2 members finished");

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:updated"]?.(new MessageEvent("task:updated", { data: JSON.stringify({ id: "FN-2", projectId: "proj-b" }) }));
    });

    expect(apiGetBranchGroup).toHaveBeenCalledTimes(1);
  });

  it("refetches on reconnect", async () => {
    apiGetBranchGroup
      .mockResolvedValueOnce({ group: makeGroup() })
      .mockResolvedValueOnce({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }) });

    render(<BranchGroupCard groupId="BG-1" />);
    await screen.findByText("1 of 2 members finished");

    await act(async () => {
      sseSubscriptions.at(-1)?.options.onReconnect?.();
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeInTheDocument();
  });

  it("preserves user expansion state across live refreshes", async () => {
    apiGetBranchGroup
      .mockResolvedValueOnce({ group: makeGroup() })
      .mockResolvedValueOnce({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }) })
      .mockResolvedValueOnce({ group: makeGroup() })
      .mockResolvedValueOnce({ group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }) });

    const { unmount } = render(<BranchGroupCard groupId="BG-1" />);
    await screen.findByText("1 of 2 members finished");
    await expandBranchGroup();

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:updated"]?.(new MessageEvent("task:updated", { data: "{}" }));
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /collapse branch group/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("FN-1 · one")).toBeInTheDocument();

    unmount();
    sseSubscriptions.length = 0;

    render(<BranchGroupCard groupId="BG-1" />);
    await screen.findByText("1 of 2 members finished");
    expect(screen.getByRole("button", { name: /expand branch group/i })).toHaveAttribute("aria-expanded", "false");

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:moved"]?.(new MessageEvent("task:moved", { data: "{}" }));
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand branch group/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("FN-1 · one")).toBeNull();
  });

  it("keeps collapsed branch-group styling tokenized and compact", () => {
    const css = loadAllAppCssBaseOnly();
    const collapsedBlock = css.match(/\.branch-group-card--collapsed\s*\{(?<block>[^}]*)\}/)?.groups?.block ?? "";
    expect(collapsedBlock).toContain("gap: calc(var(--space-xs) / 2)");
    expect(collapsedBlock).toContain("padding: var(--space-sm)");
    expect(collapsedBlock).not.toMatch(/\d+px|#[0-9a-f]{3,8}|rgba?\(/i);

    const titleBlock = css.match(/\.branch-group-card--collapsed \.branch-group-card-title\s*\{(?<block>[^}]*)\}/)?.groups?.block ?? "";
    expect(titleBlock).toContain("font-size: var(--font-size-xs)");
    expect(titleBlock).toContain("line-height: var(--line-height-tight)");

    const confirmationBlock = css.match(/\.branch-group-card-confirm\s*\{(?<block>[^}]*)\}/)?.groups?.block ?? "";
    expect(confirmationBlock).toContain("max-block-size: calc(100dvh - var(--space-lg))");
    const advisoryListBlock = css.match(/\.branch-group-card-advisories\s*\{(?<block>[^}]*)\}/)?.groups?.block ?? "";
    expect(advisoryListBlock).toContain("overflow-y: auto");
  });
});

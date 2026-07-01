import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupTaskModal } from "../GroupTaskModal";
import { apiGetBranchGroup, apiPromoteBranchGroup, apiAbandonBranchGroup } from "../../api";

type SseSubscription = {
  url: string;
  options: {
    events?: Record<string, (event: MessageEvent) => void>;
    onReconnect?: () => void;
  };
};

const sseSubscriptions: SseSubscription[] = [];

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    apiGetBranchGroup: vi.fn(),
    apiPromoteBranchGroup: vi.fn(),
    apiAbandonBranchGroup: vi.fn(),
  };
});

vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistory: () => ({ canGoBack: false, goBack: vi.fn() }),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (url: string, options: SseSubscription["options"]) => {
    sseSubscriptions.push({ url, options });
    return () => {};
  },
}));

const mockedGet = vi.mocked(apiGetBranchGroup);
const mockedPromote = vi.mocked(apiPromoteBranchGroup);
const mockedAbandon = vi.mocked(apiAbandonBranchGroup);

const completeMembers = [
  { taskId: "FN-1", title: "First", column: "done", landed: true },
  { taskId: "FN-2", title: "Second", column: "done", landed: true },
];

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: "BG-1",
    branchName: "feature/shared",
    status: "open",
    autoMerge: false,
    prState: "none",
    prUrl: null,
    prNumber: null,
    completion: { landed: 1, total: 2, complete: false },
    members: [
      { taskId: "FN-1", title: "First", column: "done", landed: true },
      { taskId: "FN-2", title: "Second", column: "todo", landed: false },
    ],
    ...overrides,
  };
}

describe("GroupTaskModal", () => {
  beforeEach(() => {
    mockedPromote.mockReset();
    mockedGet.mockReset();
    mockedAbandon.mockReset();
    sseSubscriptions.length = 0;
  });

  it("renders group summary and member open action", async () => {
    mockedGet.mockResolvedValue({ group: makeGroup() } as Awaited<ReturnType<typeof apiGetBranchGroup>>);
    const onOpenMemberTask = vi.fn();

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={onOpenMemberTask} />);

    expect(await screen.findByText("feature/shared")).toBeDefined();
    expect(screen.getByText("1 of 2 members finished")).toBeDefined();
    await userEvent.click(screen.getAllByRole("button", { name: "Open task" })[0]);
    expect(onOpenMemberTask).toHaveBeenCalledWith("FN-1");
  });

  it("hides promote controls until complete", async () => {
    mockedGet.mockResolvedValue({ group: makeGroup() } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    await screen.findByText("1 of 2 members finished");
    expect(screen.queryByRole("button", { name: /open pr|merge group into main/i })).toBeNull();
  });

  it("promotes when complete and auto-merge is off", async () => {
    mockedGet
      .mockResolvedValueOnce({
        group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: [
          { taskId: "FN-1", title: "First", column: "done", landed: true },
          { taskId: "FN-2", title: "Second", column: "done", landed: true },
        ] }),
      } as Awaited<ReturnType<typeof apiGetBranchGroup>>)
      .mockResolvedValueOnce({
        group: makeGroup({ completion: { landed: 2, total: 2, complete: true } }),
      } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    mockedPromote.mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof apiPromoteBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    const action = await screen.findByRole("button", { name: /open pr/i });
    await userEvent.click(action);
    await waitFor(() => expect(mockedPromote).toHaveBeenCalledWith("BG-1", undefined));
  });

  it("renders tracked pr info when present", async () => {
    mockedGet.mockResolvedValue({
      group: makeGroup({
        completion: { landed: 2, total: 2, complete: true },
        prState: "open",
        prUrl: "https://github.com/org/repo/pull/1",
        prNumber: 1,
      }),
    } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    const link = await screen.findByRole("link", { name: /PR #1/i });
    expect(link.getAttribute("href")).toContain("/pull/1");
    expect(link.textContent).toContain("open");
  });

  it("abandons an open group PR", async () => {
    mockedGet.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers, prState: "open", prNumber: 2, prUrl: "https://github.com/org/repo/pull/2" }),
    } as Awaited<ReturnType<typeof apiGetBranchGroup>>);
    mockedAbandon.mockResolvedValue({ groupId: "BG-1", group: makeGroup({ status: "abandoned", prState: "closed" }) } as Awaited<ReturnType<typeof apiAbandonBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    const action = await screen.findByRole("button", { name: /abandon group/i });
    await userEvent.click(action);
    await waitFor(() => expect(mockedAbandon).toHaveBeenCalledWith("BG-1", undefined));
  });

  it("keeps Abandon reachable but hides promote when completion reverts while PR is open", async () => {
    // Regression: completion can flip back to false (a member moves
    // in-progress → todo) while the group PR is still open. Abandon must remain
    // available so the user can close the PR; promote stays gated on completion.
    mockedGet.mockResolvedValue({
      group: makeGroup({
        completion: { landed: 1, total: 2, complete: false },
        members: [
          { taskId: "FN-1", title: "First", column: "done", landed: true },
          { taskId: "FN-2", title: "Second", column: "in-progress", landed: false },
        ],
        prState: "open",
        prNumber: 4,
        prUrl: "https://github.com/org/repo/pull/4",
      }),
    } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /abandon group/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main/i })).toBeNull();
  });


  it("refetches on task:moved and updates completion-gated actions in place", async () => {
    mockedGet
      .mockResolvedValueOnce({ group: makeGroup() } as Awaited<ReturnType<typeof apiGetBranchGroup>>)
      .mockResolvedValueOnce({
        group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }),
      } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);
    await screen.findByText("1 of 2 members finished");
    expect(screen.queryByRole("button", { name: /open pr/i })).toBeNull();

    await act(async () => {
      sseSubscriptions.at(-1)?.options.events?.["task:moved"]?.(new MessageEvent("task:moved", { data: JSON.stringify({ task: { id: "FN-2" } }) }));
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeDefined();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("button", { name: /open pr/i })).toBeDefined();
  });

  it("refetches the open group modal on reconnect", async () => {
    mockedGet
      .mockResolvedValueOnce({ group: makeGroup() } as Awaited<ReturnType<typeof apiGetBranchGroup>>)
      .mockResolvedValueOnce({
        group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers }),
      } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);
    await screen.findByText("1 of 2 members finished");

    await act(async () => {
      sseSubscriptions.at(-1)?.options.onReconnect?.();
    });

    expect(await screen.findByText("2 of 2 members finished")).toBeDefined();
  });

  it("shows terminal state and hides controls when merged", async () => {
    mockedGet.mockResolvedValue({
      group: makeGroup({ completion: { landed: 2, total: 2, complete: true }, members: completeMembers, prState: "merged", prNumber: 3, prUrl: "https://github.com/org/repo/pull/3" }),
    } as Awaited<ReturnType<typeof apiGetBranchGroup>>);

    render(<GroupTaskModal isOpen onClose={vi.fn()} groupId="BG-1" onOpenMemberTask={vi.fn()} />);

    expect(await screen.findByText("Group PR merged")).toBeDefined();
    expect(screen.queryByRole("button", { name: /open pr|merge group into main|abandon group/i })).toBeNull();
  });
});

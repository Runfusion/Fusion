import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { CreateRoomModal, validateRoomName } from "../CreateRoomModal";
import { FloatingWindow } from "../FloatingWindow";
import { assertModalGeometryRecoveryAndSheetContracts, assertRenderedModalTouchGeometry, expectFloatingWindowStructure } from "./floatingWindowMigration.test-helpers";
import * as apiModule from "../../api";

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const agents = [
  { id: "agent-1", name: "Alpha", role: "executor", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
  { id: "agent-2", name: "Beta", role: "reviewer", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
] as any;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("validateRoomName", () => {
  it.each([
    ["engineering", true],
    ["#engineering", true],
    ["team-1", true],
    ["a", true],
    ["Engineering", false],
    ["team room", false],
    ["-team", false],
    ["team-", false],
    ["_team", false],
    ["team_", false],
    ["", false],
    ["team😀", false],
    ["a".repeat(81), false],
  ])("validates %s", (value, expectedOk) => {
    expect(validateRoomName(value).ok).toBe(expectedOk);
  });

  it("handles duplicate names case-insensitively", () => {
    expect(validateRoomName("Engineering", ["engineering"]).ok).toBe(false);
  });
});

describe("CreateRoomModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchAgents.mockResolvedValue(agents);
  });

  it("renders nothing when closed", () => {
    const { container } = render(<CreateRoomModal isOpen={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("requires valid name and member before submit", async () => {
    render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    const submit = await screen.findByRole("button", { name: "Create room" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Room name"), "engineering");
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));
    expect(submit).toBeEnabled();
  });

  it("submits selected draft payload", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={onCreate} />);

    await userEvent.type(screen.getByLabelText("Room name"), "engineering");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create room" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({ name: "engineering", displayName: "#engineering", memberAgentIds: ["agent-1"] });
  });

  it("claims a fresh top layer above floating Chat on open and reopen", async () => {
    const { rerender } = render(
      <>
        <FloatingWindow windowKey="chat-modal" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>floating chat representative</div>
        </FloatingWindow>
        <CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );

    const chatPanel = screen.getByTestId("floating-window-chat-modal");
    const firstOverlay = screen.getByTestId("floating-window-overlay-create-room");
    expect(Number(firstOverlay.style.zIndex)).toBeGreaterThan(Number(chatPanel.style.zIndex));
    await screen.findByRole("button", { name: /Alpha/i });

    // Another Chat interaction can claim its peer stack while the dialog is closed.
    rerender(
      <>
        <FloatingWindow windowKey="chat-modal" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>floating chat representative</div>
        </FloatingWindow>
        <CreateRoomModal isOpen={false} onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );
    fireEvent.pointerDown(chatPanel);

    rerender(
      <>
        <FloatingWindow windowKey="chat-modal" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>floating chat representative</div>
        </FloatingWindow>
        <CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );

    const reopenedOverlay = screen.getByTestId("floating-window-overlay-create-room");
    expect(Number(reopenedOverlay.style.zIndex)).toBeGreaterThan(Number(chatPanel.style.zIndex));
    expect(Number(reopenedOverlay.style.zIndex)).toBeGreaterThan(Number(firstOverlay.style.zIndex));
  });

  it("stays above floating Chat while agent data is loading or empty", async () => {
    mockFetchAgents.mockImplementation(() => new Promise(() => {}));
    const loading = render(
      <>
        <FloatingWindow windowKey="chat-loading" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>floating chat representative</div>
        </FloatingWindow>
        <CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );

    const loadingOverlay = screen.getByTestId("floating-window-overlay-create-room");
    expect(screen.getByRole("status")).toHaveTextContent("Loading agents...");
    expect(Number(loadingOverlay.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("floating-window-chat-loading").style.zIndex));
    loading.unmount();

    mockFetchAgents.mockResolvedValueOnce([]);
    render(
      <>
        <FloatingWindow windowKey="chat-empty" title="Chat" onClose={() => {}} layer="task-detail" className="floating-window--chat">
          <div>floating chat representative</div>
        </FloatingWindow>
        <CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );

    const emptyOverlay = screen.getByTestId("floating-window-overlay-create-room");
    expect(await screen.findByText("No agents in this project yet.")).toBeInTheDocument();
    expect(Number(emptyOverlay.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("floating-window-chat-empty").style.zIndex));
  });

  it("closes on escape and overlay click", async () => {
    const onClose = vi.fn();
    render(<CreateRoomModal isOpen onClose={onClose} onCreate={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByTestId("floating-window-overlay-create-room"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("hosts the dialog in FloatingWindow with persisted touch geometry and sheet recovery", () => {
    const { baseElement } = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    const panel = expectFloatingWindowStructure("create-room");
    const dialog = within(baseElement).getByRole("dialog", { name: "Create room" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    assertRenderedModalTouchGeometry("create-room", panel.querySelector(".modal-header") as HTMLElement);
    assertModalGeometryRecoveryAndSheetContracts("create-room", () => render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />));
  });

  it("focuses the room name, restores prior focus, and keeps the member list as the scroll owner", async () => {
    const onClose = vi.fn();
    const { rerender, baseElement } = render(
      <>
        <button type="button">Room launcher</button>
        <CreateRoomModal isOpen={false} onClose={onClose} onCreate={vi.fn()} />
      </>,
    );
    const launcher = screen.getByRole("button", { name: "Room launcher" });
    launcher.focus();
    rerender(<><button type="button">Room launcher</button><CreateRoomModal isOpen onClose={onClose} onCreate={vi.fn()} /></>);
    const nameInput = await within(baseElement).findByLabelText("Room name");
    await waitFor(() => expect(nameInput).toHaveFocus());
    const memberList = within(baseElement).getByTestId("create-room-member-list");
    expect(memberList).toHaveClass("create-room-modal-member-list");
    expect(getComputedStyle(memberList).overflowY).toBe("auto");
    rerender(<><button type="button">Room launcher</button><CreateRoomModal isOpen={false} onClose={onClose} onCreate={vi.fn()} /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Room launcher" })).toHaveFocus());
  });

  it("does not let deferred autofocus steal member-search keystrokes", async () => {
    let capturedFrameCallback: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      capturedFrameCallback = callback;
      return 1;
    });

    try {
      render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
      await screen.findByRole("button", { name: /Alpha/i });

      await userEvent.click(screen.getByLabelText("Members"));
      const searchInput = screen.getByLabelText("Members");
      expect(searchInput).toHaveFocus();
      expect(capturedFrameCallback).toBeDefined();
      act(() => { capturedFrameCallback?.(0); });
      await userEvent.keyboard("zzz");

      expect(searchInput).toHaveValue("zzz");
      expect(screen.getByLabelText("Room name")).toHaveValue("");
      expect(screen.getByText("No agents match your search.")).toBeInTheDocument();
    } finally {
      requestAnimationFrame.mockRestore();
    }
  });

  it.each(["desktop", "mobile"])("shows loading, empty, no-match, populated, and selected-member picker states on %s", async (viewport) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport === "mobile" ? 375 : 1280 });
    const loading = createDeferred<any[]>();
    const empty = createDeferred<any[]>();
    const populated = createDeferred<any[]>();
    mockFetchAgents
      .mockImplementationOnce(() => loading.promise)
      .mockImplementationOnce(() => empty.promise)
      .mockImplementationOnce(() => populated.promise);
    const { rerender } = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading agents...");
    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
    await act(async () => { loading.resolve(agents); });
    expect(await screen.findByRole("button", { name: /Alpha/i })).toBeInTheDocument();

    rerender(<CreateRoomModal isOpen={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    rerender(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledTimes(2));
    await act(async () => { empty.resolve([]); });
    expect(screen.getByText("No agents in this project yet.")).toBeInTheDocument();
    expect(screen.queryByText("No agents match your search.")).not.toBeInTheDocument();

    rerender(<CreateRoomModal isOpen={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    rerender(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledTimes(3));
    await act(async () => { populated.resolve(agents); });
    expect(await screen.findByRole("button", { name: /Alpha/i })).toBeInTheDocument();
    const memberSearch = screen.getByLabelText("Members");
    await userEvent.type(memberSearch, "zzz");
    expect(screen.getByText("No agents match your search.")).toBeInTheDocument();
    expect(screen.queryByText("No agents in this project yet.")).not.toBeInTheDocument();
    await userEvent.clear(memberSearch);
    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));
    expect(screen.getByTestId("create-room-selected-chips")).toHaveTextContent("Alpha");
    expect(mockFetchAgents).toHaveBeenCalledTimes(3);
  });

  it("ignores a superseded close/reopen and project-change load on the persistently mounted modal", async () => {
    const projectA = createDeferred<any[]>();
    const projectB = createDeferred<any[]>();
    mockFetchAgents.mockImplementationOnce(() => projectA.promise).mockImplementationOnce(() => projectB.promise);
    const { rerender } = render(<CreateRoomModal isOpen projectId="project-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    rerender(<CreateRoomModal isOpen={false} projectId="project-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    rerender(<CreateRoomModal isOpen projectId="project-b" onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledTimes(2));

    await act(async () => { projectB.resolve([agents[1]]); });
    expect(await screen.findByRole("button", { name: /Beta/i })).toBeInTheDocument();
    await act(async () => { projectA.resolve(agents); });
    expect(screen.queryByRole("button", { name: /Alpha/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta/i })).toBeInTheDocument();
    expect(mockFetchAgents.mock.calls.map(([, projectId]) => projectId)).toEqual(["project-a", "project-b"]);
  });

  it("drops selected ids missing from a current reload while retaining duplicate-name rows", async () => {
    const initial = createDeferred<any[]>();
    const reloaded = createDeferred<any[]>();
    const duplicateNameAgents = [agents[0], { ...agents[0], id: "agent-3" }];
    mockFetchAgents.mockImplementationOnce(() => initial.promise).mockImplementationOnce(() => reloaded.promise);
    const { rerender } = render(<CreateRoomModal isOpen projectId="project-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    await act(async () => { initial.resolve(duplicateNameAgents); });
    expect(await screen.findAllByRole("button", { name: /Alpha/i })).toHaveLength(2);
    await userEvent.click(screen.getAllByRole("button", { name: /Alpha/i })[0]);
    expect(screen.getByTestId("create-room-selected-chips")).toHaveTextContent("Alpha");

    rerender(<CreateRoomModal isOpen projectId="project-b" onClose={vi.fn()} onCreate={vi.fn()} />);
    await act(async () => { reloaded.resolve([agents[1]]); });
    expect(screen.queryByTestId("create-room-selected-chips")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta/i })).toBeInTheDocument();
  });

  it("keeps a rejected load distinct from an empty roster and fences an unmounted load", async () => {
    const rejected = createDeferred<any[]>();
    mockFetchAgents.mockImplementationOnce(() => rejected.promise);
    const { unmount } = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    await act(async () => { rejected.reject(new Error("offline")); });
    expect(await screen.findByText("Failed to load agents.")).toBeInTheDocument();
    expect(screen.queryByText("No agents in this project yet.")).not.toBeInTheDocument();

    const unmounted = createDeferred<any[]>();
    mockFetchAgents.mockImplementationOnce(() => unmounted.promise);
    unmount();
    const second = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    second.unmount();
    await act(async () => { unmounted.resolve(agents); });
    expect(screen.queryByRole("dialog", { name: "Create room" })).not.toBeInTheDocument();
  });

  it("shows search-specific empty state copy", async () => {
    render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);

    await screen.findByRole("button", { name: /Alpha/i });
    await userEvent.type(screen.getByLabelText("Members"), "zzz");

    expect(screen.getByText("No agents match your search.")).toBeInTheDocument();
  });

  it("keeps open and shows error when create fails", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("boom"));
    render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={onCreate} />);

    await userEvent.type(screen.getByLabelText("Room name"), "engineering");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create room" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

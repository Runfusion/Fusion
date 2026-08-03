import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    mockFetchAgents.mockResolvedValue([
      { id: "agent-1", name: "Alpha", role: "executor", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
      { id: "agent-2", name: "Beta", role: "reviewer", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
    ] as any);
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

  it("shows loading, empty, no-match, populated, and selected-member picker states", async () => {
    mockFetchAgents.mockImplementationOnce(() => new Promise(() => {}));
    const loading = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading agents...");
    loading.unmount();

    mockFetchAgents.mockResolvedValueOnce([]);
    const empty = render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByText("No agents in this project yet.")).toBeInTheDocument();
    empty.unmount();

    // Re-pin the populated list after mockResolvedValueOnce([]) so the no-match path cannot race an empty load.
    mockFetchAgents.mockResolvedValue([
      { id: "agent-1", name: "Alpha", role: "executor", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
      { id: "agent-2", name: "Beta", role: "reviewer", state: "idle", metadata: {}, createdAt: "", updatedAt: "" },
    ] as any);
    render(<CreateRoomModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);
    await screen.findByRole("button", { name: /Alpha/i });
    await userEvent.type(screen.getByLabelText("Members"), "zzz");
    expect(screen.getByText("No agents match your search.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Members"));
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    expect(screen.getByTestId("create-room-selected-chips")).toHaveTextContent("Alpha");
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

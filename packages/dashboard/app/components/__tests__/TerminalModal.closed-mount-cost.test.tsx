/*
FNXC:Terminal 2026-07-26-19:05:
Half one of the App-unmounts-the-terminal invariant (App.tsx ~1927 renders TerminalModal only while
`modalManager.terminalOpen`). This file establishes the PREMISE that makes that conditional mount
load-bearing: a MOUNTED-but-closed TerminalModal is not free. `useTerminalSessions` and `useTerminal` are
called unconditionally at the top of the component, hundreds of lines above `if (!isOpen) return null`,
so `isOpen={false}` still bootstraps a PTY session, opens a WebSocket, and arms a 45s heartbeat interval.
A live socket plus a repeating timer on a backgrounded tab is a primary iOS Safari / Chrome Android
discard signal, and the discard is the white-splash reload.

This is asserted against the REAL component with the REAL hooks — only the network edges (HTTP api,
WebSocket) are faked — because a shallow `isOpen ? <div/> : null` stand-in cannot express the cost. The
companion assertion in App.test.tsx ("App must not mount TerminalModal while the terminal is closed")
depends on this cost being real; if this file ever fails because the hooks moved behind the early return,
that companion assertion has lost its point and both need revisiting together.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import * as useWorkspacesModule from "../../hooks/useWorkspaces";

const createTerminalSessionMock = vi.fn();
const listTerminalSessionsMock = vi.fn();

vi.mock("../../api", () => ({
  createTerminalSession: (...args: unknown[]) => createTerminalSessionMock(...args),
  killPtyTerminalSession: vi.fn().mockResolvedValue({ killed: true }),
  listTerminalSessions: (...args: unknown[]) => listTerminalSessionsMock(...args),
}));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn(function TerminalMock() { return {}; }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(function FitAddonMock() { return {}; }) }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn(function WebLinksMock() { return {}; }) }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn(function WebglMock() { return {}; }) }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/** The 45s cadence in useTerminal.ts. Duplicated because HEARTBEAT_INTERVAL is module-private. */
const HEARTBEAT_INTERVAL_MS = 45_000;

type FakeSocket = {
  url: string;
  readyState: number;
  sent: string[];
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
};

let sockets: FakeSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(public url: string) {
    sockets.push(this as unknown as FakeSocket);
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

let savedWebSocket: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  window.localStorage.clear();
  savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  createTerminalSessionMock.mockReset().mockResolvedValue({
    sessionId: "session-closed-cost",
    shell: "/bin/bash",
    cwd: "/project",
  });
  listTerminalSessionsMock.mockReset().mockResolvedValue([]);
  vi.mocked(useWorkspacesModule.useWorkspaces).mockReturnValue({
    projectName: "kb",
    workspaces: [],
    loading: false,
    error: null,
  } as never);
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  vi.clearAllTimers();
  vi.useRealTimers();
});

/**
 * Flush the bootstrap chain (session create -> tab state -> WebSocket connect effect).
 * Explicit timer advance rather than `waitFor`, which does not cooperate with fake timers here.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
  }
}

describe("a mounted-but-closed TerminalModal still runs its expensive machinery", () => {
  it("bootstraps a PTY session and opens a WebSocket even with isOpen={false}", async () => {
    const { container } = render(<TerminalModal isOpen={false} onClose={vi.fn()} projectId="proj-1" />);

    // Renders nothing — which is exactly why a shallow mock cannot tell this state from "not mounted".
    expect(container.firstChild).toBeNull();

    await settle();
    expect(
      createTerminalSessionMock,
      "TerminalModal no longer bootstraps a PTY session while closed. If the hooks moved behind the `if (!isOpen) return null` early return, the conditional mount in App.tsx is no longer load-bearing and App.test.tsx's companion assertion should be revisited rather than deleted.",
    ).toHaveBeenCalled();

    expect(
      sockets.length,
      "A closed-but-mounted TerminalModal opened no WebSocket. See the note above — this premise is what makes App's conditional mount matter.",
    ).toBeGreaterThan(0);
    expect(sockets[0].url).toContain("/api/terminal/ws");
  });

  it("arms a repeating heartbeat interval that keeps firing while closed", async () => {
    render(<TerminalModal isOpen={false} onClose={vi.fn()} projectId="proj-1" />);
    await settle();

    const socket = sockets[0];
    expect(socket, "no WebSocket to open").toBeDefined();
    await act(async () => {
      socket.onopen?.();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    });

    // Two pings with no user present and nothing rendered: background work on a hidden tab.
    expect(
      socket.sent.filter((frame) => frame.includes("ping")).length,
      "A closed-but-mounted TerminalModal armed no heartbeat. The 45s timer is half of what made an always-mounted terminal a tab-discard signal.",
    ).toBeGreaterThanOrEqual(2);
  });

  it("releases the socket when unmounted", async () => {
    const { unmount } = render(<TerminalModal isOpen={false} onClose={vi.fn()} projectId="proj-1" />);
    await settle();
    const socket = sockets[0];

    await act(async () => {
      unmount();
    });

    expect(
      socket.close,
      "Unmounting TerminalModal must close its PTY WebSocket; App relies on unmount to release it.",
    ).toHaveBeenCalled();
  });
});

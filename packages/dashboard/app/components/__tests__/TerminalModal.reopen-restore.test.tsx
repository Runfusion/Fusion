import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../api";
import * as useTerminalModule from "../../hooks/useTerminal";
import * as useWorkspacesModule from "../../hooks/useWorkspaces";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import { TerminalModal } from "../TerminalModal";

vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn(),
}));

vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: vi.fn(),
}));

vi.mock("../../hooks/useWorkspaces", () => ({
  useWorkspaces: vi.fn(),
}));

interface MockTerminalInstance {
  attachedSessionId: string | null;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  hasSelection: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
  cols: number;
  rows: number;
}

let latestTerminalSessionId: string | null = null;
const terminalInstances: MockTerminalInstance[] = [];
const dataSubscribers = new Set<(data: string) => void>();
const exitSubscribers = new Set<(code: number) => void>();
const connectSubscribers = new Set<(info: { shell: string; cwd: string }) => void>();
const scrollbackSubscribers = new Set<(data: string, reset: boolean) => void>();
const invalidSessionSubscribers = new Set<() => void>();

function createMockTerminal(): MockTerminalInstance {
  const terminal: MockTerminalInstance = {
    attachedSessionId: latestTerminalSessionId,
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    paste: vi.fn(),
    refresh: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    resize: vi.fn(),
    options: {
      fontSize: 14,
      fontFamily: "monospace",
      cursorStyle: "block",
      cursorBlink: true,
    },
    cols: 80,
    rows: 24,
  };
  terminalInstances.push(terminal);
  return terminal;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock() {
    return createMockTerminal();
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return {
      fit: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function WebglAddonMock() {
    return {
      onContextLoss: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockCreateTerminalSession = vi.mocked(apiModule.createTerminalSession);
const mockKillPtyTerminalSession = vi.mocked(apiModule.killPtyTerminalSession);
const mockListTerminalSessions = vi.mocked(apiModule.listTerminalSessions);
const mockUseTerminal = vi.mocked(useTerminalModule.useTerminal);
const mockUseWorkspaces = vi.mocked(useWorkspacesModule.useWorkspaces);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function storedTab(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `tab-${sessionId}`,
    sessionId,
    title: "bash",
    isActive: true,
    createdAt: 1,
    ...overrides,
  };
}

function serverSession(id: string, cwd = "/project") {
  return {
    id,
    shell: "/bin/bash",
    cwd,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
  };
}

function storageKey(projectId: string, scopeId?: string): string {
  const base = scopeId ? `kb-terminal-tabs:task:${scopeId}` : "kb-terminal-tabs";
  return `kb:${projectId}:${base}`;
}

function productionAppSourceFiles(): string[] {
  return [
    "App.tsx",
    ...listComponentFiles()
      .filter((path) => !path.split("/").some((segment) => segment === "__tests__" || segment === "__mocks__"))
      .map((path) => `components/${path}`),
  ].sort();
}

function seedTabs(projectId: string, tabs: unknown[], scopeId?: string): void {
  window.localStorage.setItem(storageKey(projectId, scopeId), JSON.stringify(tabs));
}

function subscribe<T>(set: Set<T>, callback: T): () => void {
  set.add(callback);
  return () => set.delete(callback);
}

function pushScrollback(data: string, reset = false): void {
  for (const subscriber of scrollbackSubscribers) subscriber(data, reset);
}

async function expectRestoredSession(
  container: HTMLElement,
  sessionId: string,
  instanceIndex = 0,
): Promise<MockTerminalInstance> {
  expect(container.querySelector(".terminal-loading")).toBeNull();
  const xtermHost = screen.getByTestId("terminal-xterm");
  expect(xtermHost).toBeInTheDocument();
  expect(xtermHost.style.display).not.toBe("none");

  await waitFor(() => {
    expect(terminalInstances[instanceIndex]?.open).toHaveBeenCalledWith(xtermHost);
  });
  expect(terminalInstances[instanceIndex]?.attachedSessionId).toBe(sessionId);
  expect(mockUseTerminal).toHaveBeenCalledWith(sessionId, expect.anything());
  return terminalInstances[instanceIndex]!;
}

describe("TerminalModal reopen restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    terminalInstances.length = 0;
    latestTerminalSessionId = null;
    dataSubscribers.clear();
    exitSubscribers.clear();
    connectSubscribers.clear();
    scrollbackSubscribers.clear();
    invalidSessionSubscribers.clear();

    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    mockUseWorkspaces.mockReturnValue({
      projectName: "Fusion",
      workspaces: [],
      loading: false,
      error: null,
    });
    mockUseTerminal.mockImplementation((sessionId) => {
      latestTerminalSessionId = sessionId;
      return {
        connectionStatus: sessionId ? "connected" : "disconnected",
        sendInput: vi.fn(),
        resize: vi.fn(),
        onData: (callback) => subscribe(dataSubscribers, callback),
        onExit: (callback) => subscribe(exitSubscribers, callback),
        onConnect: (callback) => subscribe(connectSubscribers, callback),
        onScrollback: (callback) => subscribe(scrollbackSubscribers, callback),
        reconnect: vi.fn(),
        onSessionInvalid: (callback) => subscribe(invalidSessionSubscribers, callback),
      };
    });
    mockCreateTerminalSession.mockResolvedValue({
      sessionId: "created-session",
      shell: "/bin/bash",
      cwd: "/project",
    });
    mockKillPtyTerminalSession.mockResolvedValue({ killed: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restores a persisted desktop session before validation and replays scrollback", async () => {
    const projectId = "restore-desktop";
    const sessionId = "persisted-session";
    const list = deferred<ReturnType<typeof serverSession>[]>();
    seedTabs(projectId, [storedTab(sessionId)]);
    mockListTerminalSessions.mockReturnValue(list.promise);

    const view = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);

    const terminal = await expectRestoredSession(view.container, sessionId);
    expect(view.container.querySelector(".terminal-loading")).toBeNull();
    await waitFor(() => expect(scrollbackSubscribers.size).toBe(1));

    act(() => pushScrollback("restored output\r\n"));
    expect(terminal.write).toHaveBeenCalledWith("restored output\r\n");
    expect(view.container.querySelector(".terminal-loading")).toBeNull();

    await act(async () => {
      list.resolve([serverSession(sessionId)]);
      await list.promise;
    });
    await waitFor(() => expect(mockListTerminalSessions).toHaveBeenCalled());
    expect(view.container.querySelector(".terminal-loading")).toBeNull();
    expect(terminalInstances).toHaveLength(1);
  });

  it("restores the same global session after a close and reopen remount", async () => {
    const projectId = "restore-remount";
    const sessionId = "persistent-shell";
    seedTabs(projectId, [storedTab(sessionId)]);
    mockListTerminalSessions.mockResolvedValue([serverSession(sessionId)]);

    const first = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);
    await expectRestoredSession(first.container, sessionId, 0);
    await waitFor(() => expect(mockListTerminalSessions).toHaveBeenCalled());
    const validationCallsBeforeReopen = mockListTerminalSessions.mock.calls.length;
    first.unmount();

    const reopenList = deferred<ReturnType<typeof serverSession>[]>();
    mockListTerminalSessions.mockReturnValue(reopenList.promise);
    const reopened = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);
    expect(reopened.container.querySelector(".terminal-loading")).toBeNull();
    await expectRestoredSession(reopened.container, sessionId, 1);
    expect(reopened.container.querySelector(".terminal-loading")).toBeNull();
    await waitFor(() => {
      expect(mockListTerminalSessions.mock.calls.length).toBeGreaterThan(validationCallsBeforeReopen);
    });

    await act(async () => {
      reopenList.resolve([serverSession(sessionId)]);
      await reopenList.promise;
    });
    expect(reopened.container.querySelector(".terminal-loading")).toBeNull();
  });

  it.each([
    ["absent", null],
    ["malformed", "{not valid json"],
  ])("keeps the start-up state for a cold start with %s storage", async (_label, storedValue) => {
    const projectId = `cold-start-${_label}`;
    const list = deferred<ReturnType<typeof serverSession>[]>();
    const create = deferred<{ sessionId: string; shell: string; cwd: string }>();
    if (storedValue !== null) {
      window.localStorage.setItem(storageKey(projectId), storedValue);
    }
    mockListTerminalSessions.mockReturnValue(list.promise);
    mockCreateTerminalSession.mockReturnValue(create.promise);

    const view = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);

    expect(screen.getByTestId("terminal-loading")).toHaveTextContent("Starting terminal...");
    expect(terminalInstances).toHaveLength(0);

    await act(async () => {
      list.resolve([]);
      await list.promise;
    });
    await waitFor(() => expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("terminal-loading")).toHaveTextContent("Starting terminal...");

    await act(async () => {
      create.resolve({ sessionId: "cold-created", shell: "/bin/bash", cwd: "/project" });
      await create.promise;
    });
    await waitFor(() => expect(view.container.querySelector(".terminal-loading")).toBeNull());
    expect(terminalInstances[0]?.attachedSessionId).toBe("cold-created");
  });

  it("restores an embedded task-scoped session from its isolated storage namespace", async () => {
    const projectId = "restore-embedded";
    const scopeId = "FN-1";
    const sessionId = "task-session";
    const defaultCwd = "/project/.fusion/worktrees/fn-1";
    const list = deferred<ReturnType<typeof serverSession>[]>();
    seedTabs(projectId, [storedTab(sessionId)], scopeId);
    mockListTerminalSessions.mockReturnValue(list.promise);

    const view = render(
      <TerminalModal
        isOpen
        onClose={vi.fn()}
        projectId={projectId}
        embedded
        scopeId={scopeId}
        defaultCwd={defaultCwd}
      />,
    );

    expect(screen.getByTestId("terminal-embedded-host")).toBeInTheDocument();
    await expectRestoredSession(view.container, sessionId);
    expect(view.container.querySelector(".terminal-loading")).toBeNull();

    await act(async () => {
      list.resolve([serverSession(sessionId, defaultCwd)]);
      await list.promise;
    });
    expect(view.container.querySelector(".terminal-loading")).toBeNull();
  });

  it("restores a persisted session in the mobile full-screen presentation", async () => {
    const previousInnerWidth = window.innerWidth;
    const previousOntouchstart = window.ontouchstart;
    const projectId = "restore-mobile";
    const sessionId = "mobile-session";
    const list = deferred<ReturnType<typeof serverSession>[]>();
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: null, configurable: true });
    seedTabs(projectId, [storedTab(sessionId)]);
    mockListTerminalSessions.mockReturnValue(list.promise);

    try {
      const view = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);

      expect(await screen.findByTestId("terminal-modal")).toHaveClass("terminal-modal--mobile");
      await expectRestoredSession(view.container, sessionId);
      expect(view.container.querySelector(".terminal-loading")).toBeNull();

      await act(async () => {
        list.resolve([serverSession(sessionId)]);
        await list.promise;
      });
      expect(view.container.querySelector(".terminal-loading")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: previousInnerWidth, configurable: true });
      if (previousOntouchstart === undefined) {
        delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
      } else {
        Object.defineProperty(window, "ontouchstart", { value: previousOntouchstart, configurable: true });
      }
    }
  });

  it("shows a genuine start-up window while replacing a pruned dead session", async () => {
    const projectId = "replace-dead-session";
    const staleSessionId = "stale-session";
    const replacementSessionId = "replacement-session";
    const list = deferred<ReturnType<typeof serverSession>[]>();
    const create = deferred<{ sessionId: string; shell: string; cwd: string }>();
    seedTabs(projectId, [storedTab(staleSessionId)]);
    mockListTerminalSessions.mockReturnValue(list.promise);
    mockCreateTerminalSession.mockReturnValue(create.promise);

    const view = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);

    const staleTerminal = await expectRestoredSession(view.container, staleSessionId);
    expect(view.container.querySelector(".terminal-loading")).toBeNull();

    await act(async () => {
      list.resolve([]);
      await list.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("terminal-loading")).toHaveTextContent("Starting terminal...");
    });
    await waitFor(() => expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1));
    expect(staleTerminal.dispose).not.toHaveBeenCalled();

    await act(async () => {
      create.resolve({
        sessionId: replacementSessionId,
        shell: "/bin/bash",
        cwd: "/project",
      });
      await create.promise;
    });

    await waitFor(() => expect(view.container.querySelector(".terminal-loading")).toBeNull());
    await waitFor(() => expect(terminalInstances).toHaveLength(2));
    const replacementTerminal = terminalInstances[1]!;
    expect(replacementTerminal.attachedSessionId).toBe(replacementSessionId);
    expect(replacementTerminal.open).toHaveBeenCalledWith(screen.getByTestId("terminal-xterm"));
    expect(staleTerminal.dispose).toHaveBeenCalledTimes(1);
    expect(replacementTerminal.dispose).not.toHaveBeenCalled();
  });

  it("restores the previously active tab when multiple sessions are persisted", async () => {
    const projectId = "restore-active-tab";
    const inactiveSessionId = "inactive-session";
    const activeSessionId = "active-session";
    const list = deferred<ReturnType<typeof serverSession>[]>();
    seedTabs(projectId, [
      storedTab(inactiveSessionId, { isActive: false }),
      storedTab(activeSessionId),
    ]);
    mockListTerminalSessions.mockReturnValue(list.promise);

    const view = render(<TerminalModal isOpen onClose={vi.fn()} projectId={projectId} />);

    await expectRestoredSession(view.container, activeSessionId);
    expect(view.container.querySelector(".terminal-loading")).toBeNull();
    expect(mockUseTerminal).toHaveBeenCalledWith(activeSessionId, projectId);

    await act(async () => {
      list.resolve([serverSession(inactiveSessionId), serverSession(activeSessionId)]);
      await list.promise;
    });
    expect(view.container.querySelector(".terminal-loading")).toBeNull();
  });

  it("keeps the start-up affordance and TerminalModal production hosts fully inventoried", () => {
    const sourceFiles = productionAppSourceFiles();
    const affordanceFiles = sourceFiles.filter((file) => {
      const source = readAppFile(file);
      return source.includes("terminal.startingTerminal") || source.includes('className="terminal-loading"');
    });
    expect(affordanceFiles).toEqual(["components/TerminalModal.tsx"]);

    const terminalHosts = sourceFiles.filter((file) => /<(?:Lazy)?TerminalModal\b/.test(readAppFile(file)));
    expect(terminalHosts).toEqual(["App.tsx", "components/TaskDetailModal.tsx"]);
  });
});

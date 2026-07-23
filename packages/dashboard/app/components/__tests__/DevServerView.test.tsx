import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServerConfig, DevServerState } from "../../api";
import { DevServerView } from "../DevServerView";

const mockUseDevServer = vi.fn();
const mockUseDevServerConfig = vi.fn();
const mockUseDevServerLogs = vi.fn();
const mockUsePreviewEmbed = vi.fn();

vi.mock("../../hooks/useDevServer", () => ({
  useDevServer: (...args: unknown[]) => mockUseDevServer(...args),
}));

vi.mock("../../hooks/useDevServerConfig", () => ({
  useDevServerConfig: (...args: unknown[]) => mockUseDevServerConfig(...args),
}));

vi.mock("../../hooks/useDevServerLogs", () => ({
  useDevServerLogs: (...args: unknown[]) => mockUseDevServerLogs(...args),
}));

vi.mock("../../hooks/usePreviewEmbed", () => ({
  usePreviewEmbed: (...args: unknown[]) => mockUsePreviewEmbed(...args),
}));

vi.mock("../DevServerLogViewer", () => ({
  DevServerLogViewer: () => <div data-testid="mock-devserver-log-viewer" />,
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="icon-alert-triangle" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
  Eye: () => <span data-testid="icon-eye" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Maximize2: () => <span data-testid="icon-maximize" />,
  Minimize2: () => <span data-testid="icon-minimize" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  Play: () => <span data-testid="icon-play" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  RotateCw: () => <span data-testid="icon-rotate" />,
  Search: () => <span data-testid="icon-search" />,
  Square: () => <span data-testid="icon-square" />,
}));

function createState(overrides: Partial<DevServerState> = {}): DevServerState {
  return {
    id: "default",
    name: "default",
    status: "stopped",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: ".",
    logs: [],
    ...overrides,
  };
}

function legacyStateToSession(legacy: DevServerState) {
  return {
    config: {
      id: legacy.id ?? "default",
      name: legacy.name ?? "Dev Server",
      command: legacy.command ?? "",
      cwd: legacy.cwd ?? ".",
    },
    status: legacy.status,
    runtime: legacy.pid
      ? {
        pid: legacy.pid,
        startedAt: legacy.startedAt ?? new Date().toISOString(),
        exitCode: legacy.exitCode ?? undefined,
        previewUrl: legacy.previewUrl,
      }
      : undefined,
    previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? legacy.manualUrl,
    logHistory: [],
  };
}

function createDevServerHookState(overrides: Record<string, unknown> = {}) {
  const defaultCandidates = [
    { name: "dev", command: "pnpm dev", scriptName: "dev", cwd: ".", source: "root", label: "project · dev (root)" },
    { name: "start", command: "pnpm start --filter web", scriptName: "start", cwd: "apps/web", source: "apps/web", workspaceName: "@demo/web", label: "@demo/web · start (apps/web)" },
  ];
  const candidates = (overrides.candidates as typeof defaultCandidates | undefined) ?? defaultCandidates;
  const start = (overrides.start as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const stop = (overrides.stop as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const restart = (overrides.restart as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const setPreviewUrl = (overrides.setPreviewUrl as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const detect = (overrides.detect as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const refresh = (overrides.refresh as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const serverState = (overrides.serverState as DevServerState | undefined) ?? createState();
  return {
    // legacy API (still read by some tests as aliases)
    logs: ["ready"],
    loading: false,
    error: null,
    setManualUrl: setPreviewUrl,
    refreshStatus: refresh,
    // new API consumed by the current component
    sessions: [],
    previewUrl: serverState.previewUrl ?? null,
    isLoading: false,
    ...overrides,
    // the following must come AFTER `...overrides` so aliases track the
    // overridden legacy fields (start, serverState, candidates, ...).
    candidates,
    serverState,
    start,
    stop,
    restart,
    setPreviewUrl,
    detect,
    session: legacyStateToSession(serverState),
    detectedCommands: candidates,
    startServer: start,
    stopServer: stop,
    restartServer: restart,
    detectCommands: detect,
    refresh,
  };
}

function createConfig(overrides: Partial<DevServerConfig> = {}): DevServerConfig {
  return {
    selectedScript: null,
    selectedSource: null,
    selectedCommand: null,
    previewUrlOverride: null,
    detectedPreviewUrl: null,
    selectedAt: null,
    ...overrides,
  };
}

function createConfigHookState(overrides: Record<string, unknown> = {}) {
  return {
    config: createConfig(),
    loading: false,
    error: null,
    selectScript: vi.fn().mockResolvedValue(undefined),
    clearSelection: vi.fn().mockResolvedValue(undefined),
    setPreviewUrlOverride: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createDevServerLogsHookState(overrides: Record<string, unknown> = {}) {
  return {
    entries: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    total: 0,
    loadMore: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

function createPreviewEmbedState(overrides: Record<string, unknown> = {}) {
  return {
    embedStatus: "embedded",
    iframeRef: { current: null },
    handleIframeLoad: vi.fn(),
    handleIframeError: vi.fn(),
    resetEmbed: vi.fn(),
    isEmbedded: true,
    isBlocked: false,
    ...overrides,
  };
}

describe("DevServerView", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // FNXC:DevServer 2026-07-22-13:45: persisted selection/command state (R12) must not leak between tests.
    localStorage.clear();
    mockUseDevServer.mockReturnValue(createDevServerHookState());
    mockUseDevServerConfig.mockReturnValue(createConfigHookState());
    mockUseDevServerLogs.mockReturnValue(createDevServerLogsHookState());
    mockUsePreviewEmbed.mockReturnValue(createPreviewEmbedState());
  });

  it("renders without crashing", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-view")).toBeInTheDocument();
  });

  it("renders candidate list when detection returns scripts", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-candidates")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
  });

  it("renders no-candidates message when candidates are empty", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ candidates: [] }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-empty-candidates")).toHaveTextContent("No dev server scripts detected");
  });

  it("shows stopped status badge", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: createState({ status: "stopped" }) }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-status-badge")).toHaveTextContent("Stopped");
  });

  it("shows running status badge", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: createState({ status: "running" }) }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-status-badge")).toHaveTextContent("Running");
  });

  it("disables start when running and stop when stopped", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: createState({ status: "running" }) }));

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-start-button")).toBeDisabled();

    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: createState({ status: "stopped" }) }));
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-stop-button")).toBeDisabled();
  });

  it("clicking start calls start from hook", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(createDevServerHookState({ start }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-start-button"));

    await waitFor(() => {
      expect(start).toHaveBeenCalled();
    });
  });

  it("clicking stop calls stop from hook", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({
        stop,
        serverState: createState({ status: "running" }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-stop-button"));

    await waitFor(() => {
      expect(stop).toHaveBeenCalled();
    });
  });

  it("clicking restart calls restart from hook", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({
        restart,
        serverState: createState({ status: "running" }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-restart-button"));

    await waitFor(() => {
      expect(restart).toHaveBeenCalled();
    });
  });

  it("clicking a candidate shows the selected-script summary", async () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-candidate-dev-root"));

    await waitFor(() => {
      expect(screen.getByTestId("dev-server-selected-summary")).toBeInTheDocument();
    });
  });

  it("re-shows the candidates list when the user clicks Change after selecting", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-candidate-dev-root"));
    expect(screen.getByTestId("dev-server-selected-summary")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("dev-server-change-selection"));

    expect(screen.getByTestId("dev-server-candidates")).toBeInTheDocument();
  });

  it("saves preview URL override from input", async () => {
    const setPreviewUrl = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(createDevServerHookState({ setPreviewUrl }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.change(screen.getByTestId("dev-server-preview-input"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.click(screen.getByTestId("dev-server-set-preview"));

    await waitFor(() => {
      expect(setPreviewUrl).toHaveBeenCalledWith("http://localhost:3000");
    });
  });

  it("renders log viewer panel", () => {
    mockUseDevServerLogs.mockReturnValue(
      createDevServerLogsHookState({
        entries: [{ id: 1, text: "server started", stream: "stdout", timestamp: "2026-01-01T00:00:00.000Z" }],
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("mock-devserver-log-viewer")).toBeInTheDocument();
  });

  it("renders preview iframe when preview URL is available", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({
        serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }),
      }),
    );
    mockUsePreviewEmbed.mockReturnValue(createPreviewEmbedState({ embedStatus: "embedded", isBlocked: false }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTitle("Dev server preview")).toBeInTheDocument();
  });

  it("renders selected script summary after user selects a script", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-candidate-dev-root"));

    expect(screen.getByTestId("dev-server-selected-summary")).toBeInTheDocument();
  });

  it("lists targetable executing tasks in the task picker", () => {
    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "Build checkout", description: "Preview checkout", column: "in-progress", worktree: "/tmp/fn-100" },
          { id: "FN-101", title: "Fix banner", description: "Preview banner", column: "in-progress", worktree: "/tmp/fn-101" },
        ] as never}
      />,
    );

    const options = Array.from(screen.getByTestId("dev-server-task-picker").querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "Project root (no task)",
      "FN-100 — Build checkout",
      "FN-101 — Fix banner",
    ]);
  });

  it("disables the task picker and shows an empty state when no executing task has a worktree", () => {
    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "No checkout yet", description: "Missing worktree", column: "in-progress" },
          { id: "FN-101", title: "Done", description: "Not executing", column: "done", worktree: "/tmp/fn-101" },
        ] as never}
      />,
    );

    expect(screen.getByTestId("dev-server-task-picker")).toBeDisabled();
    expect(screen.getByTestId("dev-server-no-executing-tasks")).toHaveTextContent("No executing tasks with a worktree available");
  });

  it("shows and clears the selected task descriptor", () => {
    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "Build checkout", description: "Preview checkout changes", column: "in-progress", worktree: "/tmp/fn-100" },
        ] as never}
      />,
    );

    expect(screen.queryByTestId("dev-server-task-descriptor")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("dev-server-task-picker"), { target: { value: "FN-100" } });

    expect(screen.getByTestId("dev-server-task-descriptor")).toHaveTextContent("FN-100 — Build checkout");
    expect(screen.getByTestId("dev-server-task-descriptor")).toHaveTextContent("Preview checkout changes");
    expect(screen.getByTestId("dev-server-task-descriptor")).toHaveTextContent("/tmp/fn-100");

    fireEvent.change(screen.getByTestId("dev-server-task-picker"), { target: { value: "" } });

    expect(screen.queryByTestId("dev-server-task-descriptor")).not.toBeInTheDocument();
  });

  it("starts the dev server in the selected task worktree", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(createDevServerHookState({ start }));

    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "Build checkout", description: "Preview checkout", column: "in-progress", worktree: "/tmp/fn-100" },
        ] as never}
      />,
    );

    fireEvent.change(screen.getByTestId("dev-server-task-picker"), { target: { value: "FN-100" } });
    fireEvent.change(screen.getByTestId("dev-server-command-input"), { target: { value: "pnpm dev --host" } });
    fireEvent.click(screen.getByTestId("dev-server-start-button"));

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith("pnpm dev --host", "/tmp/fn-100");
    });
  });

  it("starts the dev server in the project root when no task is selected", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    mockUseDevServer.mockReturnValue(createDevServerHookState({ start }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.change(screen.getByTestId("dev-server-command-input"), { target: { value: "pnpm dev --host" } });
    fireEvent.click(screen.getByTestId("dev-server-start-button"));

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith("pnpm dev --host", ".");
    });
  });

  it("clears a selected task when it leaves the executing task list", async () => {
    const selectedTask = { id: "FN-100", title: "Build checkout", description: "Preview checkout", column: "in-progress", worktree: "/tmp/fn-100" } as never;
    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" tasks={[selectedTask]} />);

    fireEvent.change(screen.getByTestId("dev-server-task-picker"), { target: { value: "FN-100" } });
    expect(screen.getByTestId("dev-server-task-descriptor")).toBeInTheDocument();

    rerender(<DevServerView addToast={addToast} projectId="project-a" tasks={[]} />);

    await waitFor(() => {
      expect(screen.queryByTestId("dev-server-task-descriptor")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("dev-server-task-picker")).toHaveValue("");
  });

  it("shows restart guidance when selecting a task while the server is running", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: createState({ status: "running" }) }));

    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "Build checkout", description: "Preview checkout", column: "in-progress", worktree: "/tmp/fn-100" },
        ] as never}
      />,
    );

    fireEvent.change(screen.getByTestId("dev-server-task-picker"), { target: { value: "FN-100" } });

    expect(addToast).toHaveBeenCalledWith("Restart the dev server to apply the selected task's worktree.", "info");
  });

  it("excludes executing tasks without a worktree from the picker", () => {
    render(
      <DevServerView
        addToast={addToast}
        projectId="project-a"
        tasks={[
          { id: "FN-100", title: "No checkout", description: "Missing worktree", column: "in-progress" },
          { id: "FN-101", title: "Has checkout", description: "Ready", column: "in-progress", worktree: "/tmp/fn-101" },
        ] as never}
      />,
    );

    expect(screen.queryByText("FN-100 — No checkout")).not.toBeInTheDocument();
    expect(screen.getByText("FN-101 — Has checkout")).toBeInTheDocument();
  });

  /*
  FNXC:DevServer 2026-07-22-13:45:
  FN remount-churn fix R12: DevServerView unmounts on navigation by design, so the typed-but-unsent command and the selected script restore from per-project persisted state after an unmount round-trip; a fresh project keeps defaults.
  */
  it("restores the typed command and selected script after an unmount round-trip", () => {
    localStorage.clear();
    const { unmount } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-candidate-dev-root"));
    fireEvent.change(screen.getByTestId("dev-server-command-input"), { target: { value: "pnpm dev --port 0" } });

    unmount();
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-command-input")).toHaveValue("pnpm dev --port 0");
    expect(screen.getByTestId("dev-server-selected-summary")).toHaveTextContent("dev");
  });

  it("keeps defaults for a project with no persisted dev-server state", () => {
    localStorage.clear();
    render(<DevServerView addToast={addToast} projectId="fresh-project" />);

    // No selection restored; the command shows the existing first-candidate auto-suggestion.
    expect(screen.getByTestId("dev-server-command-input")).toHaveValue("pnpm dev");
    expect(screen.queryByTestId("dev-server-selected-summary")).not.toBeInTheDocument();
  });
});

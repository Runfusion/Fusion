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

function createDevServerHookState(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        name: "dev",
        command: "pnpm dev",
        scriptName: "dev",
        cwd: ".",
        source: "root",
        label: "project · dev (root)",
      },
      {
        name: "start",
        command: "pnpm start --filter web",
        scriptName: "start",
        cwd: "apps/web",
        source: "apps/web",
        workspaceName: "@demo/web",
        label: "@demo/web · start (apps/web)",
      },
    ],
    serverState: createState(),
    logs: ["ready"],
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    setPreviewUrl: vi.fn().mockResolvedValue(undefined),
    loading: false,
    error: null,
    detect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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

  it("clicking a candidate persists selection via selectScript", async () => {
    const selectScript = vi.fn().mockResolvedValue(undefined);
    mockUseDevServerConfig.mockReturnValue(createConfigHookState({ selectScript }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-candidate-dev-root"));

    await waitFor(() => {
      expect(selectScript).toHaveBeenCalledWith({
        name: "dev",
        command: "pnpm dev",
        source: "root",
      });
    });
  });

  it("highlights the selected candidate", () => {
    mockUseDevServerConfig.mockReturnValue(
      createConfigHookState({
        config: createConfig({
          selectedScript: "dev",
          selectedSource: "root",
          selectedCommand: "pnpm dev",
        }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-change-selection"));

    const selected = screen.getByTestId("dev-server-candidate-dev-root");
    expect(selected).toHaveClass("dev-server-candidate--selected");
  });

  it("saves preview URL override from input", async () => {
    const setPreviewUrlOverride = vi.fn().mockResolvedValue(undefined);
    const setPreviewUrl = vi.fn().mockResolvedValue(undefined);

    mockUseDevServerConfig.mockReturnValue(createConfigHookState({ setPreviewUrlOverride }));
    mockUseDevServer.mockReturnValue(createDevServerHookState({ setPreviewUrl }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.change(screen.getByTestId("dev-server-preview-input"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.click(screen.getByTestId("dev-server-set-preview"));

    await waitFor(() => {
      expect(setPreviewUrlOverride).toHaveBeenCalledWith("http://localhost:3000");
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

  it("renders selected script summary when config has a selection", () => {
    mockUseDevServerConfig.mockReturnValue(
      createConfigHookState({
        config: createConfig({
          selectedScript: "dev",
          selectedSource: "root",
          selectedCommand: "pnpm dev",
        }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-selected-summary")).toBeInTheDocument();
  });
});

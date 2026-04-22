import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  ShieldAlert: () => <span data-testid="icon-shield-alert" />,
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
    previewUrl: null,
    manualPreviewUrl: null,
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
    previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? legacy.manualUrl ?? null,
    logHistory: [],
  };
}

function createDevServerHookState(overrides: Record<string, unknown> = {}) {
  const start = (overrides.start as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const stop = (overrides.stop as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const restart = (overrides.restart as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const setPreviewUrl = (overrides.setPreviewUrl as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const detect = (overrides.detect as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const refresh = (overrides.refresh as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(undefined);
  const serverState = (overrides.serverState as DevServerState | undefined) ?? createState();
  const candidates = (overrides.candidates as unknown[] | undefined) ?? [];
  return {
    // legacy API (still read by some tests as aliases)
    logs: [],
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
    // overridden legacy fields.
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

function createPreviewEmbedState(overrides: Record<string, unknown> = {}) {
  return {
    embedStatus: "unknown",
    setEmbedStatus: vi.fn(),
    resetEmbedStatus: vi.fn(),
    iframeRef: createRef<HTMLIFrameElement>(),
    isEmbedded: false,
    isBlocked: false,
    embedContext: null,
    retry: vi.fn(),
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

describe("DevServerView preview panel", () => {
  const addToast = vi.fn();
  const originalWindowOpen = window.open;

  let previewEmbedState = createPreviewEmbedState();

  beforeEach(() => {
    vi.clearAllMocks();
    window.open = vi.fn();

    previewEmbedState = createPreviewEmbedState();

    mockUseDevServer.mockReturnValue(createDevServerHookState());
    mockUseDevServerConfig.mockReturnValue(createConfigHookState());
    mockUseDevServerLogs.mockReturnValue(createDevServerLogsHookState());
    mockUsePreviewEmbed.mockImplementation(() => previewEmbedState);
  });

  afterEach(() => {
    window.open = originalWindowOpen;
  });

  it("shows start-empty state when server is not configured", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState({ serverState: null }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByText("Start a dev server to see a live preview here.")).toBeInTheDocument();
  });

  it("shows no-preview-url state when server is running without URL", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({
        serverState: createState({ status: "running", previewUrl: null, manualPreviewUrl: null }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByText("No preview URL detected. Start the dev server or set a manual URL to preview your app.")).toBeInTheDocument();
  });

  it("renders iframe when preview URL exists and fallback is hidden", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    previewEmbedState = createPreviewEmbedState({ embedStatus: "embedded", isEmbedded: true });

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTitle("Dev server preview")).toBeInTheDocument();
    const previewContainer = screen.getByTestId("devserver-preview-panel").querySelector(".devserver-preview-container");
    expect(previewContainer).toHaveAttribute("data-embed-status", "embedded");
    expect(previewContainer).toHaveAttribute("data-embedded", "true");
  });

  it("shows manual URL badge when a manual preview override is active", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({
        serverState: createState({ status: "running", previewUrl: "http://localhost:3000", manualPreviewUrl: "http://localhost:9999" }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    const badge = screen.getByTestId("devserver-preview-url-badge");
    expect(badge).toHaveTextContent("Manual · http://localhost:9999");
    expect(badge).toHaveClass("devserver-preview-url-badge--manual");
  });

  it("switches to external-only mode and can open preview from that state", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("devserver-preview-mode-toggle"));

    expect(screen.getByTestId("devserver-preview-external-only")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("devserver-preview-external-open-tab"));
    expect(window.open).toHaveBeenCalledWith("http://localhost:3000", "_blank", "noopener,noreferrer");
  });

  it("shows loading overlay when embed status is loading", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    previewEmbedState = createPreviewEmbedState({ embedStatus: "loading", isBlocked: false });

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("devserver-preview-loading")).toBeInTheDocument();
  });

  it("open-in-new-tab action opens the preview URL", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("devserver-preview-open-tab"));

    expect(window.open).toHaveBeenCalledWith("http://localhost:3000", "_blank", "noopener,noreferrer");
  });

  it("open-in-new-tab action is disabled when no preview URL is available", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "stopped", previewUrl: null }) }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("devserver-preview-open-tab")).toBeDisabled();
  });

  it("fallback panel is shown when embed transitions to blocked", async () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({
      embedStatus: "blocked",
      isBlocked: true,
      embedContext: "The server may block iframe embedding...",
    });

    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback")).toBeInTheDocument();
    });
    expect(screen.getByText("Preview blocked")).toBeInTheDocument();
    expect(screen.getByText("The server may block iframe embedding...")).toBeInTheDocument();
    expect(screen.getByTestId("icon-shield-alert")).toBeInTheDocument();
  });

  it("fallback panel open-in-new-tab action opens external URL", async () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({
      embedStatus: "blocked",
      isBlocked: true,
      embedContext: "The server may block iframe embedding...",
    });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback-open-tab")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("devserver-preview-fallback-open-tab"));

    expect(window.open).toHaveBeenCalledWith("http://localhost:3000", "_blank", "noopener,noreferrer");
  });

  it("fallback retry action calls hook retry", async () => {
    const retry = vi.fn();

    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({
      embedStatus: "blocked",
      isBlocked: true,
      embedContext: "The server may block iframe embedding...",
      retry,
    });

    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback-retry")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("devserver-preview-fallback-retry"));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("fallback panel is shown when embed transitions to error", async () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({
      embedStatus: "error",
      isBlocked: true,
      embedContext: "The preview URL could not be loaded...",
    });

    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback")).toBeInTheDocument();
    });

    expect(screen.getByText("Preview failed")).toBeInTheDocument();
    expect(screen.getByText("The preview URL could not be loaded...")).toBeInTheDocument();
    expect(screen.getByTestId("icon-alert-triangle")).toBeInTheDocument();
  });

  it("iframe is hidden when fallback is shown", async () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({ embedStatus: "blocked", isBlocked: true, embedContext: "blocked" });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback")).toBeInTheDocument();
    });

    expect(screen.queryByTitle("Dev server preview")).not.toBeInTheDocument();
  });

  it("fallback resets when preview URL changes", async () => {
    let serverState = createState({ status: "running", previewUrl: "http://localhost:3000" });
    mockUseDevServer.mockImplementation(() => createDevServerHookState({ serverState }));

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({ embedStatus: "blocked", isBlocked: true, embedContext: "blocked" });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback")).toBeInTheDocument();
    });

    serverState = createState({ status: "running", previewUrl: "http://localhost:4000" });
    previewEmbedState = createPreviewEmbedState({ embedStatus: "loading", isBlocked: false });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.queryByTestId("devserver-preview-fallback")).not.toBeInTheDocument();
    });
  });

  it("fallback clears when embed succeeds after retry", async () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    previewEmbedState = createPreviewEmbedState({ embedStatus: "blocked", isBlocked: true, embedContext: "blocked" });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("devserver-preview-fallback")).toBeInTheDocument();
    });

    previewEmbedState = createPreviewEmbedState({ embedStatus: "embedded", isEmbedded: true, isBlocked: false });
    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    await waitFor(() => {
      expect(screen.queryByTestId("devserver-preview-fallback")).not.toBeInTheDocument();
    });
    expect(screen.getByTitle("Dev server preview")).toBeInTheDocument();
  });

  it("refresh action resets embed state", () => {
    const resetEmbedStatus = vi.fn();
    const reload = vi.fn();

    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );

    const iframeRef = createRef<HTMLIFrameElement>();
    previewEmbedState = createPreviewEmbedState({
      iframeRef,
      resetEmbedStatus,
    });

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    const iframe = screen.getByTitle("Dev server preview") as HTMLIFrameElement;
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: {
        location: {
          reload,
        },
      },
    });

    fireEvent.click(screen.getByTestId("devserver-preview-refresh"));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(resetEmbedStatus).toHaveBeenCalledTimes(1);
  });
});

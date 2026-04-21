import { fireEvent, render, screen } from "@testing-library/react";
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

function createDevServerHookState(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [],
    serverState: createState(),
    logs: [],
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
    iframeRef: createRef<HTMLIFrameElement>(),
    handleIframeLoad: vi.fn(),
    handleIframeError: vi.fn(),
    resetEmbed: vi.fn(),
    isEmbedded: false,
    isBlocked: false,
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

  beforeEach(() => {
    vi.clearAllMocks();
    window.open = vi.fn();

    mockUseDevServer.mockReturnValue(createDevServerHookState());
    mockUseDevServerConfig.mockReturnValue(createConfigHookState());
    mockUseDevServerLogs.mockReturnValue(createDevServerLogsHookState());
    mockUsePreviewEmbed.mockReturnValue(createPreviewEmbedState());
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

  it("renders iframe when preview URL exists and embed is not blocked", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({ embedStatus: "embedded", isEmbedded: true, isBlocked: false }),
    );

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
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({ embedStatus: "loading", isBlocked: false }),
    );

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

  it("shows fallback banner when embed is blocked", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({ embedStatus: "blocked", isBlocked: true }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByText("Preview cannot be embedded here. The server may be blocking iframe embedding.")).toBeInTheDocument();
    expect(screen.getByTestId("icon-alert-triangle")).toBeInTheDocument();
  });

  it("shows fallback banner when embed errors", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({ embedStatus: "error", isBlocked: true }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByText("Preview cannot be embedded here. The server may be blocking iframe embedding.")).toBeInTheDocument();
  });

  it("fallback open-in-new-tab action opens the preview URL", () => {
    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({ embedStatus: "blocked", isBlocked: true }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("devserver-preview-fallback-open-tab"));

    expect(window.open).toHaveBeenCalledWith("http://localhost:3000", "_blank", "noopener,noreferrer");
  });

  it("refresh action resets embed state", () => {
    const resetEmbed = vi.fn();
    const reload = vi.fn();

    mockUseDevServer.mockReturnValue(
      createDevServerHookState({ serverState: createState({ status: "running", previewUrl: "http://localhost:3000" }) }),
    );
    mockUsePreviewEmbed.mockReturnValue(
      createPreviewEmbedState({
        embedStatus: "blocked",
        isBlocked: true,
        iframeRef: {
          current: {
            src: "http://localhost:3000",
            contentWindow: {
              location: {
                reload,
              },
            },
          } as unknown as HTMLIFrameElement,
        },
        resetEmbed,
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("devserver-preview-refresh"));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(resetEmbed).toHaveBeenCalledTimes(1);
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServerState } from "../../api";
import { DevServerView } from "../DevServerView";

const mockUseDevServer = vi.fn();

vi.mock("../../hooks/useDevServer", () => ({
  useDevServer: (...args: unknown[]) => mockUseDevServer(...args),
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => <span data-testid="icon-external-link" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  Play: () => <span data-testid="icon-play" />,
  RotateCw: () => <span data-testid="icon-rotate" />,
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

function createHookState(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        name: "dev",
        command: "pnpm dev",
        scriptName: "dev",
        cwd: ".",
        label: "project · dev (root)",
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
    ...overrides,
  };
}

describe("DevServerView", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDevServer.mockReturnValue(createHookState());
  });

  it("renders without crashing", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-view")).toBeInTheDocument();
  });

  it.each([
    ["stopped", "Stopped"],
    ["running", "Running"],
    ["starting", "Starting..."],
    ["failed", "Failed"],
  ] as const)("shows %s status badge", (status, label) => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({ status }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-status-badge")).toHaveTextContent(label);
  });

  it("disables Start when server is running or starting", () => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({ status: "running" }),
      }),
    );

    const { rerender } = render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-start-button")).toBeDisabled();

    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({ status: "starting" }),
      }),
    );

    rerender(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-start-button")).toBeDisabled();
  });

  it("disables Stop when server is stopped", () => {
    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-stop-button")).toBeDisabled();
  });

  it("clicking Start calls start from the hook", () => {
    const start = vi.fn().mockResolvedValue(undefined);

    mockUseDevServer.mockReturnValue(createHookState({ start }));

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    fireEvent.click(screen.getByTestId("dev-server-start-button"));

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("renders log entries from hook logs", () => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        logs: ["first line", "second line"],
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByText("first line")).toBeInTheDocument();
    expect(screen.getByText("second line")).toBeInTheDocument();
  });

  it("renders preview iframe when preview URL is set", () => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({
          status: "running",
          previewUrl: "http://localhost:5173",
        }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    const iframe = screen.getByTestId("dev-server-preview-iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("shows CSP fallback message when embedding times out", async () => {
    vi.useFakeTimers();

    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({
          status: "running",
          previewUrl: "http://localhost:5173",
        }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("dev-server-preview-fallback")).toBeInTheDocument();
    expect(screen.getByText(/Preview cannot be embedded/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows open in new tab button when preview URL exists", () => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        serverState: createState({
          status: "running",
          previewUrl: "http://localhost:5173",
        }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-open-preview")).toBeInTheDocument();
  });

  it("shows empty-state message when no candidates and server is stopped", () => {
    mockUseDevServer.mockReturnValue(
      createHookState({
        candidates: [],
        serverState: createState({ status: "stopped" }),
      }),
    );

    render(<DevServerView addToast={addToast} projectId="project-a" />);

    expect(screen.getByTestId("dev-server-empty-candidates")).toHaveTextContent(
      "No dev server scripts detected.",
    );
  });
});

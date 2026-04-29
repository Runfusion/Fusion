import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings, Task } from "@fusion/core";
import { RoutingTab } from "../RoutingTab";
import * as api from "../../api";

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x" />,
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof api>("../../api");
  return {
    ...actual,
    fetchNodes: vi.fn(),
    updateTask: vi.fn(),
  };
});

const mockFetchNodes = api.fetchNodes as ReturnType<typeof vi.fn>;
const mockUpdateTask = api.updateTask as ReturnType<typeof vi.fn>;

const MOCK_NODES = [
  {
    id: "node-a",
    name: "Alpha",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "node-b",
    name: "Beta",
    type: "remote",
    status: "offline",
    maxConcurrent: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "node-c",
    name: "Gamma",
    type: "remote",
    status: "connecting",
    maxConcurrent: 6,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "node-d",
    name: "Delta",
    type: "remote",
    status: "error",
    maxConcurrent: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    description: "Routing test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type RoutingSettings = Settings & {
  defaultNodeId?: string;
  unavailableNodePolicy?: "block" | "fallback-local";
};

function makeSettings(overrides: Partial<RoutingSettings> = {}): RoutingSettings {
  return {
    maxConcurrent: 2,
    maxWorktrees: 2,
    pollIntervalMs: 10000,
    groupOverlappingFiles: false,
    autoMerge: true,
    ...overrides,
  };
}

describe("RoutingTab", () => {
  const addToast = vi.fn();
  const onTaskUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNodes.mockResolvedValue(MOCK_NODES);
    mockUpdateTask.mockImplementation(async (_id: string, updates: { nodeId?: string | null }) =>
      makeTask({ nodeId: updates.nodeId ?? undefined }),
    );
  });

  it("renders loading state initially by disabling selector while nodes are loading", async () => {
    mockFetchNodes.mockReturnValue(new Promise(() => {}));

    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(screen.getByLabelText("Select execution node")).toBeDisabled();
  });

  it("renders routing summary after loading", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Routing Summary")).toBeInTheDocument();
    expect(screen.getByText("Effective node")).toBeInTheDocument();
    expect(screen.getByText("Routing source")).toBeInTheDocument();
  });

  it("renders routing source as per-task override", async () => {
    render(
      <RoutingTab task={makeTask({ nodeId: "node-a" })} settings={makeSettings({ defaultNodeId: "node-b" })} addToast={addToast} />,
    );

    expect(await screen.findByText("Per-task override")).toBeInTheDocument();
    expect(screen.getByText(/Effective node/i)).toBeInTheDocument();
    expect(screen.getAllByText("Alpha (local)")[0]).toBeInTheDocument();
    expect(document.querySelector(".status-dot--online")).toBeInTheDocument();
  });

  it("renders routing source as project default", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings({ defaultNodeId: "node-b" })} addToast={addToast} />);

    expect(await screen.findByText("Project default")).toBeInTheDocument();
  });

  it("renders routing source as no routing when no override or project default exists", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("No routing")).toBeInTheDocument();
  });

  it("displays effective node for per-task override", async () => {
    render(<RoutingTab task={makeTask({ nodeId: "node-a" })} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Alpha (local)")).toBeInTheDocument();
  });

  it("displays effective node for project default", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings({ defaultNodeId: "node-b" })} addToast={addToast} />);

    expect(await screen.findByText("Beta (remote)")).toBeInTheDocument();
  });

  it("displays unknown effective node ID gracefully when node is unavailable", async () => {
    render(<RoutingTab task={makeTask({ nodeId: "unknown-node" })} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("unknown-node (node unavailable or unknown)")).toBeInTheDocument();
  });

  it("node override selector shows available nodes", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByRole("option", { name: "Alpha (local) — online" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beta (remote) — offline" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gamma (remote) — connecting" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Delta (remote) — error" })).toBeInTheDocument();
  });

  it("renders routing summary with project default", async () => {
    render(
      <RoutingTab
        task={makeTask()}
        settings={makeSettings({ defaultNodeId: "node-b" })}
        addToast={addToast}
      />,
    );

    expect(await screen.findByText("Project default")).toBeInTheDocument();
    expect(screen.getByText(/Effective node/i)).toBeInTheDocument();
    expect(screen.getByText("Unhealthy")).toBeInTheDocument();
  });

  it("renders NodeHealthDot in routing summary for effective node", async () => {
    render(
      <RoutingTab
        task={makeTask({ nodeId: "node-a" })}
        settings={makeSettings()}
        addToast={addToast}
      />,
    );

    await screen.findByText("Alpha (local)");
    expect(document.querySelector(".status-dot--online")).toBeInTheDocument();
  });

  it("renders NodeHealthDot and Unhealthy badge for offline effective node", async () => {
    render(
      <RoutingTab
        task={makeTask()}
        settings={makeSettings({ defaultNodeId: "node-b" })}
        addToast={addToast}
      />,
    );

    await screen.findByText("Unhealthy");
    expect(document.querySelector(".status-dot--offline")).toBeInTheDocument();
  });

  it("renders no-routing summary when no override or project default exists", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Local (no routing configured)")).toBeInTheDocument();
    expect(screen.getByText("No routing")).toBeInTheDocument();
  });

  it("disables node selector for in-progress tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "in-progress" })} settings={makeSettings()} addToast={addToast} />);

    const selector = await screen.findByLabelText("Select execution node");
    expect(selector).toBeDisabled();
    expect(screen.getByText("Node override cannot be changed while the task is active.")).toBeInTheDocument();
  });

  it("disables node selector for active task statuses", async () => {
    render(<RoutingTab task={makeTask({ column: "todo", status: "executing" })} settings={makeSettings()} addToast={addToast} />);

    const selector = await screen.findByLabelText("Select execution node");
    expect(selector).toBeDisabled();
    expect(screen.getByText("Node override cannot be changed while the task is active.")).toBeInTheDocument();
  });

  it("enables node selector for non-active tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "todo", status: "pending" })} settings={makeSettings()} addToast={addToast} />);

    const selector = await screen.findByLabelText("Select execution node");
    await waitFor(() => {
      expect(selector).toBeEnabled();
    });
  });

  it("selecting a node calls updateTask with selected nodeId and success toast", async () => {
    const user = userEvent.setup();

    render(
      <RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} onTaskUpdated={onTaskUpdated} />,
    );

    const selector = await screen.findByLabelText("Select execution node");
    await user.selectOptions(selector, "node-a");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ nodeId: "node-a" }));
      expect(addToast).toHaveBeenCalledWith("Node override updated", "success");
    });
  });

  it("clear override button calls updateTask with nodeId null", async () => {
    const user = userEvent.setup();

    render(<RoutingTab task={makeTask({ nodeId: "node-a" })} settings={makeSettings()} addToast={addToast} />);

    await user.click(await screen.findByRole("button", { name: "Clear override" }));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ nodeId: null }));
    });
  });

  it.each([
    ["block", "Block execution"],
    ["fallback-local", "Fall back to local"],
  ] as const)("displays unavailable-node policy: %s", async (policy, label) => {
    render(<RoutingTab task={makeTask()} settings={makeSettings({ unavailableNodePolicy: policy })} addToast={addToast} />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("displays unavailable-node policy as not configured when omitted", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("shows error state when fetchNodes fails", async () => {
    mockFetchNodes.mockRejectedValue(new Error("Failed to load nodes from API"));

    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Failed to load nodes from API")).toBeInTheDocument();
  });

  it("calls onTaskUpdated callback after successful update", async () => {
    const updated = makeTask({ nodeId: "node-c" });
    mockUpdateTask.mockResolvedValueOnce(updated);
    const user = userEvent.setup();

    render(
      <RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} onTaskUpdated={onTaskUpdated} />,
    );

    await user.selectOptions(await screen.findByLabelText("Select execution node"), "node-c");

    await waitFor(() => {
      expect(onTaskUpdated).toHaveBeenCalledWith(updated);
    });
  });

  it("shows error toast when updateTask fails", async () => {
    mockUpdateTask.mockRejectedValueOnce(new Error("Save failed"));
    const user = userEvent.setup();

    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    await user.selectOptions(await screen.findByLabelText("Select execution node"), "node-a");

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Save failed", "error");
    });
  });
});

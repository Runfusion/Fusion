import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings, Task } from "@fusion/core";
import { RoutingTab } from "../RoutingTab";
import * as api from "../../api";

vi.mock("lucide-react", () => ({}));

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
    mockFetchNodes.mockResolvedValue([
      { id: "node-a", name: "Alpha", type: "local", status: "online" },
      { id: "node-b", name: "Beta", type: "remote", status: "offline" },
    ]);
    mockUpdateTask.mockImplementation(async (_id: string, updates: { nodeId?: string | null }) => {
      return makeTask({ nodeId: updates.nodeId ?? undefined });
    });
  });

  it("renders routing summary with per-task override", async () => {
    render(
      <RoutingTab
        task={makeTask({ nodeId: "node-a" })}
        settings={makeSettings({ defaultNodeId: "node-b" })}
        addToast={addToast}
      />,
    );

    expect(await screen.findByText("Per-task override")).toBeInTheDocument();
    expect(screen.getByText(/Effective node/i)).toBeInTheDocument();
  });

  it("renders routing summary with project default", async () => {
    render(
      <RoutingTab
        task={makeTask()}
        settings={makeSettings({ defaultNodeId: "node-a" })}
        addToast={addToast}
      />,
    );

    expect(await screen.findByText("Project default")).toBeInTheDocument();
    expect(screen.getByText(/Effective node/i)).toBeInTheDocument();
  });

  it("renders no-routing summary when no override or project default exists", async () => {
    render(<RoutingTab task={makeTask()} settings={makeSettings()} addToast={addToast} />);

    expect(await screen.findByText("Local (no routing configured)")).toBeInTheDocument();
    expect(screen.getByText("No routing")).toBeInTheDocument();
  });

  it.each([
    ["block", "Block execution"],
    ["fallback-local", "Fall back to local"],
  ] as const)("displays unavailable-node policy: %s", async (policy, label) => {
    render(
      <RoutingTab
        task={makeTask()}
        settings={makeSettings({ unavailableNodePolicy: policy })}
        addToast={addToast}
      />,
    );

    await screen.findByText(label);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("disables node selector for in-progress tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "in-progress" })} settings={makeSettings()} addToast={addToast} />);

    const selector = await screen.findByLabelText("Select execution node");
    expect(selector).toBeDisabled();
    expect(screen.getByText("Node override cannot be changed while the task is in progress.")).toBeInTheDocument();
  });

  it("enables node selector for non-in-progress tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "todo" })} settings={makeSettings()} addToast={addToast} />);

    const selector = await screen.findByLabelText("Select execution node");
    expect(selector).toBeEnabled();
  });

  it("calls updateTask when node selected", async () => {
    const user = userEvent.setup();
    render(
      <RoutingTab
        task={makeTask({ column: "todo" })}
        settings={makeSettings()}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    const selector = await screen.findByLabelText("Select execution node");
    await user.selectOptions(selector, "node-a");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { nodeId: "node-a" });
    });
  });

  it("shows clear override button and clears node override", async () => {
    const user = userEvent.setup();
    render(
      <RoutingTab
        task={makeTask({ nodeId: "node-a" })}
        settings={makeSettings()}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    const clearButton = await screen.findByRole("button", { name: "Clear override" });
    await user.click(clearButton);

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { nodeId: null });
    });
  });
});

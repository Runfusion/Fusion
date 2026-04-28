import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Settings, Task } from "@fusion/core";
import * as api from "../../api";
import { RoutingTab } from "../RoutingTab";

vi.mock("lucide-react", () => ({}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof api>("../../api");
  return {
    ...actual,
    fetchNodes: vi.fn(),
    updateTask: vi.fn(),
  };
});

vi.mock("../ProjectNodeSelector", () => ({
  ProjectNodeSelector: (props: any) => (
    <div data-testid="node-selector" data-disabled={String(Boolean(props.disabled))}>
      <button type="button" onClick={() => props.onSelect("node-2")}>select-node-2</button>
      <button type="button" onClick={() => props.onSelect(null)}>select-none</button>
    </div>
  ),
}));

const mockFetchNodes = api.fetchNodes as ReturnType<typeof vi.fn>;
const mockUpdateTask = api.updateTask as ReturnType<typeof vi.fn>;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-2845",
    description: "routing test",
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

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxConcurrent: 1,
    maxWorktrees: 1,
    pollIntervalMs: 1000,
    autoMerge: false,
    groupOverlappingFiles: false,
    ...overrides,
  };
}

describe("RoutingTab", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNodes.mockResolvedValue([
      { id: "node-1", name: "Worker Alpha", type: "remote", status: "online", maxConcurrent: 5, createdAt: "", updatedAt: "" },
      { id: "node-2", name: "Worker Beta", type: "remote", status: "online", maxConcurrent: 5, createdAt: "", updatedAt: "" },
    ]);
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => makeTask(updates as Partial<Task>));
  });

  it("renders routing summary with per-task override", async () => {
    render(<RoutingTab task={makeTask({ nodeId: "node-1" })} addToast={addToast} settings={makeSettings()} />);
    await screen.findByText("Worker Alpha");
    expect(screen.getByText("Per-task override")).toBeInTheDocument();
  });

  it("renders routing summary with project default", async () => {
    render(<RoutingTab task={makeTask()} addToast={addToast} settings={makeSettings({ defaultNodeId: "node-2" })} />);
    await screen.findByText("Worker Beta (project default)");
    expect(screen.getByText("Project default")).toBeInTheDocument();
  });

  it("renders routing summary with no routing", async () => {
    render(<RoutingTab task={makeTask()} addToast={addToast} settings={makeSettings()} />);
    expect(await screen.findByText("Local (no routing configured)")).toBeInTheDocument();
    expect(screen.getByText("No routing")).toBeInTheDocument();
  });

  it.each([
    ["block", "Block execution"],
    ["fallback-local", "Fall back to local"],
  ])("displays unavailable-node policy %s", async (policy, text) => {
    render(<RoutingTab task={makeTask()} addToast={addToast} settings={makeSettings({ unavailableNodePolicy: policy as any })} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("disables selector and shows warning for in-progress tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "in-progress" })} addToast={addToast} settings={makeSettings()} />);
    await waitFor(() => expect(screen.getByTestId("node-selector")).toHaveAttribute("data-disabled", "true"));
    expect(screen.getByText(/Node override cannot be changed while the task is in progress/i)).toBeInTheDocument();
  });

  it("enables selector for non-in-progress tasks", async () => {
    render(<RoutingTab task={makeTask({ column: "todo" })} addToast={addToast} settings={makeSettings()} />);
    await waitFor(() => expect(screen.getByTestId("node-selector")).toHaveAttribute("data-disabled", "false"));
    expect(screen.queryByText(/Node override cannot be changed/i)).not.toBeInTheDocument();
  });

  it("calls updateTask when node selected", async () => {
    render(<RoutingTab task={makeTask()} addToast={addToast} settings={makeSettings()} />);
    fireEvent.click(await screen.findByText("select-node-2"));
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("FN-2845", { nodeId: "node-2" }));
  });

  it("shows clear override button and clears override", async () => {
    render(<RoutingTab task={makeTask({ nodeId: "node-1", column: "todo" })} addToast={addToast} settings={makeSettings()} />);
    const button = await screen.findByRole("button", { name: "Clear override" });
    fireEvent.click(button);
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("FN-2845", { nodeId: null }));
  });

  it("hides clear override button for in-progress tasks", () => {
    render(<RoutingTab task={makeTask({ nodeId: "node-1", column: "in-progress" })} addToast={addToast} settings={makeSettings()} />);
    expect(screen.queryByRole("button", { name: "Clear override" })).not.toBeInTheDocument();
  });

  it("shows unknown node IDs as raw id", async () => {
    render(<RoutingTab task={makeTask({ nodeId: "ghost-node" })} addToast={addToast} settings={makeSettings()} />);
    expect(await screen.findByText("ghost-node (unknown node)")).toBeInTheDocument();
  });
});

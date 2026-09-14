import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { AgentsView } from "../AgentsView";
import { AgentListModal } from "../AgentListModal";
import { ToastProvider } from "../../hooks/useToast";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import * as apiModule from "../../api";
import type { Agent, AgentCapability, AgentState } from "../../api";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the Agents family through the real destination rather than a source scan: the collection rail stays
mounted across list/board/org, creation exists exactly once in the shared header, and the phone presentation hands
the screen to the detail only after an explicit selection, returning through the canonical chevron.
*/

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn(),
    fetchAgentStats: vi.fn().mockResolvedValue({}),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    updateAgentState: vi.fn(),
    deleteAgent: vi.fn(),
    startAgentRun: vi.fn(),
    fetchOrgTree: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue({ models: [] }),
    fetchPluginRuntimes: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  });
});

vi.mock("../AgentDetailView", () => ({
  AgentDetailView: ({ agentId }: { agentId: string }) => (
    <div data-testid="agent-detail-view">Agent detail: {agentId}</div>
  ),
  relativeTime: () => "just now",
}));

const mockViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => mockViewportMode(),
}));

vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);

function agent(id: string, name: string, role: AgentCapability = "executor", state: AgentState = "idle"): Agent {
  return {
    id,
    name,
    role,
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  } as Agent;
}

function renderView(ui: ReactElement) {
  return render(
    <ViewLayoutProvider projectId="proj_agents">
      <ToastProvider>{ui}</ToastProvider>
    </ViewLayoutProvider>,
  );
}

async function renderAgents(agents: Agent[]) {
  mockFetchAgents.mockResolvedValue(agents);
  const view = renderView(<AgentsView addToast={vi.fn()} projectId="proj_agents" />);
  await waitFor(() => expect(mockFetchAgents).toHaveBeenCalled());
  return view;
}

describe("FN-379 standardized Agents layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockViewportMode.mockReturnValue("desktop");
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });

  /*
  The org representation is itself the agent collection canvas, so it keeps the shared header while the rail
  would only duplicate the same objects. List and board keep the canonical rail mounted.
  */
  it("keeps the shared collection rail mounted across list and board, and the shared header everywhere", async () => {
    await renderAgents([agent("agent-1", "Alpha"), agent("agent-2", "Beta")]);

    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Board view" }));
    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));
    await waitFor(() => expect(apiModule.fetchOrgTree).toHaveBeenCalled());
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByTestId("agents-new-agent")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
  });

  it("owns exactly one canonical creation entry, and it lives in the shared header", async () => {
    await renderAgents([agent("agent-1", "Alpha")]);

    const creates = screen.getAllByTestId("agents-new-agent");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toHaveClass("view-action-button--create");
    expect(within(screen.getByRole("banner")).getByTestId("agents-new-agent")).toBe(creates[0]);
  });

  it("keeps the rail mounted and creation available while the create form occupies detail", async () => {
    await renderAgents([agent("agent-1", "Alpha")]);

    fireEvent.click(screen.getByTestId("agents-new-agent"));
    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("agents-new-agent")).toBeInTheDocument();
    expect(apiModule.createAgent).not.toHaveBeenCalled();
  });

  it("renders an empty collection without losing the rail or duplicating creation", async () => {
    await renderAgents([]);

    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
    expect(screen.getAllByTestId("agents-new-agent")).toHaveLength(1);
  });

  it("performs no mutation while merely mounting the destination", async () => {
    await renderAgents([agent("agent-1", "Alpha")]);

    expect(apiModule.createAgent).not.toHaveBeenCalled();
    expect(apiModule.updateAgent).not.toHaveBeenCalled();
    expect(apiModule.deleteAgent).not.toHaveBeenCalled();
    expect(apiModule.startAgentRun).not.toHaveBeenCalled();
  });

  it("starts the phone presentation on the collection and opens detail only after a selection", async () => {
    mockViewportMode.mockReturnValue("mobile");
    await renderAgents([agent("agent-1", "Alpha")]);

    expect(screen.queryByTestId("agent-detail-view")).toBeNull();
    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(screen.getByTestId("agent-detail-view")).toBeInTheDocument());

    const back = screen.getByTestId("agents-detail-back");
    expect(back).toHaveClass("view-back-button");
    expect(within(screen.getByRole("banner")).getByTestId("agents-detail-back")).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByTestId("agent-detail-view")).toBeNull());
  });

  it("keeps a late agent refresh from resurrecting a removed selection", async () => {
    mockViewportMode.mockReturnValue("desktop");
    await renderAgents([agent("agent-1", "Alpha"), agent("agent-2", "Beta")]);

    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(screen.getByTestId("agent-detail-view")).toBeInTheDocument());

    mockFetchAgents.mockResolvedValue([agent("agent-2", "Beta")]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByTestId("agents-split-sidebar")).toBeInTheDocument();
  });

  it("keeps the Agents picker window single-headed without becoming a second destination", async () => {
    mockFetchAgents.mockResolvedValue([agent("agent-1", "Alpha")]);
    renderView(
      <AgentListModal isOpen onClose={vi.fn()} onSelectAgent={vi.fn()} projectId="proj_agents" />,
    );
    await waitFor(() => expect(mockFetchAgents).toHaveBeenCalled());
    /*
    FNXC:StandardizedViewLayout 2026-09-13-21:49:
    The picker window now builds that single header with the shared primitive, so single-headedness is asserted on
    the canonical header itself rather than on the absence of a header element.
    */
    expect(document.querySelectorAll(".agent-list-modal .modal-header")).toHaveLength(1);
    expect(document.querySelectorAll(".agent-list-modal .view-header")).toHaveLength(1);
    expect(screen.queryAllByRole("banner")).toHaveLength(1);
  });
});

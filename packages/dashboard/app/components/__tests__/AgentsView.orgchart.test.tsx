import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";

const mockViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  useViewportMode: () => mockViewportMode(),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../AgentDetailView", () => ({ AgentDetailView: () => null, relativeTime: () => "now" }));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgentStats: vi.fn().mockResolvedValue({ total: 0, byState: {}, byRole: {} }),
    fetchOrgTree: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
  });
});

const mockFetchOrgTree = vi.mocked((apiModule as any).fetchOrgTree);
const mockFetchAgents = vi.mocked((apiModule as any).fetchAgents);

const orgTree = [{ agent: { id: "ceo", name: "CEO", role: "scheduler", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [
  { agent: { id: "cto", name: "CTO", role: "engineer", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [
    { agent: { id: "eng-a", name: "Eng A", role: "executor", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] },
    { agent: { id: "eng-b", name: "Eng B", role: "executor", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [{ agent: { id: "eng-c", name: "Eng C", role: "reviewer", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] }] },
  ] },
] }, { agent: { id: "cfo", name: "CFO", role: "triage", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] }];

function mockRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const el = this as HTMLElement;
    if (el.classList.contains("agent-org-chart-viewport")) return { left: 0, top: 0, width: 400, height: 280, right: 400, bottom: 280, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    if (el.classList.contains("agent-org-chart")) return { left: 0, top: 0, width: 700, height: 500, right: 700, bottom: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const id = el.getAttribute("data-agent-id");
    const map: Record<string, DOMRect> = {
      ceo: { left: 200, top: 20, width: 140, height: 80, right: 340, bottom: 100, x: 200, y: 20, toJSON: () => ({}) } as DOMRect,
      cto: { left: 120, top: 180, width: 140, height: 80, right: 260, bottom: 260, x: 120, y: 180, toJSON: () => ({}) } as DOMRect,
      cfo: { left: 360, top: 180, width: 140, height: 80, right: 500, bottom: 260, x: 360, y: 180, toJSON: () => ({}) } as DOMRect,
      "eng-a": { left: 40, top: 340, width: 140, height: 80, right: 180, bottom: 420, x: 40, y: 340, toJSON: () => ({}) } as DOMRect,
      "eng-b": { left: 200, top: 340, width: 140, height: 80, right: 340, bottom: 420, x: 200, y: 340, toJSON: () => ({}) } as DOMRect,
      "eng-c": { left: 220, top: 500, width: 140, height: 80, right: 360, bottom: 580, x: 220, y: 500, toJSON: () => ({}) } as DOMRect,
    };
    return map[id ?? ""] ?? ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  });
}

describe("AgentsView org chart interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    mockFetchAgents.mockResolvedValue([]);
    mockFetchOrgTree.mockResolvedValue(orgTree);
    mockRects();
  });

  it("renders controls and supports transform interactions", async () => {
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await screen.findByTestId("agent-org-chart-controls");
    expect(screen.getByLabelText("Horizontal layout")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit org chart")).toBeInTheDocument();
    const canvas = screen.getByTestId("agent-org-chart-viewport").querySelector(".agent-org-chart-canvas") as HTMLDivElement;
    const zoomLabel = screen.getByText(/%/);
    fireEvent.click(screen.getByLabelText("Zoom in org chart"));
    expect(zoomLabel.textContent).not.toBe("100%");
    expect(canvas.style.transform).toMatch(/scale\(/);
    fireEvent.click(screen.getByLabelText("Fit org chart"));
    expect(canvas.style.transform).not.toContain("translate(0px, 0px) scale(1)");

    const viewport = screen.getByTestId("agent-org-chart-viewport");
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 90 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 80, clientY: 90 });
    expect(canvas.style.transform).toContain("translate(");

    const card = document.querySelector('.org-chart-node-card[data-agent-id="ceo"]') as HTMLElement;
    const before = canvas.style.transform;
    fireEvent.pointerDown(card, { pointerId: 2, clientX: 220, clientY: 40 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 280, clientY: 120 });
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 280, clientY: 120 });
    expect(canvas.style.transform).toBe(before);

    const scaleBefore = canvas.style.transform;
    fireEvent.pointerDown(viewport, { pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerDown(viewport, { pointerId: 4, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(viewport, { pointerId: 4, clientX: 180, clientY: 180 });
    fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 4, clientX: 180, clientY: 180 });
    expect(canvas.style.transform).not.toBe(scaleBefore);

    viewport.focus();
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });
    fireEvent.keyDown(viewport, { key: "-" });
    fireEvent.keyDown(viewport, { key: "0" });
    fireEvent.keyDown(viewport, { key: "Home" });
    expect(canvas.style.transform).toContain("scale(1)");

    await waitFor(() => {
      const paths = document.querySelectorAll(".agent-org-chart-connectors path");
      expect(paths.length).toBe(4);
      expect(paths[0].getAttribute("d")).toContain("L");
    });

    fireEvent.click(screen.getByLabelText("Vertical layout"));
    await waitFor(() => {
      const firstPath = document.querySelector(".agent-org-chart-connectors path")?.getAttribute("d") ?? "";
      expect(firstPath).toMatch(/^M\s\d+\s\d+\sL\s\d+\s\d+/);
    });
  });

  it("renders mobile controls", async () => {
    mockViewportMode.mockReturnValue("mobile");
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    expect(await screen.findByTestId("agent-org-chart-controls")).toBeInTheDocument();
    expect(screen.getByLabelText("Center org chart")).toBeInTheDocument();
  });
});

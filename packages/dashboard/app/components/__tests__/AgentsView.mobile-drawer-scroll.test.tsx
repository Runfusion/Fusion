import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { listComponentFiles, loadAllAppCss, readAppFile } from "../../test/cssFixture";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { ToastProvider } from "../../hooks/useToast";
import { MainContentDrawer } from "../dashboard/MainContent";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import type { Agent, AgentCapability, AgentState } from "../../api";

/*
FN-502 symptom verification. The operator could no longer scroll the Agents list inside the phone drawer.

Root cause: `AgentsView` passes `agents-split-sidebar` as `ViewSidebar`'s `className`, so the rule styled the OUTER
`.view-sidebar` box, where `flex-direction: column` removed the cross-axis stretch that gives
`aside.view-sidebar__panel` (`flex: none`) its height. `.agents-view-content` therefore had no bounded height, its
`overflow-y: auto` never engaged, and the rail's `overflow: hidden` clipped the rest.

These cases mount the REAL destination (and, from Step 2 on, the production `MainContentDrawer` composition) with the
real application CSS loaded, then resolve computed style over the whole ancestor chain, exactly like
`FilesView.mobile-drawer.test.tsx` (FN-445/FN-462) and
docs/solutions/ui-bugs/mobile-touch-action-ancestor-intersection-defeats-leaf-scroll.md.
*/

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn(),
    fetchAgentStats: vi.fn().mockResolvedValue({}),
    fetchOrgTree: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue({ models: [] }),
    fetchPluginRuntimes: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  });
});

/*
The agent detail pane is lazy and API-heavy, so it is replaced by a marker here. The detail branch is proven two
ways instead: the host box (`.agents-split-detail`) is asserted on the real rendered chain, and the detail's own
bounded scroller is asserted as a CSS contract on `AgentDetailView.css`.
*/
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

const manyAgents: Agent[] = Array.from({ length: 30 }, (_, index) =>
  agent(`agent-${String(index).padStart(2, "0")}`, `Agent ${String(index).padStart(2, "0")}`));

function setPhone({ drawers = false }: { drawers?: boolean } = {}) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
  document.documentElement.dataset.viewportMode = "mobile";
  if (drawers) document.documentElement.dataset.mobileDrawers = "true";
  else delete document.documentElement.dataset.mobileDrawers;
  mockViewportMode.mockReturnValue("mobile");
}

function setDesktop() {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  delete document.documentElement.dataset.viewportMode;
  delete document.documentElement.dataset.mobileDrawers;
  mockViewportMode.mockReturnValue("desktop");
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

/** The production phone composition: MainContentDrawer -> AgentsView, exactly as MainContent mounts it. */
async function renderAgentsDrawer(agents: Agent[] = manyAgents) {
  mockFetchAgents.mockResolvedValue(agents);
  const view = renderView(
    <MainContentDrawer taskView="agents" open title="Agents" onClose={vi.fn()}>
      <AgentsView addToast={vi.fn()} projectId="proj_agents" />
    </MainContentDrawer>,
  );
  await waitFor(() => expect(mockFetchAgents).toHaveBeenCalled());
  return view;
}

/** Every box from a leaf up to (and including) the box carrying `stopClass`, or the rendered root. */
function ancestorChain(leafSelector: string, stopClass = "view-layout"): HTMLElement[] {
  const leaf = document.querySelector<HTMLElement>(leafSelector);
  if (!leaf) throw new Error(`missing leaf for ${leafSelector}`);
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = leaf;
  while (node) {
    chain.push(node);
    if (node.classList.contains(stopClass)) break;
    node = node.parentElement;
  }
  return chain;
}

function describeNode(node: HTMLElement): string {
  return `${node.tagName.toLowerCase()}.${Array.from(node.classList).join(".")}`;
}

/*
 * jsdom does not expand the `overflow` shorthand into `overflow-y`, so reading `overflowY` alone reports `visible`
 * for a box that really scrolls and would silently turn the single-scroll-owner gate into a no-op.
 */
function verticalOverflow(node: HTMLElement): string {
  const style = getComputedStyle(node);
  if (style.overflowY && style.overflowY !== "visible") return style.overflowY;
  return style.overflow || "visible";
}

function scrollers(chain: HTMLElement[]): HTMLElement[] {
  return chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
}

function unboundedBoxes(chain: HTMLElement[]): string[] {
  return chain
    .filter((node) => getComputedStyle(node).minHeight !== "0px")
    .map((node) => `${describeNode(node)} -> ${getComputedStyle(node).minHeight || "<unset>"}`);
}

function cssRuleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(css)) !== null) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  return bodies;
}

describe("Agents destination scroll chain (FN-502)", () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setDesktop();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    styleEl.remove();
    setDesktop();
  });

  describe("the rail no longer flips the shared ViewSidebar container into a column", () => {
    it("resolves a row direction on the .view-sidebar box that carries .agents-split-sidebar, on a phone", async () => {
      setPhone();
      await renderAgents(manyAgents);

      const railBox = document.querySelector<HTMLElement>(".view-sidebar.agents-split-sidebar")!;
      expect(railBox).not.toBeNull();
      expect(getComputedStyle(railBox).flexDirection).not.toBe("column");
    });

    it("keeps a desktop rail inline with its resize separator", async () => {
      setDesktop();
      await renderAgents(manyAgents);

      const railBox = document.querySelector<HTMLElement>(".view-sidebar.agents-split-sidebar")!;
      expect(getComputedStyle(railBox).flexDirection).not.toBe("column");
      expect(screen.getByTestId("agents-sidebar-resize-handle")).toBeInTheDocument();
      expect(screen.getByTestId("agents-sidebar-resize-handle").parentElement).toBe(railBox);
    });

    /*
     * The defect was a HOST argument (`className` vs `panelClassName`), not a primitive defect, so every rail host is
     * scanned for the same shape rather than patching `ViewSidebar` itself. A host MAY use a column direction, but
     * only if it also makes `aside.view-sidebar__panel` shrinkable inside itself: the primitive declares `flex: none`,
     * and on the main axis that makes the panel as tall as its content (measured and documented by FN-479 in
     * `FileBrowser.css`, which is why `.file-browser-sidebar` is conformant).
     *
     * `.research-view__sidebar` carries the same unbounded shape today. Repairing another destination is explicitly
     * outside FN-502's scope, so it is pinned here as a KNOWN exception: the assertion still fails the moment a NEW
     * host joins it, and it fails if Research is fixed without updating this list.
     */
    it("lets no ViewSidebar host leave its panel unbounded in a column direction", () => {
      const css = loadAllAppCss();
      const knownUnbounded = [".research-view__sidebar"];
      const unbounded: string[] = [];

      for (const file of listComponentFiles()) {
        const source = readAppFile(`components/${file}`);
        if (!source.includes("<ViewSidebar")) continue;
        for (const segment of source.split("<ViewSidebar").slice(1)) {
          const head = segment.slice(0, segment.indexOf(">"));
          const classNameMatch = /className=\{?[`"']([^`"']*)/.exec(head);
          if (!classNameMatch) continue;
          for (const token of classNameMatch[1].split(/[\s${}]+/).filter(Boolean)) {
            const declaresColumn = cssRuleBodies(css, `.${token}`).some((body) => body.includes("flex-direction: column"));
            if (!declaresColumn) continue;
            const boundsPanel = new RegExp(`\\.${token}[^{}]*panel[^{}]*\\{[^{}]*flex:\\s*1`).test(css);
            if (!boundsPanel) unbounded.push(`.${token}`);
          }
        }
      }

      expect(cssRuleBodies(css, ".agents-split-sidebar").join("\n")).not.toContain("flex-direction: column");
      expect([...new Set(unbounded)].sort()).toEqual(knownUnbounded);
    });
  });

  describe("single bounded scroll owner on a phone", () => {
    it.each([
      ["a long populated list", async () => { await renderAgents(manyAgents); }, ".agents-view-content"],
      ["an empty list", async () => { await renderAgents([]); }, ".agents-view-content"],
    ])("keeps one scroll owner for %s", async (_label, mount, leafSelector) => {
      setPhone();
      await mount();

      const chain = ancestorChain(leafSelector);
      expect(scrollers(chain).map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(chain[0].classList.contains("agents-view-content")).toBe(true);
      expect(unboundedBoxes(chain)).toEqual([]);
    });

    it("keeps one scroll owner while the initial agent load is pending", async () => {
      setPhone();
      mockFetchAgents.mockReturnValue(new Promise<Agent[]>(() => {}));
      renderView(<AgentsView addToast={vi.fn()} projectId="proj_agents" />);

      await screen.findByRole("status");
      expect(document.querySelector(".agents-view-loading")).not.toBeNull();

      const chain = ancestorChain(".agents-view-content");
      expect(scrollers(chain).map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(unboundedBoxes(chain)).toEqual([]);
    });

    it("keeps one scroll owner in board view", async () => {
      setPhone();
      await renderAgents(manyAgents);
      fireEvent.click(screen.getByRole("button", { name: "Board view" }));

      expect(document.querySelector(".agent-board")).not.toBeNull();
      const chain = ancestorChain(".agents-view-content");
      expect(scrollers(chain).map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(unboundedBoxes(chain)).toEqual([]);
    });

    /*
     * Org chart is the one branch with a legitimate nested scroller: the canvas viewport pans in TWO axes inside the
     * page content. The invariant is therefore that nothing ABOVE `.agents-view-content` competes for the gesture.
     */
    it("keeps the org chart canvas as the only nested scroller", async () => {
      setPhone();
      await renderAgents(manyAgents);
      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));
      await waitFor(() => expect(apiModule.fetchOrgTree).toHaveBeenCalled());

      const chain = ancestorChain(".agent-org-chart-viewport");
      const owners = scrollers(chain);
      for (const owner of owners) {
        expect(
          owner.classList.contains("agent-org-chart-viewport") || owner.classList.contains("agents-view-content"),
        ).toBe(true);
      }
      const aboveContent = chain.slice(chain.findIndex((node) => node.classList.contains("agents-view-content")) + 1);
      expect(scrollers(aboveContent)).toEqual([]);
      expect(unboundedBoxes(chain)).toEqual([]);
    });

    it("bounds the page on a phone without the drawer opt-in too", async () => {
      setPhone({ drawers: false });
      await renderAgents(manyAgents);

      const chain = ancestorChain(".agents-view-content");
      expect(scrollers(chain).map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(unboundedBoxes(chain)).toEqual([]);
    });

    it("bounds the detail pane host and defers scrolling to the detail's own scroller", async () => {
      setPhone();
      await renderAgents(manyAgents);
      fireEvent.click(screen.getByText("Agent 03"));
      await screen.findByTestId("agent-detail-view");

      const chain = ancestorChain(".agents-split-detail");
      expect(scrollers(chain)).toEqual([]);
      expect(unboundedBoxes(chain)).toEqual([]);

      const css = loadAllAppCss();
      const detailContent = cssRuleBodies(css, ".agent-detail-content").join("\n");
      expect(detailContent).toContain("flex: 1");
      expect(detailContent).toContain("min-height: 0");
      expect(detailContent).toContain("overflow-y: auto");
      for (const shell of [".agent-detail-inline-shell", ".agent-detail-inline"]) {
        expect(cssRuleBodies(css, shell).join("\n")).toContain("min-height: 0");
      }
    });
  });

  /*
   * The reported symptom's host: the phone main drawer. `MainContentDrawer` must hand scroll ownership to the page,
   * otherwise the drawer body and `.agents-view-content` compete for the same vertical gesture.
   */
  describe("inside the production main mobile drawer", () => {
    it("marks the Agents drawer panel as content-owned scroll", async () => {
      setPhone({ drawers: true });
      await renderAgentsDrawer();

      const panel = document.querySelector<HTMLElement>(".mobile-drawer__panel")!;
      expect(panel.classList.contains("mobile-drawer__panel--content-scroll")).toBe(true);
      expect(verticalOverflow(document.querySelector<HTMLElement>(".mobile-drawer__body")!)).toBe("hidden");
    });

    it("keeps an ordinary destination on the scrollable drawer body", async () => {
      setPhone({ drawers: true });
      renderView(
        <MainContentDrawer taskView="memory" open title="Memory" onClose={vi.fn()}>
          <div className="memory-view">ordinary long view</div>
        </MainContentDrawer>,
      );

      const panel = document.querySelector<HTMLElement>(".mobile-drawer__panel")!;
      expect(panel.classList.contains("mobile-drawer__panel--content-scroll")).toBe(false);
      expect(verticalOverflow(document.querySelector<HTMLElement>(".mobile-drawer__body")!)).toBe("auto");
    });

    it("resolves exactly one vertical scroll owner from the agent list up to the drawer panel", async () => {
      setPhone({ drawers: true });
      await renderAgentsDrawer();
      expect(await screen.findByText("Agent 29")).toBeInTheDocument();

      const chain = ancestorChain(".agents-view-content", "mobile-drawer__panel");
      expect(chain.at(-1)!.classList.contains("mobile-drawer__panel")).toBe(true);
      expect(scrollers(chain).map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(chain[0].classList.contains("agents-view-content")).toBe(true);
    });

    it("resolves min-height: 0 on every box between the drawer panel and the agent list", async () => {
      setPhone({ drawers: true });
      await renderAgentsDrawer();

      expect(unboundedBoxes(ancestorChain(".agents-view-content", "mobile-drawer__panel"))).toEqual([]);
    });

    it("never resolves a column direction on the rail container inside the drawer", async () => {
      setPhone({ drawers: true });
      await renderAgentsDrawer();

      for (const node of ancestorChain(".agents-view-content", "mobile-drawer__panel")) {
        if (!node.classList.contains("view-sidebar")) continue;
        expect(`${describeNode(node)}:${getComputedStyle(node).flexDirection}`).not.toContain(":column");
      }
    });

    it("leaves vertical panning available on every ancestor of the agent list", async () => {
      setPhone({ drawers: true });
      await renderAgentsDrawer();

      for (const node of ancestorChain(".agents-view-content", "mobile-drawer__panel")) {
        const touchAction = getComputedStyle(node).touchAction;
        if (!touchAction) continue;
        expect(`${describeNode(node)}:${touchAction}`).toMatch(/:(auto|manipulation|pan-y|pan-x pan-y|pan-y pan-x)$/);
      }
    });
  });
});

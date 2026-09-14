import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { PluginDashboardViewHost } from "../../plugins/PluginDashboardViewHost";
import { PluginDashboardHostChromeContext } from "../../plugins/PluginDashboardViewHeader";
import { registerPluginView, __test_clearPluginViewRegistry } from "../../plugins/pluginViewRegistry";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { TodoView } from "../../../../../plugins/fusion-plugin-todos/src/dashboard/TodoView";
import { QualityDashboardView } from "../../../../../plugins/fusion-plugin-quality/src/dashboard-view";
import { LinearImportView } from "../../../../../plugins/fusion-plugin-linear-import/src/LinearImportView";
import { RoadmapsView } from "../../../../../plugins/fusion-plugin-roadmap/src/dashboard/RoadmapsView";
import { CompoundEngineeringView } from "../../../../../plugins/fusion-plugin-compound-engineering/src/dashboard/CompoundEngineeringView";
import { ReportsView } from "../../../../../plugins/fusion-plugin-reports/src/dashboard/ReportsView";
import { DependencyGraphDashboardView } from "../../../../../plugins/fusion-plugin-dependency-graph/src/dashboard-view";
import { CliPrintingPressWizardView } from "../../../../../plugins/fusion-plugin-cli-printing-press/src/dashboard-view";
import { lazy, type ReactElement } from "react";
import type { PluginDashboardViewContext } from "../../plugins/types";

/** Registers a synchronous component behind the registry's lazy contract. */
function registerView(pluginId: string, viewId: string, render: (props: { context?: PluginDashboardViewContext }) => ReactElement) {
  registerPluginView(pluginId, viewId, lazy(async () => ({ default: render })) as never);
}

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 proves the plugin families against their REAL components inside the host runner: each destination owns one
canonical header, creation exists exactly once (or legitimately not at all for a read-only view), and an empty
collection never grows a second call to action. The host contract itself is covered with a registered fake view so
a framing host, a drawer host, and an unregistered destination are all exercised.
*/

vi.mock("../../../../../plugins/fusion-plugin-reports/src/dashboard/api", () => ({
  listReports: vi.fn().mockResolvedValue([]),
  getReport: vi.fn().mockResolvedValue(null),
  getReportPreviewHtml: vi.fn().mockResolvedValue(""),
  getReportExportUrl: vi.fn().mockReturnValue(""),
  approveReport: vi.fn().mockResolvedValue(null),
  rejectReport: vi.fn().mockResolvedValue(null),
  publishReport: vi.fn().mockResolvedValue(null),
  getShareBlocks: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../../../plugins/fusion-plugin-roadmap/src/dashboard/api", () => ({
  fetchRoadmaps: vi.fn().mockResolvedValue([]),
  fetchRoadmap: vi.fn().mockResolvedValue(null),
  createRoadmap: vi.fn(),
  updateRoadmap: vi.fn(),
  deleteRoadmap: vi.fn(),
  createRoadmapMilestone: vi.fn(),
  updateRoadmapMilestone: vi.fn(),
  deleteRoadmapMilestone: vi.fn(),
  createRoadmapFeature: vi.fn(),
  updateRoadmapFeature: vi.fn(),
  deleteRoadmapFeature: vi.fn(),
  reorderRoadmapMilestones: vi.fn(),
  reorderRoadmapFeatures: vi.fn(),
  moveRoadmapFeature: vi.fn(),
  generateFeatureSuggestions: vi.fn(),
  generateMilestoneSuggestions: vi.fn(),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(routes: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => jsonResponse(routes(String(input))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("FN-379 standardized plugin destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    __test_clearPluginViewRegistry();
    vi.unstubAllGlobals();
  });

  describe("Todos", () => {
    it("owns one canonical list creation in the shared header on desktop", async () => {
      installFetch(() => ({ lists: [{ id: "list-1", title: "Inbox", projectId: "p-1", items: [] }] }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <TodoView projectId="p-1" addToast={vi.fn()} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(screen.getByTestId("todo-view-root")).toBeInTheDocument());
      const creates = await screen.findAllByTestId("add-list-button");
      expect(creates).toHaveLength(1);
      expect(creates[0]).toHaveClass("view-action-button--create");
      expect(within(screen.getByRole("banner")).getByTestId("add-list-button")).toBe(creates[0]);
    });

    it("keeps exactly one creation entry on the empty Todos collection", async () => {
      installFetch(() => ({ lists: [] }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <TodoView projectId="p-1" addToast={vi.fn()} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(screen.getByText(/No todo lists yet/i)).toBeInTheDocument());
      expect(screen.getAllByTestId("add-list-button")).toHaveLength(1);
      expect(within(screen.getByRole("banner")).getByTestId("add-list-button")).toBeInTheDocument();
    });

    it("routes Todos creation into the framing host header without a second title row", async () => {
      installFetch(() => ({ lists: [] }));
      registerView("fusion-plugin-todos", "todos", () => (
        <TodoView projectId="p-1" addToast={vi.fn()} />
      ));

      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardViewHost
            taskView="plugin:fusion-plugin-todos:todos"
            layout={{ title: "Todos" }}
            context={{ projectId: "p-1", tasks: [], workflowSteps: [], openTaskDetail: vi.fn(), addToast: vi.fn() }}
          />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(screen.getByTestId("todo-view-root")).toBeInTheDocument());
      expect(screen.getAllByRole("banner")).toHaveLength(1);
      const create = await screen.findByTestId("add-list-button");
      expect(within(screen.getByRole("banner")).getByTestId("add-list-button")).toBe(create);
    });
  });

  describe("Quality", () => {
    it("keeps one shared header and no invented creation entry for a read-only run view", async () => {
      installFetch(() => ({ runs: [], settings: {} }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <QualityDashboardView context={{ projectId: "p-1", tasks: [], workflowSteps: [], openTaskDetail: vi.fn(), addToast: vi.fn() }} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
      expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
    });
  });

  describe("Linear import", () => {
    it("keeps its single shared header and imports nothing on mount", async () => {
      const fetchMock = installFetch(() => ({ issues: [], configured: false }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <LinearImportView context={{ projectId: "p-1", tasks: [], workflowSteps: [], openTaskDetail: vi.fn(), addToast: vi.fn() }} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    });
  });

  describe("Roadmap", () => {
    it("keeps one shared header whose single creation entry is canonical", async () => {
      installFetch(() => ({ roadmaps: [] }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <RoadmapsView projectId="p-1" addToast={vi.fn()} />
        </ViewLayoutProvider>,
      );

      await screen.findByTestId("create-roadmap-header-btn");
      expect(document.querySelectorAll(".view-header")).toHaveLength(1);
      const creates = screen.getAllByTestId("create-roadmap-header-btn");
      expect(creates).toHaveLength(1);
      expect(within(screen.getByRole("banner")).getByTestId("create-roadmap-header-btn")).toBe(creates[0]);
    });
  });

  describe("Compound engineering", () => {
    it("keeps one shared header and starts no session merely by mounting", async () => {
      const fetchMock = installFetch(() => ({ groups: [], sessions: [] }));
      render(
        <ViewLayoutProvider projectId="p-1">
          <CompoundEngineeringView projectId="p-1" enabledOverride={false} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    });
  });

  describe("Reports", () => {
    it("uses the shared header for its read-only collection without inventing creation", async () => {
      installFetch(() => []);
      render(
        <ViewLayoutProvider projectId="p-1">
          <ReportsView projectId="p-1" addToast={vi.fn()} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
      expect(within(screen.getByRole("banner")).getByRole("button", { name: "Compare" })).toBeInTheDocument();
      expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
    });

    /*
    FNXC:StandardizedViewActions 2026-09-13-20:32:
    On phones the shared chrome hides the action label, so an icon-only header action must still paint a decorative
    pictogram. Without one the operator receives a visually empty touch target, which is the defect this covers.
    */
    it("keeps its phone header action visible as an icon with its accessible name", async () => {
      installFetch(() => []);
      const restoreWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      document.documentElement.dataset.viewportMode = "mobile";
      try {
        render(
          <ViewLayoutProvider projectId="p-1">
            <ReportsView projectId="p-1" addToast={vi.fn()} />
          </ViewLayoutProvider>,
        );

        const compare = await screen.findByTestId("reports-compare-button");
        expect(compare).toHaveClass("view-action-button--mobile-icon-only");
        expect(compare).toHaveAccessibleName("Compare");
        expect(compare.querySelector("svg")).toBeInTheDocument();
        expect(compare.querySelector(".view-action-button__label")?.textContent).toBe("Compare");
      } finally {
        delete document.documentElement.dataset.viewportMode;
        Object.defineProperty(window, "innerWidth", { configurable: true, value: restoreWidth });
      }
    });
  });

  describe("Dependency graph and Printing Press wizard", () => {
    it("lets the framing host own the single header for a canvas destination", async () => {
      registerView("fusion-plugin-dependency-graph", "graph", () => (
        <DependencyGraphDashboardView context={{ projectId: "p-1", tasks: [], workflowSteps: [], openTaskDetail: vi.fn() }} />
      ));

      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardViewHost
            taskView="plugin:fusion-plugin-dependency-graph:graph"
            layout={{ title: "Graph", contentOwnsScroll: true }}
            context={{ projectId: "p-1", tasks: [], workflowSteps: [], openTaskDetail: vi.fn() }}
          />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
    });

    it("lets the framing host own the single header for the wizard destination and saves nothing on mount", async () => {
      const fetchMock = installFetch(() => ({ id: "draft-1" }));
      registerView("fusion-plugin-cli-printing-press", "wizard", () => <CliPrintingPressWizardView />);

      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardViewHost taskView="plugin:fusion-plugin-cli-printing-press:wizard" layout={{ title: "Printing Press" }} />
        </ViewLayoutProvider>,
      );

      await waitFor(() => expect(document.querySelector(".cli-press-wizard")).toBeInTheDocument());
      expect(document.querySelectorAll(".view-header")).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("plugin host contract", () => {
    it("frames a registered plugin destination with one header, rail, and canonical creation", async () => {
      const onCreate = vi.fn();
      registerView("fake", "collection", () => <div data-testid="fake-plugin-body">body</div>);

      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardViewHost
            taskView="plugin:fake:collection"
            layout={{
              title: "Fake collection",
              sidebar: <div data-testid="fake-plugin-rail">rail</div>,
              sidebarLabel: "Fake collection list",
              primaryAction: { kind: "create", label: "New fake", onClick: onCreate },
            }}
          />
        </ViewLayoutProvider>,
      );

      expect(screen.getAllByRole("banner")).toHaveLength(1);
      expect(screen.getByTestId("fake-plugin-rail")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("fake-plugin-body")).toBeInTheDocument());
      const create = within(screen.getByRole("banner")).getByRole("button", { name: "New fake" });
      expect(create).toHaveClass("view-action-button--create");
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("yields header ownership when the surrounding host already paints the title", async () => {
      registerView("fake", "collection", () => <div data-testid="fake-plugin-body">body</div>);

      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardHostChromeContext.Provider value={{ hostOwnsHeader: true }}>
            <PluginDashboardViewHost
              taskView="plugin:fake:collection"
              layout={{ title: "Fake collection", primaryAction: { kind: "create", label: "New fake", onClick: vi.fn() } }}
            />
          </PluginDashboardHostChromeContext.Provider>
        </ViewLayoutProvider>,
      );

      expect(screen.queryAllByRole("banner")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "New fake" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("fake-plugin-body")).toBeInTheDocument());
    });

    it("keeps an unregistered destination unreachable instead of inventing a route", async () => {
      render(
        <ViewLayoutProvider projectId="p-1">
          <PluginDashboardViewHost taskView="plugin:fusion-plugin-reports:reports" layout={{ title: "Reports" }} />
        </ViewLayoutProvider>,
      );

      expect(screen.getAllByRole("banner")).toHaveLength(1);
      await waitFor(() => expect(screen.getByTestId("plugin-view-unavailable")).toBeInTheDocument());
      expect(screen.queryByTestId("fake-plugin-body")).toBeNull();
    });
  });
});

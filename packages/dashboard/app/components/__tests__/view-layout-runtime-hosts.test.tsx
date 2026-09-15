import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { RightDock } from "../RightDock";
import { RightDockExpandModal } from "../RightDockExpandModal";
import { MainContentDrawer } from "../dashboard/MainContent";
import { NotesDrawer, PlanningDrawer, ProjectsDrawer } from "../MobileDrawer";
import { MobileUsageDrawer } from "../AppModals";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";

/*
FNXC:StandardizedViewLayout 2026-09-13-20:32:
FN-379 proves the shared chrome on the auxiliary RUNTIME hosts as well as the routed destinations: the right dock,
its expand window, and the four Alpha drawer bridges. Each mounts its production composition, so a host that paints
a second title, loses the ordered zones, or strands a creation entry outside the canonical header fails here.
*/

const { fetchWorkspaceFileListMock, fetchWorkspaceFileContentMock } = vi.hoisted(() => ({
  fetchWorkspaceFileListMock: vi.fn(),
  fetchWorkspaceFileContentMock: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchWorkspaceFileList: fetchWorkspaceFileListMock,
    fetchWorkspaceFileContent: fetchWorkspaceFileContentMock,
  };
});

const renderProps = { addToast: vi.fn(), projectId: "project-1" };

function zoneOrder(surface: HTMLElement): string[] {
  return [...surface.children]
    .map((child) => child.getAttribute("data-view-layout-zone"))
    .filter((zone): zone is string => Boolean(zone));
}

describe("FN-379 shared chrome on the auxiliary runtime hosts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fetchWorkspaceFileListMock.mockResolvedValue({ entries: [], path: "" });
    fetchWorkspaceFileContentMock.mockResolvedValue({ content: "", path: "" });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });

  afterEach(() => cleanup());

  it("keeps the right dock body on one canonical header with its creation entries inside it", async () => {
    render(
      <ViewLayoutProvider projectId="project-1">
        <RightDock open renderProps={renderProps} pinned={false} onTogglePin={vi.fn()} selectedKey="files" onSelectKey={vi.fn()} />
      </ViewLayoutProvider>,
    );

    const dock = await screen.findByTestId("right-dock");
    await waitFor(() => expect(dock.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1));
    const header = dock.querySelector(".view-header");
    for (const create of dock.querySelectorAll(".view-action-button--create")) {
      expect(header?.contains(create)).toBe(true);
    }
    // A list-only dock body is already the collection, so it must not nest another destination rail inside itself.
    expect(dock.querySelectorAll(".view-sidebar")).toHaveLength(0);
  });

  it("expands a dock view into one canonical window header without duplicating the dock title", async () => {
    render(
      <ViewLayoutProvider projectId="project-1">
        <RightDockExpandModal viewKey="files" renderProps={renderProps} onClose={vi.fn()} />
      </ViewLayoutProvider>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector('[data-view-layout-zone="header"]')).toBeInTheDocument();
    expect(dialog.querySelector('[data-view-layout-zone="content"]')).toBeInTheDocument();
    expect(dialog.querySelectorAll('[data-view-layout-zone="header"]')).toHaveLength(1);
    // The window supplies the single exit; the framed body must not add a competing close control.
    expect(dialog.querySelectorAll(".modal-close")).toHaveLength(1);
  });

  const bridges = [
    {
      name: "projects",
      testId: "mobile-drawer-projects",
      title: "Projects",
      element: (
        <ProjectsDrawer open title="Projects" onClose={vi.fn()}>
          <div data-testid="bridge-body">Projects body</div>
        </ProjectsDrawer>
      ),
    },
    {
      name: "planning",
      testId: "mobile-drawer-planning",
      title: "Planning",
      element: (
        <PlanningDrawer open title="Planning" onClose={vi.fn()}>
          <div data-testid="bridge-body">Planning body</div>
        </PlanningDrawer>
      ),
    },
    {
      /*
      FNXC:ToolSurfaces 2026-09-15-21:23:
      FN-435 : sur téléphone, le panneau d'outils Notes est hébergé par ce pont plutôt que par la popover d'en-tête.
      Il doit donc satisfaire exactement le même contrat de chrome que Projects et Planning.
      */
      name: "notes",
      testId: "mobile-drawer-notes",
      title: "Notes",
      element: (
        <NotesDrawer open title="Notes" onClose={vi.fn()}>
          <div data-testid="bridge-body">Notes body</div>
        </NotesDrawer>
      ),
    },
    {
      name: "main content",
      testId: "mobile-drawer-main-content",
      title: "Notes",
      element: (
        <MainContentDrawer taskView="notes" open title="Notes" onClose={vi.fn()}>
          <div data-testid="bridge-body">Notes body</div>
        </MainContentDrawer>
      ),
    },
  ];

  /*
  Each bridge hands its visible title to the hosted destination (`contentOwnsHeader`), so the shell keeps one
  screen-reader dialog name, one drag handle, and one bounded content zone instead of stacking a second header.
  */
  it.each(bridges)("keeps the $name Alpha drawer bridge single-headed with ordered zones", async ({ testId, title, element }) => {
    render(<ViewLayoutProvider projectId="project-1">{element}</ViewLayoutProvider>);

    const drawer = await screen.findByTestId(testId);
    const panel = within(drawer).getByRole("dialog", { name: title });
    expect(zoneOrder(panel)).toEqual(["content"]);
    expect(panel.querySelectorAll(".mobile-drawer__header")).toHaveLength(0);
    expect(panel.querySelectorAll(".modal-close")).toHaveLength(0);
    expect(within(panel).getByTestId("bridge-body")).toBeInTheDocument();
    expect(panel.querySelectorAll(":scope > .view-drawer__handle-target")).toHaveLength(1);
  });

  it("lets the usage bridge content own its header without a second drawer title", async () => {
    render(
      <ViewLayoutProvider projectId="project-1">
        <MobileUsageDrawer open title="Usage" onClose={vi.fn()} projectId="project-1" />
      </ViewLayoutProvider>,
    );

    const drawer = await screen.findByTestId("mobile-drawer-usage");
    const panel = within(drawer).getByRole("dialog", { name: "Usage" });
    expect(zoneOrder(panel)).toEqual(["content"]);
    await waitFor(() => expect(panel.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1));
  });
});

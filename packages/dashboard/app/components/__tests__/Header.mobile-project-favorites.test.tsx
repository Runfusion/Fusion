import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Header } from "../Header";
import { ProjectSelector } from "../ProjectSelector";
import type { ProjectInfo } from "../../api";

const mockFetchScripts = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => "mobile",
}));

function makeProject(id: string, name: string): ProjectInfo {
  return {
    id,
    name,
    path: `/projects/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const projects = [
  makeProject("project-one", "Project One"),
  makeProject("project-two", "Project Two"),
  makeProject("project-three", "Project Three"),
];

function renderMobileHeader(onSelectProject = vi.fn()) {
  const result = render(
    <Header
      projects={projects}
      currentProject={projects[0]}
      onSelectProject={onSelectProject}
      onOpenSettings={vi.fn()}
      onOpenGitHubImport={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
  return { ...result, onSelectProject };
}

describe("Header mobile project favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchScripts.mockResolvedValue({});
  });

  it("renders localStorage favorites before the remaining projects and shares the desktop bookmark store", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(["project-two"]));
    const { unmount } = renderMobileHeader();

    const favorites = screen.getByTestId("mobile-project-switch-favorites");
    const others = screen.getByTestId("mobile-project-switch-others");
    expect(favorites).toHaveTextContent("Project Two");
    expect([...screen.getByTestId("mobile-project-switch-dropdown").querySelectorAll("[data-testid^='mobile-project-switch-item-']")].map((item) => item.getAttribute("data-testid"))).toEqual([
      "mobile-project-switch-item-project-two",
      "mobile-project-switch-item-project-one",
      "mobile-project-switch-item-project-three",
    ]);
    expect(favorites.compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    unmount();
    render(
      <ProjectSelector
        projects={projects}
        currentProject={projects[0]}
        onSelect={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByText("Bookmarked").closest(".project-selector__section")).toHaveTextContent("Project Two");
  });

  it("omits favorite shells, labels, and the section divider when no projects are bookmarked", () => {
    renderMobileHeader();

    expect(screen.queryByTestId("mobile-project-switch-favorites")).toBeNull();
    expect(screen.getByTestId("mobile-project-switch-others")).toBeInTheDocument();
    expect(screen.queryByText("Favorites")).toBeNull();
    expect(screen.queryByText("All projects")).toBeNull();
    expect(screen.getByTestId("mobile-project-switch-dropdown").querySelector(".mobile-project-switch-divider")).toBeNull();
  });

  it("omits the all-projects section when every project is bookmarked", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(projects.map((project) => project.id)));
    renderMobileHeader();

    expect(screen.getByTestId("mobile-project-switch-favorites")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-project-switch-others")).toBeNull();
    expect(screen.queryByText("All projects")).toBeNull();
    expect(screen.getByTestId("mobile-project-switch-dropdown").querySelector(".mobile-project-switch-divider")).toBeNull();
  });

  it("toggles a bookmark without selecting a project or closing the switcher", async () => {
    const { onSelectProject } = renderMobileHeader();

    fireEvent.click(screen.getByTestId("mobile-bookmark-toggle-project-two"));

    expect(onSelectProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeInTheDocument();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("fusion_project_bookmarks") ?? "[]")).toContain("project-two");
      expect(screen.getByTestId("mobile-project-switch-favorites")).toHaveTextContent("Project Two");
    });
  });
});

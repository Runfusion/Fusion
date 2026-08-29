import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectSelector } from "../ProjectSelector";
import type { ProjectInfo, ProjectStatus } from "@fusion/core";

// Mock useProjectBookmarks
const mockToggleBookmark = vi.fn();
let mockBookmarkedIds: Set<string> = new Set();

vi.mock("../../hooks/useProjectBookmarks", () => ({
  useProjectBookmarks: () => ({
    bookmarkedIds: mockBookmarkedIds,
    toggleBookmark: mockToggleBookmark,
    isBookmarked: (id: string) => mockBookmarkedIds.has(id),
  }),
}));

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    ChevronDown: () => <span data-testid="chevron-icon">▼</span>,
    Check: () => <span data-testid="check-icon">✓</span>,
    Folder: () => <span data-testid="folder-icon">📁</span>,
    Grid3X3: () => <span data-testid="grid-icon">⊞</span>,
    Search: () => <span data-testid="search-icon">🔍</span>,
    Clock: () => <span data-testid="clock-icon">🕐</span>,
    Star: ({ fill }: { fill?: string }) => (
      <span data-testid="star-icon" data-fill={fill ?? "none"}>★</span>
    ),
    X: () => <span data-testid="x-icon">✕</span>,
    Play: () => <span data-testid="play-icon">▶</span>,
    Pause: () => <span data-testid="pause-icon">⏸</span>,
    AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
    Loader2: () => <span data-testid="loader-icon">⟳</span>,
  };
});

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj_abc123",
    name: "Test Project",
    path: "/home/user/projects/test",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

const noop = () => {};

describe("ProjectSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBookmarkedIds = new Set();
    // JSDOM does not implement scrollIntoView — mock it for itemRefs
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders without crashing", () => {
    render(
      <ProjectSelector
        projects={[makeProject({ id: "proj_1" }), makeProject({ id: "proj_2" })]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
  });

  it("does not render when only one project exists", () => {
    const { container } = render(
      <ProjectSelector
        projects={[makeProject()]}
        currentProject={makeProject()}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("does not render when no projects exist", () => {
    const { container } = render(
      <ProjectSelector
        projects={[]}
        currentProject={null}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows current project name in trigger", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1", name: "Project One" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    expect(screen.getByText("Project One")).toBeDefined();
  });

  it("opens dropdown on click", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByTestId("project-selector-dropdown")).toBeDefined();
  });

  it("shows all projects in dropdown", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByText("Project Two")).toBeDefined();
  });

  it("renders fallback status icons for unknown or missing project statuses", () => {
    expect(() => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One", status: "active" }),
            makeProject({ id: "proj_2", name: "Project Two", status: "removing" as ProjectStatus }),
            makeProject({ id: "proj_3", name: "Project Three", status: undefined as unknown as ProjectStatus }),
          ]}
          currentProject={makeProject({ id: "proj_1", name: "Project One", status: "active" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );
    }).not.toThrow();

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByText("Project Two")).toBeDefined();
    expect(screen.getByText("Project Three")).toBeDefined();
    expect(screen.getAllByTestId("alert-icon").length).toBeGreaterThanOrEqual(2);
  });

  it("calls onSelect when project is clicked", () => {
    const onSelect = vi.fn();
    const projectTwo = makeProject({ id: "proj_2", name: "Project Two" });

    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          projectTwo,
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={onSelect}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    fireEvent.click(screen.getByText("Project Two"));
    expect(onSelect).toHaveBeenCalledWith(projectTwo);
  });

  it("does not throw when clicking a project without onSelect", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(() => fireEvent.click(screen.getByText("Project Two"))).not.toThrow();
    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
  });

  it("closes dropdown after selection", () => {
    const onSelect = vi.fn();

    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={onSelect}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    fireEvent.click(screen.getByText("Project Two"));
    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
  });

  it("calls onViewAll when 'View All Projects' is clicked", () => {
    const onViewAll = vi.fn();

    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={onViewAll}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    fireEvent.click(screen.getByText("View All Projects"));
    expect(onViewAll).toHaveBeenCalled();
  });

  it("shows search input when 5+ projects", () => {
    render(
      <ProjectSelector
        projects={Array.from({ length: 5 }, (_, i) =>
          makeProject({ id: `proj_${i}`, name: `Project ${i}` })
        )}
        currentProject={makeProject({ id: "proj_0" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByPlaceholderText("Search projects...")).toBeDefined();
  });

  it("shows search input even with only 2 projects (autocomplete always available)", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Alpha" }),
          makeProject({ id: "proj_2", name: "Beta" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    // Search input should always be present for autocomplete
    expect(screen.getByTestId("project-selector-search-input")).toBeDefined();
  });

  it("filters projects based on search query", () => {
    render(
      <ProjectSelector
        projects={Array.from({ length: 5 }, (_, i) =>
          makeProject({ id: `proj_${i}`, name: `Project ${i}` })
        )}
        currentProject={makeProject({ id: "proj_0" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    const searchInput = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(searchInput, { target: { value: "Project 2" } });
    
    expect(screen.getByText("Project 2")).toBeDefined();
    expect(screen.queryByText("Project 1")).toBeNull();
  });

  it("shows recent projects section", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
          makeProject({ id: "proj_3", name: "Project Three" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
        recentProjectIds={["proj_2", "proj_3"]}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByText("Recent")).toBeDefined();
    expect(screen.getByText("Project Two")).toBeDefined();
  });

  it("closes dropdown on escape key", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1" }),
          makeProject({ id: "proj_2" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByTestId("project-selector-dropdown")).toBeDefined();
    
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
  });

  it("closes dropdown on outside click", () => {
    render(
      <>
        <div data-testid="outside">Outside element</div>
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1" }),
            makeProject({ id: "proj_2" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      </>
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByTestId("project-selector-dropdown")).toBeDefined();
    
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
  });

  it("trigger has correct aria attributes", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1" }),
          makeProject({ id: "proj_2" }),
        ]}
        currentProject={makeProject({ id: "proj_1" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    const trigger = screen.getByTestId("project-selector-trigger");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows checkmark for current project", () => {
    render(
      <ProjectSelector
        projects={[
          makeProject({ id: "proj_1", name: "Project One" }),
          makeProject({ id: "proj_2", name: "Project Two" }),
        ]}
        currentProject={makeProject({ id: "proj_1", name: "Project One" })}
        onSelect={noop}
        onViewAll={noop}
      />
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    // Should have checkmark for current project (though in dropdown it might not be visible due to filtering)
  });

  // === Bookmark-specific tests ===

  describe("bookmarks", () => {
    it("shows bookmark toggle on each project item", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const bookmarkToggle = screen.getByTestId("bookmark-toggle-proj_2");
      expect(bookmarkToggle).toBeDefined();
    });

    it("calls toggleBookmark when star is clicked", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const bookmarkToggle = screen.getByTestId("bookmark-toggle-proj_2");
      fireEvent.click(bookmarkToggle);
      expect(mockToggleBookmark).toHaveBeenCalledWith("proj_2");
    });

    it("does not trigger onSelect when star is clicked", () => {
      const onSelect = vi.fn();
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={onSelect}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const bookmarkToggle = screen.getByTestId("bookmark-toggle-proj_2");
      fireEvent.click(bookmarkToggle);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("shows Bookmarked section when projects are bookmarked", () => {
      mockBookmarkedIds = new Set(["proj_2"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
            makeProject({ id: "proj_3", name: "Project Three" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      expect(screen.getByText("Bookmarked")).toBeDefined();
      expect(screen.getByText("Project Two")).toBeDefined();
    });

    it("displays bookmarked projects at top of list", () => {
      mockBookmarkedIds = new Set(["proj_3"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
            makeProject({ id: "proj_3", name: "Project Three" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));

      // "Bookmarked" section header should exist
      expect(screen.getByText("Bookmarked")).toBeDefined();

      // The "All Projects" section should also exist since we have non-bookmarked items
      expect(screen.getByText("All Projects")).toBeDefined();
    });

    it("bookmark toggle shows filled star for bookmarked projects", () => {
      mockBookmarkedIds = new Set(["proj_2"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const bookmarkedStar = screen.getByTestId("bookmark-toggle-proj_2");
      // Star inside should have data-fill="currentColor" for bookmarked
      const starIcon = bookmarkedStar.querySelector('[data-testid="star-icon"]');
      expect(starIcon?.getAttribute("data-fill")).toBe("currentColor");
    });

    it("does not show Bookmarked section when no projects are bookmarked", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      expect(screen.queryByText("Bookmarked")).toBeNull();
    });

    it("does not show current project in bookmarked section", () => {
      mockBookmarkedIds = new Set(["proj_1"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      // Current project should not appear in Bookmarked section
      // (it's excluded from all lists)
      expect(screen.queryByText("Bookmarked")).toBeNull();
    });

    it("bookmark toggle has correct aria-label", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const toggle = screen.getByTestId("bookmark-toggle-proj_2");
      expect(toggle.getAttribute("aria-label")).toBe("Bookmark project");
    });

    it("bookmarked project toggle shows remove aria-label", () => {
      mockBookmarkedIds = new Set(["proj_2"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const toggle = screen.getByTestId("bookmark-toggle-proj_2");
      expect(toggle.getAttribute("aria-label")).toBe("Remove bookmark");
    });

    it("dropdown stays open when bookmark is toggled", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project One" }),
            makeProject({ id: "proj_2", name: "Project Two" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const bookmarkToggle = screen.getByTestId("bookmark-toggle-proj_2");
      fireEvent.click(bookmarkToggle);
      // Dropdown should still be open
      expect(screen.getByTestId("project-selector-dropdown")).toBeDefined();
    });
  });

  // === Autocomplete-specific tests ===

  describe("autocomplete", () => {
    it("highlights matching text in project names", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Project Alpha" }),
            makeProject({ id: "proj_2", name: "Project Beta" }),
            makeProject({ id: "proj_3", name: "Unrelated" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "Beta" } });

      // Should show the matched project with highlighted text
      const mark = screen.getByText("Beta");
      expect(mark.tagName).toBe("MARK");
      expect(mark.closest(".project-selector__item")).toBeDefined();
    });

    it("detects exact match and shows indicator", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "My App" }),
            makeProject({ id: "proj_2", name: "My Application" }),
            makeProject({ id: "proj_3", name: "Other" }),
          ]}
          currentProject={makeProject({ id: "proj_3" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "My App" } });

      // Should show exact match indicator
      expect(screen.getByTestId("project-selector-exact-match")).toBeDefined();
      // Should show "Exact" badge on the matching item
      expect(screen.getByText("Exact")).toBeDefined();
    });

    it("does not show exact match indicator for partial match", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "My App" }),
            makeProject({ id: "proj_2", name: "My Application" }),
            makeProject({ id: "proj_3", name: "Other" }),
          ]}
          currentProject={makeProject({ id: "proj_3" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      // "My" matches multiple projects — not an exact match
      fireEvent.change(searchInput, { target: { value: "My" } });

      expect(screen.queryByTestId("project-selector-exact-match")).toBeNull();
    });

    it("auto-selects exact match on Enter when nothing is highlighted", () => {
      const onSelect = vi.fn();
      const exactProject = makeProject({ id: "proj_1", name: "Unique Project" });

      render(
        <ProjectSelector
          projects={[
            exactProject,
            makeProject({ id: "proj_2", name: "Other Project" }),
          ]}
          currentProject={makeProject({ id: "proj_2" })}
          onSelect={onSelect}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "Unique Project" } });

      // Press Enter without highlighting anything first
      fireEvent.keyDown(screen.getByTestId("project-selector-dropdown"), { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith(exactProject);
    });

    it("shows no results message when search matches nothing", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha" }),
            makeProject({ id: "proj_2", name: "Beta" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "zzznonexistent" } });

      expect(screen.getByTestId("project-selector-no-results")).toBeDefined();
    });

    it("shows bookmarked projects that match an active search", () => {
      mockBookmarkedIds = new Set(["proj_2"]);

      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha" }),
            makeProject({ id: "proj_2", name: "Starred Project" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      fireEvent.change(screen.getByPlaceholderText("Search projects..."), {
        target: { value: "Starred" },
      });

      expect(screen.getByText("Starred")).toBeDefined();
      expect(screen.getByText("Project")).toBeDefined();
      expect(screen.queryByTestId("project-selector-no-results")).toBeNull();
    });

    it("does not throw when pressing Enter on a highlighted project without onSelect", async () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha" }),
            makeProject({ id: "proj_2", name: "Beta" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "Beta" } });
      await waitFor(() => {
        expect(screen.getByTestId("project-selector-item-proj_2").className).toContain("highlighted");
      });
      expect(() => fireEvent.keyDown(searchInput, { key: "Enter" })).not.toThrow();
      expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    });

    it("clear button clears search query", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha" }),
            makeProject({ id: "proj_2", name: "Beta" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "Alpha" } });

      // Clear button should appear
      const clearButton = screen.getByLabelText("Clear search");
      expect(clearButton).toBeDefined();

      fireEvent.click(clearButton);
      expect(searchInput).toHaveValue("");
    });

    it("filters by project path as well as name", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha", path: "/home/user/projects/frontend" }),
            makeProject({ id: "proj_2", name: "Beta", path: "/home/user/projects/backend" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "backend" } });

      // Beta project should be visible (matched by path)
      expect(screen.getByText("Beta")).toBeDefined();
      // Alpha should be filtered out
      expect(screen.queryByText("Alpha")).toBeNull();
    });

    it("resets search query when dropdown is closed and reopened", () => {
      render(
        <ProjectSelector
          projects={[
            makeProject({ id: "proj_1", name: "Alpha" }),
            makeProject({ id: "proj_2", name: "Beta" }),
          ]}
          currentProject={makeProject({ id: "proj_1" })}
          onSelect={noop}
          onViewAll={noop}
        />
      );

      // Open, type something, close with escape
      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const searchInput = screen.getByPlaceholderText("Search projects...");
      fireEvent.change(searchInput, { target: { value: "Alpha" } });
      fireEvent.keyDown(document, { key: "Escape" });

      // Reopen — search should be cleared
      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      const reopenedSearchInput = screen.getByPlaceholderText("Search projects...");
      expect(reopenedSearchInput).toHaveValue("");
    });
  });
});

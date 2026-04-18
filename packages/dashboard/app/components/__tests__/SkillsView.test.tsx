import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SkillsView } from "../SkillsView";
import * as apiModule from "../../api";
import type { DiscoveredSkill, CatalogEntry, SkillContent } from "@fusion/dashboard";

// Mock the API module
vi.mock("../../api", () => ({
  fetchDiscoveredSkills: vi.fn(),
  toggleExecutionSkill: vi.fn(),
  fetchSkillsCatalog: vi.fn(),
  fetchSkillContent: vi.fn(),
}));

const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockToggleExecutionSkill = vi.mocked(apiModule.toggleExecutionSkill);
const mockFetchSkillsCatalog = vi.mocked(apiModule.fetchSkillsCatalog);
const mockFetchSkillContent = vi.mocked(apiModule.fetchSkillContent);

describe("SkillsView", () => {
  const mockAddToast = vi.fn();
  const projectId = "proj_123";
  const onClose = vi.fn();

  const mockDiscoveredSkills: DiscoveredSkill[] = [
    {
      id: "npm::skills/test-skill",
      name: "test-skill",
      path: "/project/.fusion/skills/test-skill",
      relativePath: "skills/test-skill",
      enabled: true,
      metadata: {
        source: "npm",
        scope: "project",
        origin: "top-level",
      },
    },
    {
      id: "github::skills/another-skill",
      name: "another-skill",
      path: "/project/.fusion/skills/another-skill",
      relativePath: "skills/another-skill",
      enabled: false,
      metadata: {
        source: "github",
        scope: "project",
        origin: "package",
      },
    },
  ];

  const mockCatalogEntries: CatalogEntry[] = [
    {
      id: "cat-001",
      slug: "test-skill",
      name: "Test Skill",
      description: "A test skill for testing",
      tags: ["testing", "example"],
      installs: 1234,
      installation: {
        installed: false,
        matchingSkillIds: [],
        matchingPaths: [],
      },
    },
    {
      id: "cat-002",
      slug: "another-skill",
      name: "Another Skill",
      description: "Another example skill",
      tags: ["utility"],
      installs: 5678,
      installation: {
        installed: true,
        matchingSkillIds: ["npm::skills/another-skill"],
        matchingPaths: ["skills/another-skill"],
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDiscoveredSkills.mockResolvedValue(mockDiscoveredSkills);
    mockToggleExecutionSkill.mockResolvedValue({
      settingsPath: "skills",
      pattern: "+test-skill",
      targetFile: "/project/.fusion/settings.json",
    });
    mockFetchSkillsCatalog.mockResolvedValue({
      entries: mockCatalogEntries,
      auth: {
        mode: "unauthenticated",
        tokenPresent: false,
        fallbackUsed: false,
      },
    });
  });

  describe("rendering", () => {
    it("renders the skills view with header", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("skills-view")).toBeTruthy();
        expect(screen.getByText("Skills")).toBeTruthy();
        expect(screen.getByText(/discovered/)).toBeTruthy();
      });
    });

    it("renders both sections after data loads", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Discovered Skills")).toBeTruthy();
        expect(screen.getByText("Skills Catalog")).toBeTruthy();
      });
    });

    it("displays discovered skill count in header", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText(/2 discovered/)).toBeTruthy();
      });
    });

    it("renders discovered skills list", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.getByText("another-skill")).toBeTruthy();
        expect(screen.getByText("skills/test-skill")).toBeTruthy();
        expect(screen.getByText("skills/another-skill")).toBeTruthy();
      });
    });

    it("renders source metadata for discovered skills", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        const npmSources = screen.getAllByText("npm");
        expect(npmSources.length).toBe(1);
        const githubSources = screen.getAllByText("github");
        expect(githubSources.length).toBe(1);
      });
    });

    it("renders catalog entries as cards", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Test Skill")).toBeTruthy();
        expect(screen.getByText("Another Skill")).toBeTruthy();
        expect(screen.getByText("A test skill for testing")).toBeTruthy();
        expect(screen.getByText("Another example skill")).toBeTruthy();
      });
    });

    it("renders catalog tags as badges", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("testing")).toBeTruthy();
        expect(screen.getByText("example")).toBeTruthy();
        expect(screen.getByText("utility")).toBeTruthy();
      });
    });

    it("renders install counts", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText(/1,234 installs/)).toBeTruthy();
        expect(screen.getByText(/5,678 installs/)).toBeTruthy();
      });
    });

    it("shows loading state while fetching discovered skills", async () => {
      let resolveSkills: ((value: DiscoveredSkill[]) => void) | undefined;
      mockFetchDiscoveredSkills.mockImplementation(
        () => new Promise((resolve) => { resolveSkills = resolve as unknown as (value: DiscoveredSkill[]) => void; })
      );

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      expect(screen.getByText("Loading discovered skills...")).toBeTruthy();

      // Complete the fetch
      await act(async () => {
        resolveSkills!(mockDiscoveredSkills);
      });
    });

    it("shows empty state when no discovered skills", async () => {
      mockFetchDiscoveredSkills.mockResolvedValue([]);

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("No skills discovered in this project.")).toBeTruthy();
      });
    });

    it("shows empty state when no catalog entries", async () => {
      mockFetchSkillsCatalog.mockResolvedValue({
        entries: [],
        auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("No skills available in the catalog.")).toBeTruthy();
      });
    });
  });

  describe("toggle skill", () => {
    it("calls toggleExecutionSkill when toggle is clicked", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Find and click the toggle for test-skill (enabled skill)
      const toggles = screen.getAllByRole("checkbox");
      const enabledToggle = toggles.find(t => (t as HTMLInputElement).checked) as HTMLInputElement;
      expect(enabledToggle).toBeTruthy();

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      expect(mockToggleExecutionSkill).toHaveBeenCalledWith(
        "npm::skills/test-skill",
        false,
        undefined
      );
    });

    it("updates checked state on successful toggle", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Find and click the toggle for test-skill (enabled skill)
      const toggles = screen.getAllByRole("checkbox");
      const enabledToggle = toggles.find(t => (t as HTMLInputElement).checked) as HTMLInputElement;

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      await waitFor(() => {
        expect((enabledToggle as HTMLInputElement).checked).toBe(false);
      });
    });

    it("shows success toast on successful toggle", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const toggles = screen.getAllByRole("checkbox");
      const enabledToggle = toggles.find(t => (t as HTMLInputElement).checked) as HTMLInputElement;

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Skill disabled",
          "success"
        );
      });
    });

    it("reverts toggle and shows error toast on failed toggle", async () => {
      mockToggleExecutionSkill.mockRejectedValue(new Error("Toggle failed"));

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const toggles = screen.getAllByRole("checkbox");
      const enabledToggle = toggles.find(t => (t as HTMLInputElement).checked) as HTMLInputElement;

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to toggle skill"),
          "error"
        );
      });

      // Should revert to original state
      expect((enabledToggle as HTMLInputElement).checked).toBe(true);
    });
  });

  describe("catalog search", () => {
    it("calls fetchSkillsCatalog with projectId when provided", async () => {
      render(<SkillsView projectId={projectId} addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(mockFetchDiscoveredSkills).toHaveBeenCalledWith(projectId);
      });

      expect(mockFetchSkillsCatalog).toHaveBeenCalledWith("", 20, projectId);
    });

    it("shows search input and updates on change", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search skills...")).toBeTruthy();
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");
      fireEvent.change(searchInput, { target: { value: "test" } });

      expect((searchInput as HTMLInputElement).value).toBe("test");
    });
  });

  describe("error handling", () => {
    it("shows error message for catalog fetch with upstream error", async () => {
      mockFetchSkillsCatalog.mockRejectedValue({
        error: "Service unavailable",
        code: "upstream_http_error",
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Catalog is temporarily unavailable. Please try again later.")).toBeTruthy();
      });
    });

    it("shows error toast when fetchDiscoveredSkills fails", async () => {
      mockFetchDiscoveredSkills.mockRejectedValue(new Error("Failed to load"));

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to load"),
          "error"
        );
      });
    });

    it("shows Try Again button for catalog error", async () => {
      mockFetchSkillsCatalog.mockRejectedValue({
        error: "Service unavailable",
        code: "upstream_http_error",
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeTruthy();
      });
    });
  });

  describe("refresh functionality", () => {
    it("refreshes discovered skills when refresh button is clicked", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Refresh")).toBeTruthy();
      });

      mockFetchDiscoveredSkills.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByText("Refresh"));
      });

      expect(mockFetchDiscoveredSkills).toHaveBeenCalled();
    });

    it("refresh button is disabled while loading", async () => {
      let resolveSkills: ((value: DiscoveredSkill[]) => void) | undefined;
      mockFetchDiscoveredSkills.mockImplementation(
        () => new Promise((resolve) => { resolveSkills = resolve as unknown as (value: DiscoveredSkill[]) => void; })
      );

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      // Trigger refresh
      await act(async () => {
        fireEvent.click(screen.getByText("Refresh"));
      });

      // Button should be disabled during loading
      expect(screen.getByText("Refresh").closest("button")?.hasAttribute("disabled")).toBe(true);
      expect(document.querySelector(".spin")).toBeTruthy();

      // Complete the fetch
      await act(async () => {
        resolveSkills!(mockDiscoveredSkills);
      });
    });
  });

  describe("close button", () => {
    it("calls onClose when close button is clicked", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Close skills view")).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Close skills view"));
      });

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("CSS class assertions", () => {
    it("renders with .skills-view root class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(document.querySelector(".skills-view")).toBeTruthy();
      });
    });

    it("renders .skills-view-header and .skills-view-content sections", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(document.querySelector(".skills-view-header")).toBeTruthy();
        expect(document.querySelector(".skills-view-section")).toBeTruthy();
      });
    });

    it("renders discovered skills list with .skills-view-item rows", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        const items = document.querySelectorAll(".skills-view-item");
        expect(items.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("renders catalog cards with .skills-view-card class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(document.querySelectorAll(".skills-view-card").length).toBeGreaterThanOrEqual(2);
      });
    });

    it("renders search input with .skills-view-search class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(document.querySelector(".skills-view-search")).toBeTruthy();
      });
    });

    it("renders toggle sliders with .skills-view-toggle-slider class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        const sliders = document.querySelectorAll(".skills-view-toggle-slider");
        expect(sliders.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("renders catalog grid with .skills-view-grid class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(document.querySelector(".skills-view-grid")).toBeTruthy();
      });
    });
  });

  describe("catalog search debounce", () => {
    it("debounces catalog search input", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(0); // Initialize fake timers

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      // Wait for initial render and API calls
      await act(async () => {
        vi.runAllTimers();
      });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      mockFetchSkillsCatalog.mockClear();

      const searchInput = screen.getByPlaceholderText("Search skills...");

      // Type in the search input
      fireEvent.change(searchInput, { target: { value: "test" } });

      // Should NOT have called fetchSkillsCatalog yet (debounce not triggered)
      expect(mockFetchSkillsCatalog).not.toHaveBeenCalled();

      // Advance timers by 300ms (component debounce is ~300ms)
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Now fetchSkillsCatalog should have been called with the search query
      expect(mockFetchSkillsCatalog).toHaveBeenCalledWith("test", 20, undefined);

      vi.useRealTimers();
    });

    it("debounces with original query when clearing search", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(0); // Initialize fake timers

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      // Wait for initial render and API calls
      await act(async () => {
        vi.runAllTimers();
      });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");

      // Type something and wait for debounce
      fireEvent.change(searchInput, { target: { value: "test" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      mockFetchSkillsCatalog.mockClear();

      // Clear the search
      fireEvent.change(searchInput, { target: { value: "" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Should call with empty query
      expect(mockFetchSkillsCatalog).toHaveBeenCalledWith("", 20, undefined);

      vi.useRealTimers();
    });
  });

  describe("error-state retry", () => {
    it("retry button is displayed when catalog fetch fails", async () => {
      mockFetchSkillsCatalog.mockRejectedValue({
        error: "Service unavailable",
        code: "upstream_http_error",
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeTruthy();
      });
    });

    it("error message is displayed when catalog fetch fails", async () => {
      mockFetchSkillsCatalog.mockRejectedValue(new Error("Network error"));

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText(/unavailable|error|failed/i)).toBeTruthy();
      });
    });

    it("success state after retry clears error", async () => {
      // Use a custom mock function that rejects on first call and resolves on second
      let callCount = 0;
      mockFetchSkillsCatalog.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Service unavailable"));
        }
        return Promise.resolve({
          entries: mockCatalogEntries,
          auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
        });
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeTruthy();
      });

      // Click retry
      await act(async () => {
        fireEvent.click(screen.getByText("Try Again"));
      });

      await waitFor(() => {
        // Catalog should now show entries
        expect(screen.getByText("Test Skill")).toBeTruthy();
      });
    });
  });

  describe("discovered skills filtering", () => {
    it("filters discovered skills by search query", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.getByText("another-skill")).toBeTruthy();
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");
      fireEvent.change(searchInput, { target: { value: "test-skill" } });

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.queryByText("another-skill")).toBeNull();
      });
    });

    it("shows filtered empty state when no discovered skills match search", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");
      fireEvent.change(searchInput, { target: { value: "zzz-nonexistent" } });

      await waitFor(() => {
        expect(screen.getByText("No discovered skills match your search.")).toBeTruthy();
      });
    });

    it("shows original empty state when no skills are discovered", async () => {
      mockFetchDiscoveredSkills.mockResolvedValue([]);

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("No skills discovered in this project.")).toBeTruthy();
      });

      // Search should not override the "no skills discovered" empty state
      const searchInput = screen.getByPlaceholderText("Search skills...");
      fireEvent.change(searchInput, { target: { value: "test" } });

      await waitFor(() => {
        expect(screen.getByText("No skills discovered in this project.")).toBeTruthy();
      });
    });

    it("filters discovered skills by relativePath", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.getByText("another-skill")).toBeTruthy();
      });

      // Search by path instead of name
      const searchInput = screen.getByPlaceholderText("Search skills...");
      fireEvent.change(searchInput, { target: { value: "another-skill" } });

      await waitFor(() => {
        expect(screen.queryByText("test-skill")).toBeNull();
        expect(screen.getByText("another-skill")).toBeTruthy();
      });
    });
  });

  describe("skill content viewing", () => {
    const mockSkillContent: SkillContent = {
      name: "test-skill",
      skillMd: "# Test Skill\n\nThis is the skill content.",
      files: [
        { name: "references", relativePath: "references", type: "directory" },
        { name: "workflows", relativePath: "workflows", type: "directory" },
      ],
    };

    beforeEach(() => {
      mockFetchSkillContent.mockResolvedValue(mockSkillContent);
    });

    it("calls fetchSkillContent when clicking a discovered skill item", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      expect(testSkillItem).toBeTruthy();

      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      expect(mockFetchSkillContent).toHaveBeenCalledWith("npm::skills/test-skill", undefined);
    });

    it("displays skill content when loaded", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        const preElement = document.querySelector(".skills-view-detail-content");
        expect(preElement).toBeTruthy();
        expect(preElement!.textContent).toContain("# Test Skill");
        expect(preElement!.textContent).toContain("This is the skill content.");
        const fileBadges = document.querySelectorAll(".skills-view-detail-files .badge");
        expect(fileBadges.length).toBe(2);
      });
    });

    it("collapses detail when clicking the same skill again", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item to expand
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByTestId("skill-detail")).toBeTruthy();
      });

      // Click again to collapse
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.queryByTestId("skill-detail")).toBeNull();
      });
    });

    it("does NOT trigger content fetch when clicking toggle", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Find the toggle for test-skill
      const toggles = screen.getAllByRole("checkbox");
      const enabledToggle = toggles.find(t => (t as HTMLInputElement).checked) as HTMLInputElement;

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      // Should NOT have called fetchSkillContent
      expect(mockFetchSkillContent).not.toHaveBeenCalled();
    });

    it("shows loading state while fetching content", async () => {
      let resolveContent: ((value: SkillContent) => void) | undefined;
      mockFetchSkillContent.mockImplementation(
        () => new Promise((resolve) => { resolveContent = resolve as unknown as (value: SkillContent) => void; })
      );

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByText("Loading skill content...")).toBeTruthy();
      });

      // Complete the fetch
      await act(async () => {
        resolveContent!(mockSkillContent);
      });

      await waitFor(() => {
        const preElement = document.querySelector(".skills-view-detail-content");
        expect(preElement).toBeTruthy();
        expect(preElement!.textContent).toContain("# Test Skill");
      });
    });

    it("shows error state on fetch failure", async () => {
      mockFetchSkillContent.mockRejectedValue(new Error("Failed to load content"));

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByText("Failed to load content")).toBeTruthy();
        expect(screen.getByText("Retry")).toBeTruthy();
      });
    });

    it("retries skill content fetch when retry button is clicked", async () => {
      mockFetchSkillContent
        .mockRejectedValueOnce(new Error("Failed to load content"))
        .mockResolvedValueOnce(mockSkillContent);

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByText("Retry")).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Retry"));
      });

      await waitFor(() => {
        const preElement = document.querySelector(".skills-view-detail-content");
        expect(preElement).toBeTruthy();
        expect(preElement!.textContent).toContain("# Test Skill");
      });

      expect(mockFetchSkillContent).toHaveBeenCalledTimes(2);
    });

    it("collapses detail when close button is clicked", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item to expand
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByTestId("skill-detail")).toBeTruthy();
      });

      // Click close button
      await act(async () => {
        fireEvent.click(screen.getByText("Close"));
      });

      await waitFor(() => {
        expect(screen.queryByTestId("skill-detail")).toBeNull();
      });
    });

    it("selected skill item has --selected class", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      // Click on the test-skill item
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        const selectedItem = document.querySelector(".skills-view-item--selected");
        expect(selectedItem).toBeTruthy();
        expect(selectedItem?.textContent).toContain("test-skill");
      });
    });

    it("renders file badges for supplementary files", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        const fileBadges = document.querySelectorAll(".skills-view-detail-files .badge");
        expect(fileBadges.length).toBe(2);
      });
    });

    it("shows SKILL.md fallback text when skill content is empty", async () => {
      mockFetchSkillContent.mockResolvedValue({
        name: "empty-skill",
        skillMd: "",
        files: [],
      });

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByText("(No SKILL.md found)")).toBeTruthy();
      });
    });
  });
});

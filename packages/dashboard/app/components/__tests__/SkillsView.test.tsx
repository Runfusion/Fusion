import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SkillsView } from "../SkillsView";
import * as apiModule from "../../api";
import type { DiscoveredSkill, CatalogEntry, SkillContent } from "@fusion/dashboard";

// Mock the API module
vi.mock("../../api", () => ({
  fetchDiscoveredSkills: vi.fn(),
  toggleExecutionSkill: vi.fn(),
  installSkill: vi.fn(),
  fetchSkillsCatalog: vi.fn(),
  fetchSkillContent: vi.fn(),
  fetchSkillFileContent: vi.fn(),
}));

const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockToggleExecutionSkill = vi.mocked(apiModule.toggleExecutionSkill);
const mockInstallSkill = vi.mocked(apiModule.installSkill);
const mockFetchSkillsCatalog = vi.mocked(apiModule.fetchSkillsCatalog);
const mockFetchSkillContent = vi.mocked(apiModule.fetchSkillContent);
const mockFetchSkillFileContent = vi.mocked(apiModule.fetchSkillFileContent);

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
      repo: "owner/test-repo",
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
      repo: "owner/another-repo",
      tags: ["utility"],
      installs: 5678,
      installation: {
        installed: true,
        matchingSkillIds: ["npm::skills/another-skill"],
        matchingPaths: ["skills/another-skill"],
      },
    },
    {
      id: "cat-003",
      slug: "missing-source",
      name: "Missing Source",
      description: "Cannot be installed from the catalog card",
      tags: ["docs"],
      installs: 10,
      installation: {
        installed: false,
        matchingSkillIds: [],
        matchingPaths: [],
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
    mockInstallSkill.mockResolvedValue({ success: true });
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

    it("renders install buttons only for catalog entries with a source repo", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Install Test Skill" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Install Another Skill" })).toBeTruthy();
      });

      expect(screen.queryByRole("button", { name: "Install Missing Source" })).toBeNull();
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

    it("keeps the discovered-skill row structure stable for enabled and disabled states", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.getByText("another-skill")).toBeTruthy();
      });

      const enabledRow = screen.getByText("test-skill").closest(".skills-view-item");
      const disabledRow = screen.getByText("another-skill").closest(".skills-view-item");
      const disabledToggle = screen.getByLabelText("Enable another-skill") as HTMLInputElement;
      const enabledToggle = screen.getByLabelText("Disable test-skill") as HTMLInputElement;

      expect(enabledRow?.querySelector(".skills-view-item-info")).toBeTruthy();
      expect(enabledRow?.querySelector(".skills-view-item-toggle")).toBeTruthy();
      expect(enabledRow?.querySelector(".skills-view-toggle-slider")).toBeTruthy();
      expect(disabledRow?.querySelector(".skills-view-item-info")).toBeTruthy();
      expect(disabledRow?.querySelector(".skills-view-item-toggle")).toBeTruthy();
      expect(disabledRow?.querySelector(".skills-view-toggle-slider")).toBeTruthy();

      await act(async () => {
        fireEvent.click(disabledToggle);
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Disable another-skill")).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(enabledToggle);
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Enable test-skill")).toBeTruthy();
      });

      const enabledRowAfterToggle = screen.getByText("test-skill").closest(".skills-view-item");
      const disabledRowAfterToggle = screen.getByText("another-skill").closest(".skills-view-item");

      expect(enabledRowAfterToggle?.querySelector(".skills-view-item-info")).toBeTruthy();
      expect(enabledRowAfterToggle?.querySelector(".skills-view-item-toggle")).toBeTruthy();
      expect(enabledRowAfterToggle?.querySelector(".skills-view-toggle-slider")).toBeTruthy();
      expect(disabledRowAfterToggle?.querySelector(".skills-view-item-info")).toBeTruthy();
      expect(disabledRowAfterToggle?.querySelector(".skills-view-item-toggle")).toBeTruthy();
      expect(disabledRowAfterToggle?.querySelector(".skills-view-toggle-slider")).toBeTruthy();
    });
  });

  describe("catalog install", () => {
    it("installs a catalog skill and refreshes discovered skills", async () => {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Install Test Skill" })).toBeTruthy();
      });

      mockFetchDiscoveredSkills.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Install Test Skill" }));
      });

      await waitFor(() => {
        expect(mockInstallSkill).toHaveBeenCalledWith("owner/test-repo", "test-skill", undefined);
        expect(mockFetchDiscoveredSkills).toHaveBeenCalledTimes(1);
        expect(mockAddToast).toHaveBeenCalledWith("Installed Test Skill", "success");
      });
    });

    it("shows an error toast when install fails", async () => {
      mockInstallSkill.mockRejectedValue(new Error("install failed"));

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Install Test Skill" })).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Install Test Skill" }));
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to install Test Skill: install failed"),
          "error",
        );
      });
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
    it("shows friendly error message for catalog fetch with upstream ApiRequestError", async () => {
      mockFetchSkillsCatalog.mockRejectedValue(
        Object.assign(new Error("Upstream returned 400: Bad Request"), {
          status: 502,
          details: { code: "upstream_http_error" },
        })
      );

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
      mockFetchSkillsCatalog.mockRejectedValue(
        Object.assign(new Error("Upstream returned 400: Bad Request"), {
          status: 502,
          details: { code: "upstream_http_error" },
        })
      );

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

    it("renders the shared ViewHeader and .skills-view-content sections", async () => {
      // FNXC:Navigation 2026-06-22-01:10: SkillsView migrated its bespoke
      // .skills-view-header to the shared ViewHeader (.view-header) modeled
      // after Command Center; assert the shared header element and that the
      // content sections still render below it.
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        const header = document.querySelector(".view-header");
        expect(header).toBeTruthy();
        expect(header?.querySelector(".view-header__title")?.textContent).toContain("Skills");
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

    it("declares ellipsis truncation for long and short discovered-skill row text", async () => {
      const longToken = "skill".repeat(30);
      const longSkill: DiscoveredSkill = {
        id: "github::skills/" + longToken,
        name: longToken,
        path: "/project/.fusion/skills/" + longToken,
        relativePath: "skills/" + longToken + "/nested/" + longToken,
        enabled: true,
        metadata: {
          source: "github.com/example/" + longToken + "/" + longToken,
          scope: "project",
          origin: "package",
        },
      };
      const emptyMetadataSkill = {
        id: "local::skills/empty-metadata",
        name: "empty-metadata-skill",
        path: "/project/.fusion/skills/empty-metadata",
        relativePath: "",
        enabled: false,
        metadata: {
          scope: "project",
          origin: "top-level",
        },
      } as unknown as DiscoveredSkill;
      mockFetchDiscoveredSkills.mockResolvedValue([
        mockDiscoveredSkills[0],
        longSkill,
        emptyMetadataSkill,
      ]);

      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText(longSkill.name)).toBeTruthy();
        expect(screen.getByText("test-skill")).toBeTruthy();
        expect(screen.getByText("empty-metadata-skill")).toBeTruthy();
      });

      const assertTruncation = (element: Element | null) => {
        expect(element).toBeTruthy();
        const styles = getComputedStyle(element as Element);
        expect(styles.overflow).toBe("hidden");
        expect(styles.textOverflow).toBe("ellipsis");
        expect(styles.whiteSpace).toBe("nowrap");
      };

      const longRow = screen.getByText(longSkill.name).closest(".skills-view-item");
      const shortRow = screen.getByText("test-skill").closest(".skills-view-item");
      const emptyMetadataRow = screen.getByText("empty-metadata-skill").closest(".skills-view-item");

      assertTruncation(longRow?.querySelector(".skills-view-item-name-text") ?? null);
      assertTruncation(longRow?.querySelector(".skills-view-item-path") ?? null);
      assertTruncation(longRow?.querySelector(".skills-view-item-source") ?? null);
      assertTruncation(shortRow?.querySelector(".skills-view-item-name-text") ?? null);
      assertTruncation(shortRow?.querySelector(".skills-view-item-path") ?? null);
      assertTruncation(shortRow?.querySelector(".skills-view-item-source") ?? null);

      expect(longRow?.querySelector(".skills-view-item-name svg")).toBeTruthy();
      expect(longRow?.querySelector(".skills-view-item-toggle")).toBeTruthy();
      expect(emptyMetadataRow?.querySelector(".skills-view-item-path")?.textContent).toBe("");
      expect(emptyMetadataRow?.querySelector(".skills-view-item-source")?.textContent).toBe("");
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
      mockFetchSkillsCatalog.mockRejectedValue(
        Object.assign(new Error("Upstream returned 400: Bad Request"), {
          status: 502,
          details: { code: "upstream_http_error" },
        })
      );

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

    it("displays skill content rendered as markdown when loaded", async () => {
      // FNXC:Skills 2026-06-23-04:15: SKILL.md now renders via MailboxMessageContent
      // (GitHub-flavored markdown) instead of a raw <pre>. Assert the markdown
      // wrapper (.mailbox-markdown / data-testid="skills-view-detail-markdown")
      // renders the heading text and the body, and that the (compact) files strip
      // shows the supplementary files.
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
        const markdown = screen.getByTestId("skills-view-detail-markdown");
        expect(markdown).toBeTruthy();
        expect(markdown.classList.contains("mailbox-markdown")).toBe(true);
        // No raw <pre> for the SKILL.md body anymore.
        expect(document.querySelector(".skills-view-detail-content")).toBeNull();
        expect(markdown.textContent).toContain("Test Skill");
        expect(markdown.textContent).toContain("This is the skill content.");
        // Heading renders as a real <h1> (markdown), not a literal "# Test Skill".
        expect(markdown.querySelector("h1")).toBeTruthy();
        const fileBadges = document.querySelectorAll(".skills-view-detail-files .badge");
        expect(fileBadges.length).toBe(2);
      });
    });

    it("collapses detail back to the empty-state when clicking the same skill again", async () => {
      // FNXC:Skills 2026-06-23-01:45: in the two-pane master/detail layout the
      // detail PANE (data-testid="skill-detail") is always mounted; clicking the
      // selected skill again clears the selection so the pane returns to its
      // empty-state placeholder (content gone), rather than unmounting.
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
        expect(screen.getByTestId("skills-view-detail-markdown")).toBeTruthy();
      });

      // Click again to collapse
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.queryByTestId("skill-detail")).toBeTruthy();
        expect(screen.queryByTestId("skills-view-detail-markdown")).toBeNull();
        expect(screen.getByTestId("skills-detail-empty")).toBeTruthy();
        expect(document.querySelector(".skills-view-item--selected")).toBeNull();
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
        const markdown = screen.getByTestId("skills-view-detail-markdown");
        expect(markdown).toBeTruthy();
        expect(markdown.textContent).toContain("Test Skill");
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
        const markdown = screen.getByTestId("skills-view-detail-markdown");
        expect(markdown).toBeTruthy();
        expect(markdown.textContent).toContain("Test Skill");
      });

      expect(mockFetchSkillContent).toHaveBeenCalledTimes(2);
    });

    it("clears the detail pane when the close button is clicked", async () => {
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
        expect(screen.getByTestId("skills-view-detail-markdown")).toBeTruthy();
      });

      // Click close button (detail-pane close, not the view close)
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Close skill detail"));
      });

      // FNXC:Skills 2026-06-23-01:45: the detail pane persists (two-pane layout);
      // Close clears the selection so it returns to the empty-state placeholder.
      await waitFor(() => {
        expect(screen.queryByTestId("skill-detail")).toBeTruthy();
        expect(screen.queryByTestId("skills-view-detail-markdown")).toBeNull();
        expect(screen.getByTestId("skills-detail-empty")).toBeTruthy();
      });
    });

    it("returns to the list via the narrow-mode back button (master→detail flow)", async () => {
      // FNXC:Skills 2026-06-23-01:45: NARROW single-panel master→detail flow.
      // Selecting a skill shows the detail ON TOP; the BACK affordance
      // (data-testid="skills-detail-back") clears the selection and returns to
      // the list. Asserts the back control exists and restores the empty-state.
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });

      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });

      await waitFor(() => {
        expect(screen.getByTestId("skills-view-detail-markdown")).toBeTruthy();
        expect(screen.getByTestId("skills-view").getAttribute("data-selected")).toBe("true");
      });

      const backButton = screen.getByTestId("skills-detail-back");
      expect(backButton).toBeTruthy();

      await act(async () => {
        fireEvent.click(backButton);
      });

      await waitFor(() => {
        expect(screen.getByTestId("skills-view").getAttribute("data-selected")).toBe("false");
        expect(screen.queryByTestId("skills-view-detail-markdown")).toBeNull();
        expect(screen.getByTestId("skills-detail-empty")).toBeTruthy();
        expect(document.querySelector(".skills-view-item--selected")).toBeNull();
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

  describe("skill file viewer", () => {
    // FNXC:Skills 2026-06-23-04:15: click-to-view-file + back flow. The files
    // strip lists ALL referenced files; file-type entries are clickable
    // (data-testid="skill-file-item") and load their content into the detail
    // pane (data-testid="skill-file-viewer"); a back affordance
    // (data-testid="skill-file-back") returns to the SKILL.md markdown view.
    const mockSkillContentWithFile: SkillContent = {
      name: "test-skill",
      skillMd: "# Test Skill\n\nSKILL body.",
      files: [
        { name: "reference.md", relativePath: "reference.md", type: "file" },
        { name: "script.sh", relativePath: "script.sh", type: "file" },
        { name: "references", relativePath: "references", type: "directory" },
      ],
    };

    beforeEach(() => {
      mockFetchSkillContent.mockResolvedValue(mockSkillContentWithFile);
    });

    async function openTestSkill() {
      render(<SkillsView addToast={mockAddToast} onClose={onClose} />);
      await waitFor(() => {
        expect(screen.getByText("test-skill")).toBeTruthy();
      });
      const testSkillItem = screen.getByText("test-skill").closest(".skills-view-item");
      await act(async () => {
        fireEvent.click(testSkillItem!);
      });
      await waitFor(() => {
        expect(screen.getByTestId("skills-view-detail-markdown")).toBeTruthy();
      });
    }

    it("renders ALL referenced files in the strip (files clickable, directories static)", async () => {
      await openTestSkill();

      const fileItems = screen.getAllByTestId("skill-file-item");
      // The two file entries are clickable buttons; the directory is not.
      expect(fileItems.length).toBe(2);
      expect(fileItems.map((el) => el.textContent)).toEqual(["reference.md", "script.sh"]);
      // Directory still rendered (all files shown), just not as a skill-file-item.
      expect(screen.getByText("references/")).toBeTruthy();
    });

    it("loads and renders a markdown file via MailboxMessageContent on click, then back returns to SKILL.md", async () => {
      mockFetchSkillFileContent.mockResolvedValue({
        name: "reference.md",
        relativePath: "reference.md",
        content: "## Reference\n\nFile body here.",
        isText: true,
      });

      await openTestSkill();

      const fileItems = screen.getAllByTestId("skill-file-item");
      await act(async () => {
        fireEvent.click(fileItems[0]!);
      });

      expect(mockFetchSkillFileContent).toHaveBeenCalledWith(
        "npm::skills/test-skill",
        "reference.md",
        undefined,
      );

      await waitFor(() => {
        const viewer = screen.getByTestId("skill-file-viewer");
        expect(viewer).toBeTruthy();
        // Markdown file -> rendered via MailboxMessageContent (mailbox-markdown wrapper).
        const markdown = viewer.querySelector(".mailbox-markdown");
        expect(markdown).toBeTruthy();
        expect(markdown!.textContent).toContain("Reference");
        expect(markdown!.textContent).toContain("File body here.");
        expect(markdown!.querySelector("h2")).toBeTruthy();
      });

      // Back to SKILL.md
      const back = screen.getByTestId("skill-file-back");
      await act(async () => {
        fireEvent.click(back);
      });

      await waitFor(() => {
        expect(screen.queryByTestId("skill-file-viewer")).toBeNull();
        expect(screen.getByTestId("skills-view-detail-markdown")).toBeTruthy();
        expect(screen.getByTestId("skills-view-detail-markdown").textContent).toContain("SKILL body.");
      });
    });

    it("renders a non-markdown text file in a <pre>", async () => {
      mockFetchSkillFileContent.mockResolvedValue({
        name: "script.sh",
        relativePath: "script.sh",
        content: "#!/bin/sh\necho hi",
        isText: true,
      });

      await openTestSkill();

      const fileItems = screen.getAllByTestId("skill-file-item");
      await act(async () => {
        fireEvent.click(fileItems[1]!);
      });

      await waitFor(() => {
        const viewer = screen.getByTestId("skill-file-viewer");
        const pre = viewer.querySelector("pre.skills-view-detail-content");
        expect(pre).toBeTruthy();
        expect(pre!.textContent).toContain("echo hi");
      });
    });

    it("shows a non-previewable notice for binary files", async () => {
      mockFetchSkillFileContent.mockResolvedValue({
        name: "script.sh",
        relativePath: "script.sh",
        content: "",
        isText: false,
      });

      await openTestSkill();

      const fileItems = screen.getAllByTestId("skill-file-item");
      await act(async () => {
        fireEvent.click(fileItems[1]!);
      });

      await waitFor(() => {
        expect(screen.getByText("This file cannot be previewed.")).toBeTruthy();
      });
    });

    it("shows an error + retry when file fetch fails", async () => {
      mockFetchSkillFileContent
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({
          name: "reference.md",
          relativePath: "reference.md",
          content: "ok",
          isText: true,
        });

      await openTestSkill();

      const fileItems = screen.getAllByTestId("skill-file-item");
      await act(async () => {
        fireEvent.click(fileItems[0]!);
      });

      await waitFor(() => {
        expect(screen.getByText("boom")).toBeTruthy();
        expect(screen.getByText("Retry")).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Retry"));
      });

      await waitFor(() => {
        expect(screen.getByTestId("skill-file-viewer").textContent).toContain("ok");
      });
    });
  });
});

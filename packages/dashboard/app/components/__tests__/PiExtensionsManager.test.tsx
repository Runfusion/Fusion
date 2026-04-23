import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PiExtensionsManager } from "../PiExtensionsManager";

// Mock API module
const mockFetchPiSettings = vi.fn();
const mockUpdatePiSettings = vi.fn();
const mockInstallPiPackage = vi.fn();
const mockFetchPiExtensions = vi.fn();
const mockUpdatePiExtensions = vi.fn();

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Package: ({ size }: { size?: number }) => (
    <span data-testid="icon-package">Package-{size || 16}</span>
  ),
  Puzzle: ({ size }: { size?: number }) => (
    <span data-testid="icon-puzzle">Puzzle-{size || 14}</span>
  ),
  BookOpen: ({ size }: { size?: number }) => (
    <span data-testid="icon-book">BookOpen-{size || 14}</span>
  ),
  FileText: ({ size }: { size?: number }) => (
    <span data-testid="icon-file">FileText-{size || 14}</span>
  ),
  Palette: ({ size }: { size?: number }) => (
    <span data-testid="icon-palette">Palette-{size || 14}</span>
  ),
  Plus: ({ size }: { size?: number }) => (
    <span data-testid="icon-plus">Plus-{size || 14}</span>
  ),
  X: ({ size }: { size?: number }) => (
    <span data-testid="icon-x">X-{size || 12}</span>
  ),
  ChevronDown: ({ size }: { size?: number }) => (
    <span data-testid="icon-chevron-down">ChevronDown-{size || 14}</span>
  ),
  ChevronRight: ({ size }: { size?: number }) => (
    <span data-testid="icon-chevron-right">ChevronRight-{size || 14}</span>
  ),
  RefreshCw: ({ size, className }: { size?: number; className?: string }) => (
    <span data-testid="icon-refresh" className={className}>
      RefreshCw-{size || 16}
    </span>
  ),
  Trash2: ({ size }: { size?: number }) => (
    <span data-testid="icon-trash">Trash2-{size || 14}</span>
  ),
}));

vi.mock("../../api", () => ({
  fetchPiSettings: (...args: unknown[]) => mockFetchPiSettings(...args),
  updatePiSettings: (...args: unknown[]) => mockUpdatePiSettings(...args),
  installPiPackage: (...args: unknown[]) => mockInstallPiPackage(...args),
  fetchPiExtensions: (...args: unknown[]) => mockFetchPiExtensions(...args),
  updatePiExtensions: (...args: unknown[]) => mockUpdatePiExtensions(...args),
}));

const mockPiSettings = {
  packages: [
    "npm:pi-example",
    "git:https://github.com/example/extension.git",
    { source: "npm:pi-with-filters", extensions: ["ext-a", "ext-b"], skills: ["skill-1"], prompts: [], themes: [] },
  ],
  extensions: ["/path/to/extension"],
  skills: ["/path/to/skill"],
  prompts: ["/path/to/prompts"],
  themes: ["/path/to/themes"],
};

const mockExtensions = [
  { id: "ext-1", name: "Example Extension", source: "fusion-global" as const, path: "/path/to/ext-1", enabled: true },
  { id: "ext-2", name: "Another Extension", source: "pi-project" as const, path: "/path/to/ext-2", enabled: false },
  { id: "ext-3", name: "Fusion Project Extension", source: "fusion-project" as const, path: "/path/to/ext-3", enabled: true },
  { id: "ext-4", name: "Package Extension", source: "package" as const, path: "/path/to/ext-4", enabled: true },
];

const mockExtensionsSettings = {
  extensions: mockExtensions,
  disabledIds: ["ext-2"],
  settingsPath: "/path/to/settings",
};

const addToast = vi.fn();

describe("PiExtensionsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Default mock for fetchPiExtensions to return empty settings
    mockFetchPiExtensions.mockResolvedValue({ extensions: [], disabledIds: [], settingsPath: "" });
    mockUpdatePiExtensions.mockResolvedValue({ extensions: [], disabledIds: [], settingsPath: "" });
  });

  describe("Rendering", () => {
    it("renders Pi Extensions header", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Pi Extensions" })).toBeTruthy();
      });
    });

    it("renders add package form", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add/i })).toBeTruthy();
      });
    });

    it("renders package list with source badges", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getAllByText("npm")).toHaveLength(2); // npm:pi-example and npm:pi-with-filters
        expect(screen.getByText("git")).toBeTruthy();
        expect(screen.getByText("pi-example")).toBeTruthy();
        expect(screen.getByText(/github\.com\/example\/extension\.git/i)).toBeTruthy();
      });
    });

    it("renders top-level resource sections", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Extensions")).toBeTruthy();
        expect(screen.getByText("Skills")).toBeTruthy();
        expect(screen.getByText("Prompts")).toBeTruthy();
        expect(screen.getByText("Themes")).toBeTruthy();
      });
    });

    it("renders resource paths as removable tags", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("/path/to/extension")).toBeTruthy();
        expect(screen.getByText("/path/to/skill")).toBeTruthy();
        expect(screen.getByText("/path/to/prompts")).toBeTruthy();
        expect(screen.getByText("/path/to/themes")).toBeTruthy();
      });
    });
  });

  describe("Loading state", () => {
    it("shows loading state while fetching settings", async () => {
      mockFetchPiSettings.mockImplementation(() => new Promise(() => {}));
      render(<PiExtensionsManager addToast={addToast} />);

      expect(screen.getByText("Loading Pi settings…")).toBeTruthy();
    });

    it("refresh button shows spinning class while loading", async () => {
      mockFetchPiSettings.mockImplementation(() => new Promise(() => {}));
      render(<PiExtensionsManager addToast={addToast} />);

      const refreshIcons = screen.getAllByTestId("icon-refresh");
      expect(refreshIcons.length).toBeGreaterThan(0);
      refreshIcons.forEach((icon) => {
        expect(icon).toHaveClass("spin");
      });
    });
  });

  describe("Empty state", () => {
    it("shows empty state when no packages configured", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No packages configured.")).toBeTruthy();
      });
      expect(screen.getByText(/Add a package source above to get started/)).toBeTruthy();
    });

    it("shows Package icon in empty state", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const emptyState = screen.getByText("No packages configured.").closest(".empty-state");
        expect(emptyState?.querySelector('[data-testid="icon-package"]')).toBeTruthy();
      });
    });
  });

  describe("Add package form", () => {
    it("calls installPiPackage when Add button is clicked", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
      mockInstallPiPackage.mockResolvedValueOnce({ success: true });
      // Second call to loadSettings after install completes
      mockFetchPiSettings.mockResolvedValueOnce({ packages: ["npm:new-package"], extensions: [], skills: [], prompts: [], themes: [] });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No packages configured.")).toBeTruthy();
      });

      await userEvent.type(screen.getByRole("textbox"), "npm:new-package");
      await userEvent.click(screen.getByRole("button", { name: /Add/i }));

      await waitFor(() => {
        expect(mockInstallPiPackage).toHaveBeenCalledWith("npm:new-package");
      });

      // Wait for refresh after install
      await waitFor(() => {
        expect(screen.queryByText("No packages configured.")).not.toBeTruthy();
      });
    });

    it("shows error toast when install fails", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
      mockInstallPiPackage.mockRejectedValueOnce(new Error("Install failed"));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No packages configured.")).toBeTruthy();
      });

      await userEvent.type(screen.getByRole("textbox"), "npm:failing-package");
      await userEvent.click(screen.getByRole("button", { name: /Add/i }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to install package: Install failed", "error");
      });
    });

    it("shows loading state while installing", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
      mockInstallPiPackage.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100)));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No packages configured.")).toBeTruthy();
      });

      await userEvent.type(screen.getByRole("textbox"), "npm:slow-package");
      await userEvent.click(screen.getByRole("button", { name: /Add/i }));

      expect(screen.getByRole("button", { name: /Installing/ })).toBeTruthy();
    });

    it("validates non-empty input — button disabled when empty", async () => {
      mockFetchPiSettings.mockResolvedValueOnce({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No packages configured.")).toBeTruthy();
      });

      // Button should be disabled when input is empty
      const addBtn = screen.getByRole("button", { name: /Add/i });
      expect(addBtn).toBeDisabled();
      expect(mockInstallPiPackage).not.toHaveBeenCalled();
    });
  });

  describe("Remove package", () => {
    it("calls updatePiSettings with package removed from list", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockUpdatePiSettings.mockResolvedValueOnce({ success: true });
      mockFetchPiSettings.mockResolvedValueOnce({
        packages: [mockPiSettings.packages[1], mockPiSettings.packages[2]],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("pi-example")).toBeTruthy();
      });

      // Find the remove button for the first package (npm:pi-example)
      const removeButtons = screen.getAllByTestId("icon-trash");
      await userEvent.click(removeButtons[0]);

      await waitFor(() => {
        expect(mockUpdatePiSettings).toHaveBeenCalledWith({
          packages: [mockPiSettings.packages[1], mockPiSettings.packages[2]],
        });
      });
    });
  });

  describe("Remove resource", () => {
    it("calls updatePiSettings to remove an extension path", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockUpdatePiSettings.mockResolvedValueOnce({ success: true });
      mockFetchPiSettings.mockResolvedValueOnce({
        ...mockPiSettings,
        extensions: [],
      });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("/path/to/extension")).toBeTruthy();
      });

      // Find the remove button for the extension
      const removeButtons = screen.getAllByTestId("icon-x");
      await userEvent.click(removeButtons[0]);

      await waitFor(() => {
        expect(mockUpdatePiSettings).toHaveBeenCalledWith({
          extensions: [],
        });
      });
    });
  });

  describe("Expand/collapse object-form packages", () => {
    it("shows filter list when package with filters is expanded", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("pi-with-filters")).toBeTruthy();
      });

      // Find the expand button for pi-with-filters (the 3rd package, has filter-hint)
      const filterHint = screen.getByText(/2 ext/);
      const expandBtn = filterHint.closest(".pi-ext-package-card")?.querySelector(".pi-ext-expand-btn");
      expect(expandBtn).toBeTruthy();

      await userEvent.click(expandBtn!);

      await waitFor(() => {
        expect(screen.getByText("Extensions:", { exact: false })).toBeTruthy();
      });
      await waitFor(() => {
        expect(screen.getByText("ext-a")).toBeTruthy();
      });
      expect(screen.getByText("ext-b")).toBeTruthy();
      expect(screen.getByText("skill-1")).toBeTruthy();
    });

    it("hides filter list when collapsed", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("pi-with-filters")).toBeTruthy();
      });

      // Expand
      const filterHint = screen.getByText(/2 ext/);
      const expandBtn = filterHint.closest(".pi-ext-package-card")?.querySelector(".pi-ext-expand-btn");
      await userEvent.click(expandBtn!);

      await waitFor(() => {
        expect(screen.getByText("ext-a")).toBeTruthy();
      });

      // Collapse
      const chevronDown = screen.getAllByTestId("icon-chevron-down")[0];
      await userEvent.click(chevronDown);

      await waitFor(() => {
        expect(screen.queryByText("ext-a")).not.toBeTruthy();
      });
    });
  });

  describe("Error handling", () => {
    it("shows error toast when fetch fails", async () => {
      mockFetchPiSettings.mockRejectedValueOnce(new Error("Network error"));
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load Pi settings: Network error", "error");
      });
    });

    it("shows error toast when update fails", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockUpdatePiSettings.mockRejectedValueOnce(new Error("Update failed"));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("pi-example")).toBeTruthy();
      });

      const removeButtons = screen.getAllByTestId("icon-trash");
      await userEvent.click(removeButtons[0]);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to remove package: Update failed", "error");
      });
    });
  });

  describe("Discovered Extensions Section", () => {
    it("renders discovered extensions section header", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Discovered Extensions" })).toBeTruthy();
      });
    });

    it("renders extension entries from fetchPiExtensions", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Example Extension")).toBeTruthy();
        expect(screen.getByText("Another Extension")).toBeTruthy();
        expect(screen.getByText("Fusion Project Extension")).toBeTruthy();
        expect(screen.getByText("Package Extension")).toBeTruthy();
      });
    });

    it("shows source badges for each extension", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Fusion Global")).toBeTruthy();
        expect(screen.getByText("Pi Project")).toBeTruthy();
        expect(screen.getByText("Fusion Project")).toBeTruthy();
        expect(screen.getByText("Package")).toBeTruthy();
      });
    });

    it("displays extension paths", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("/path/to/ext-1")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-2")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-3")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-4")).toBeTruthy();
      });
    });

    it("renders toggle switches for each extension", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const toggles = screen.getAllByRole("checkbox");
        expect(toggles).toHaveLength(4);
        expect(toggles[0]).toBeChecked(); // ext-1 enabled
        expect(toggles[1]).not.toBeChecked(); // ext-2 disabled
        expect(toggles[2]).toBeChecked(); // ext-3 enabled
        expect(toggles[3]).toBeChecked(); // ext-4 enabled
      });
    });

    it("coexists with existing global package/path UI", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        // Global package UI
        expect(screen.getByText("pi-example")).toBeTruthy();
        // Discovered extensions
        expect(screen.getByText("Example Extension")).toBeTruthy();
      });
    });

    it("forwards projectId to fetchPiExtensions", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });

      render(<PiExtensionsManager addToast={addToast} projectId="test-project-123" />);

      await waitFor(() => {
        expect(mockFetchPiExtensions).toHaveBeenCalledWith("test-project-123");
      });
    });

    it("toggles extension enabled state", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensionsSettings);
      mockUpdatePiExtensions.mockResolvedValueOnce(undefined);

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const toggles = screen.getAllByRole("checkbox");
        expect(toggles[0]).toBeChecked();
      });

      // Click the first toggle to disable
      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[0]);

      await waitFor(() => {
        expect(mockUpdatePiExtensions).toHaveBeenCalled();
      });
    });

    it("shows error toast when fetch extensions fails", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockRejectedValueOnce(new Error("Failed to load"));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load extensions: Failed to load", "error");
      });
    });

    it("shows empty state when no extensions found", async () => {
      mockFetchPiSettings.mockResolvedValueOnce(mockPiSettings);
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No extensions discovered.")).toBeTruthy();
      });
    });
  });
});
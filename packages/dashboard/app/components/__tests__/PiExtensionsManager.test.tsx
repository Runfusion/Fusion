import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PiExtensionsManager } from "../PiExtensionsManager";
import type { PiExtensionSettings } from "../../api";

// Mock API module - must be declared before import
const mockFetchPiExtensions = vi.fn();
const mockUpdatePiExtensions = vi.fn();

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Package: ({ size }: { size?: number }) => (
    <span data-testid="icon-package">Package-{size || 16}</span>
  ),
  RefreshCw: ({ size, className }: { size?: number; className?: string }) => (
    <span data-testid="icon-refresh" className={className}>
      RefreshCw-{size || 16}
    </span>
  ),
}));

vi.mock("../../api", () => ({
  fetchPiExtensions: (...args: unknown[]) => mockFetchPiExtensions(...args),
  updatePiExtensions: (...args: unknown[]) => mockUpdatePiExtensions(...args),
}));

const mockExtensions: PiExtensionSettings = {
  extensions: [
    {
      id: "ext-1",
      name: "Test Extension 1",
      path: "/path/to/ext-1",
      source: "fusion-global",
      enabled: true,
    },
    {
      id: "ext-2",
      name: "Test Extension 2",
      path: "/path/to/ext-2",
      source: "pi-global",
      enabled: false,
    },
    {
      id: "ext-3",
      name: "Test Extension 3",
      path: "/path/to/ext-3",
      source: "fusion-project",
      enabled: true,
    },
    {
      id: "ext-4",
      name: "Test Extension 4",
      path: "/path/to/ext-4",
      source: "pi-project",
      enabled: false,
    },
  ],
  disabledIds: ["ext-2", "ext-4"],
  settingsPath: "/path/to/settings.json",
};

const addToast = vi.fn();

describe("PiExtensionsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  describe("Rendering", () => {
    it("renders Pi Extensions header", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} />);
      await waitFor(() => expect(screen.getByRole("heading", { name: /Pi Extensions/i })).toBeTruthy());
    });

    it("renders extension list with names and toggle switches", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      render(<PiExtensionsManager addToast={addToast} />);

      // Both extension names should be visible
      await waitFor(() => {
        expect(screen.getByText("Test Extension 1")).toBeTruthy();
        expect(screen.getByText("Test Extension 2")).toBeTruthy();
      });

      // Both toggle switches should be present
      const toggles = screen.getAllByRole("checkbox");
      expect(toggles).toHaveLength(4);

      // Enabled extension should be checked, disabled should be unchecked
      expect(toggles[0]).toBeChecked(); // ext-1 enabled
      expect(toggles[1]).not.toBeChecked(); // ext-2 disabled
      expect(toggles[2]).toBeChecked(); // ext-3 enabled
      expect(toggles[3]).not.toBeChecked(); // ext-4 disabled
    });

    it("shows source badges with correct labels", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Fusion Global")).toBeTruthy();
        expect(screen.getByText("Pi Global")).toBeTruthy();
        expect(screen.getByText("Fusion Project")).toBeTruthy();
        expect(screen.getByText("Pi Project")).toBeTruthy();
      });
    });

    it("shows source badges with correct CSS classes", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const fusionGlobalBadge = screen.getByText("Fusion Global").closest(".pi-ext-source-badge");
        expect(fusionGlobalBadge).toHaveClass("pi-ext-source-badge--global");

        const piGlobalBadge = screen.getByText("Pi Global").closest(".pi-ext-source-badge");
        expect(piGlobalBadge).toHaveClass("pi-ext-source-badge--global");

        const fusionProjectBadge = screen.getByText("Fusion Project").closest(".pi-ext-source-badge");
        expect(fusionProjectBadge).toHaveClass("pi-ext-source-badge--project");

        const piProjectBadge = screen.getByText("Pi Project").closest(".pi-ext-source-badge");
        expect(piProjectBadge).toHaveClass("pi-ext-source-badge--project");
      });
    });

    it("shows extension paths", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("/path/to/ext-1")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-2")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-3")).toBeTruthy();
        expect(screen.getByText("/path/to/ext-4")).toBeTruthy();
      });
    });

    it("renders description text explaining pi extensions", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText(/Choose which project and global Pi extensions/)).toBeTruthy();
      });
    });

    it("passes projectId to fetchPiExtensions", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} projectId="proj-123" />);
      await waitFor(() => {
        expect(mockFetchPiExtensions).toHaveBeenCalledWith("proj-123");
      });
    });
  });

  describe("Loading state", () => {
    it("shows loading state while fetching extensions", async () => {
      mockFetchPiExtensions.mockImplementation(() => new Promise(() => {}));
      render(<PiExtensionsManager addToast={addToast} />);

      expect(screen.getByText("Loading Pi extensions…")).toBeTruthy();
    });

    it("refresh button shows spinning class while loading", async () => {
      mockFetchPiExtensions.mockImplementation(() => new Promise(() => {}));
      render(<PiExtensionsManager addToast={addToast} />);

      const refreshBtn = screen.getByTestId("icon-refresh");
      expect(refreshBtn).toHaveClass("spin");
    });
  });

  describe("Empty state", () => {
    it("shows empty state when no extensions found", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("No Pi extensions found.")).toBeTruthy();
      });
      expect(screen.getByText(/Extensions are discovered from ~\/\.fusion\/agent/)).toBeTruthy();
    });

    it("shows Package icon in empty state", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("icon-package")).toBeTruthy();
      });
    });
  });

  describe("Toggle interactions", () => {
    it("toggles extension on - enables disabled extension", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      mockUpdatePiExtensions.mockResolvedValueOnce({
        ...mockExtensions,
        extensions: mockExtensions.extensions.map((ext) =>
          ext.id === "ext-2" ? { ...ext, enabled: true } : ext
        ),
        disabledIds: ["ext-4"],
      });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const toggles = screen.getAllByRole("checkbox");
        expect(toggles[1]).not.toBeChecked();
      });

      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[1]); // ext-2 is disabled, click to enable

      await waitFor(() => {
        expect(mockUpdatePiExtensions).toHaveBeenCalledWith(["ext-4"], undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Pi extension settings saved", "success");
    });

    it("toggles extension off - disables enabled extension", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      mockUpdatePiExtensions.mockResolvedValueOnce({
        ...mockExtensions,
        extensions: mockExtensions.extensions.map((ext) =>
          ext.id === "ext-1" ? { ...ext, enabled: false } : ext
        ),
        disabledIds: ["ext-2", "ext-4", "ext-1"],
      });

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const toggles = screen.getAllByRole("checkbox");
        expect(toggles[0]).toBeChecked();
      });

      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[0]); // ext-1 is enabled, click to disable

      await waitFor(() => {
        expect(mockUpdatePiExtensions).toHaveBeenCalledWith(["ext-2", "ext-4", "ext-1"], undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Pi extension settings saved", "success");
    });

    it("disables toggle while saving", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      mockUpdatePiExtensions.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockExtensions), 100))
      );

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        const toggles = screen.getAllByRole("checkbox");
        expect(toggles[0]).toBeChecked();
      });

      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[0]);

      // Toggle should be disabled while saving
      expect(toggles[0]).toBeDisabled();
    });
  });

  describe("Refresh button", () => {
    it("refresh button triggers reload", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getAllByRole("checkbox")).toHaveLength(4);
      });

      mockFetchPiExtensions.mockResolvedValueOnce({ extensions: [], disabledIds: [], settingsPath: "" });

      const refreshBtn = screen.getByTestId("icon-refresh").closest("button");
      await userEvent.click(refreshBtn!);

      await waitFor(() => {
        expect(mockFetchPiExtensions).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("Error handling", () => {
    it("shows error toast when fetch fails", async () => {
      mockFetchPiExtensions.mockRejectedValueOnce(new Error("Network error"));
      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load Pi extensions: Network error", "error");
      });
    });

    it("shows error toast when update fails", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      mockUpdatePiExtensions.mockRejectedValueOnce(new Error("Update failed"));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getAllByRole("checkbox")).toHaveLength(4);
      });

      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[0]);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Update failed", "error");
      });
    });

    it("displays specific error message from API", async () => {
      mockFetchPiExtensions.mockResolvedValueOnce(mockExtensions);
      mockUpdatePiExtensions.mockRejectedValueOnce(new Error("Extension file not found"));

      render(<PiExtensionsManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getAllByRole("checkbox")).toHaveLength(4);
      });

      const toggles = screen.getAllByRole("checkbox");
      await userEvent.click(toggles[0]);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Extension file not found", "error");
      });
    });
  });
});

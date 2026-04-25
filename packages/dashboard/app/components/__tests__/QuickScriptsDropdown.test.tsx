import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuickScriptsDropdown } from "../QuickScriptsDropdown";

// Mock the API functions
const mockFetchScripts = vi.fn();

vi.mock("../../api", () => ({
  fetchScripts: () => mockFetchScripts(),
}));

const mockOnOpenScripts = vi.fn();
const mockOnRunScript = vi.fn();

function renderDropdown(props = {}) {
  return render(
    <QuickScriptsDropdown
      onOpenScripts={mockOnOpenScripts}
      onRunScript={mockOnRunScript}
      {...props}
    />
  );
}

describe("QuickScriptsDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders the trigger button", () => {
      renderDropdown();
      expect(screen.getByTestId("scripts-btn")).toBeDefined();
      expect(screen.getByTitle("Scripts")).toBeDefined();
    });

    it("does not show dropdown menu initially", () => {
      renderDropdown();
      expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
    });
  });

  describe("dropdown open/close", () => {
    it("opens dropdown when trigger is clicked", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });
    });

    it("closes dropdown when clicking outside", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });

    it("closes dropdown on Escape key", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });

    it("closes dropdown when trigger is clicked again", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });
  });

  describe("fetching and displaying scripts", () => {
    it("shows loading state while fetching", async () => {
      mockFetchScripts.mockImplementation(() => new Promise(() => {}));
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      expect(screen.getByTestId("quick-scripts-loading")).toBeDefined();
    });

    it("fetches and displays scripts", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
        test: "npm test",
        lint: "npm run lint",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-build")).toBeDefined();
        expect(screen.getByTestId("quick-script-item-test")).toBeDefined();
        expect(screen.getByTestId("quick-script-item-lint")).toBeDefined();
      });
    });

    it("displays script names and truncated commands", async () => {
      mockFetchScripts.mockResolvedValue({
        "long-command": "this is a very long command that should be truncated",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        const item = screen.getByTestId("quick-script-item-long-command");
        expect(item.textContent).toContain("long-command");
        expect(item.textContent).toContain("this is a very long command that should be truncat...");
      });
    });

    it("handles short commands without truncation", async () => {
      mockFetchScripts.mockResolvedValue({
        short: "echo hi",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        const item = screen.getByTestId("quick-script-item-short");
        expect(item.textContent).toContain("short");
        expect(item.textContent).toContain("echo hi");
      });
    });

    it("sorts scripts alphabetically", async () => {
      mockFetchScripts.mockResolvedValue({
        zebra: "echo zebra",
        alpha: "echo alpha",
        beta: "echo beta",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        const items = screen.getAllByRole("option");
        expect(items[0].textContent).toContain("alpha");
        expect(items[1].textContent).toContain("beta");
        expect(items[2].textContent).toContain("zebra");
      });
    });
  });

  describe("running scripts", () => {
    it("calls onRunScript when a script is clicked", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-build")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("quick-script-item-build"));

      expect(mockOnRunScript).toHaveBeenCalledWith("build", "npm run build");
    });

    it("closes dropdown after running script", async () => {
      mockFetchScripts.mockResolvedValue({
        test: "npm test",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-test")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("quick-script-item-test"));

      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });
  });

  describe("manage scripts link", () => {
    it("shows 'Manage Scripts...' link when scripts exist", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-manage")).toBeDefined();
      });
    });

    it("calls onOpenScripts when 'Manage Scripts...' is clicked", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-manage")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("quick-scripts-manage"));

      expect(mockOnOpenScripts).toHaveBeenCalled();
    });

    it("closes dropdown when 'Manage Scripts...' is clicked", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-manage")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("quick-scripts-manage"));

      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });
  });

  describe("empty state", () => {
    it("shows empty state when no scripts configured", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-empty")).toBeDefined();
      });
    });

    it("empty state shows 'Add your first script' button", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByText("Add your first script")).toBeDefined();
      });
    });

    it("clicking 'Add your first script' calls onOpenScripts", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByText("Add your first script")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Add your first script"));

      expect(mockOnOpenScripts).toHaveBeenCalled();
    });

    it("closes dropdown when empty state action is clicked", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByText("Add your first script")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Add your first script"));

      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });
    });
  });

  describe("keyboard navigation", () => {
    it("supports ArrowDown to highlight items", async () => {
      mockFetchScripts.mockResolvedValue({
        alpha: "echo alpha",
        beta: "echo beta",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // First ArrowDown highlights first item
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(screen.getByTestId("quick-script-item-alpha").className).toContain("highlighted");

      // Second ArrowDown highlights second item
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(screen.getByTestId("quick-script-item-beta").className).toContain("highlighted");
    });

    it("supports ArrowUp to highlight items", async () => {
      mockFetchScripts.mockResolvedValue({
        alpha: "echo alpha",
        beta: "echo beta",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // Go to bottom first with End key
      fireEvent.keyDown(menu, { key: "End" });

      // ArrowUp moves to previous item
      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(screen.getByTestId("quick-script-item-beta").className).toContain("highlighted");
    });

    it("wraps around with arrow keys", async () => {
      mockFetchScripts.mockResolvedValue({
        alpha: "echo alpha",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // ArrowUp from start wraps to end (Manage Scripts...)
      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(screen.getByTestId("quick-scripts-manage").className).toContain("highlighted");

      // ArrowDown from end wraps to start
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(screen.getByTestId("quick-script-item-alpha").className).toContain("highlighted");
    });

    it("runs script with Enter key", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-build")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // Highlight and press Enter
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      fireEvent.keyDown(menu, { key: "Enter" });

      expect(mockOnRunScript).toHaveBeenCalledWith("build", "npm run build");
    });

    it("opens manage scripts with Enter key on manage button", async () => {
      mockFetchScripts.mockResolvedValue({
        build: "npm run build",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-manage")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // Navigate to last item (Manage Scripts...) and press Enter
      fireEvent.keyDown(menu, { key: "End" });
      fireEvent.keyDown(menu, { key: "Enter" });

      expect(mockOnOpenScripts).toHaveBeenCalled();
    });

    it("supports Home key to go to first item", async () => {
      mockFetchScripts.mockResolvedValue({
        alpha: "echo alpha",
        beta: "echo beta",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      // Go to end first
      fireEvent.keyDown(menu, { key: "End" });
      // Home goes to first
      fireEvent.keyDown(menu, { key: "Home" });

      expect(screen.getByTestId("quick-script-item-alpha").className).toContain("highlighted");
    });

    it("supports End key to go to last item", async () => {
      mockFetchScripts.mockResolvedValue({
        alpha: "echo alpha",
        beta: "echo beta",
      });
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-script-item-alpha")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");

      fireEvent.keyDown(menu, { key: "End" });

      expect(screen.getByTestId("quick-scripts-manage").className).toContain("highlighted");
    });
  });

  describe("error handling", () => {
    it("handles fetch errors gracefully", async () => {
      mockFetchScripts.mockRejectedValue(new Error("Failed to fetch"));
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));

      await waitFor(() => {
        // Should show empty state since scripts will be empty object on error
        expect(screen.getByTestId("quick-scripts-empty")).toBeDefined();
      });
    });
  });

  describe("focus management", () => {
    it("menu is focusable with tabIndex", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });

      const menu = screen.getByTestId("quick-scripts-dropdown");
      expect(menu).toHaveAttribute("tabIndex", "-1");
    });

    it("focus moves to trigger when Escape is pressed", async () => {
      mockFetchScripts.mockResolvedValue({});
      renderDropdown();

      fireEvent.click(screen.getByTestId("scripts-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("quick-scripts-dropdown")).toBeDefined();
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByTestId("quick-scripts-dropdown")).toBeNull();
      });

      // Trigger should have focus
      expect(document.activeElement).toBe(screen.getByTestId("scripts-btn"));
    });
  });
});

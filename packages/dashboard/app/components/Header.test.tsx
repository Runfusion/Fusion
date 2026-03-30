import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "./Header";

const noop = () => {};

function renderHeader(props = {}) {
  return render(
    <Header
      onOpenSettings={noop}
      onOpenGitHubImport={noop}
      globalPaused={false}
      enginePaused={false}
      onToggleGlobalPause={noop}
      onToggleEnginePause={noop}
      {...props}
    />
  );
}

describe("Header", () => {
  it("renders the logo and brand", () => {
    renderHeader();
    expect(screen.getByText("Fusion")).toBeDefined();
    expect(screen.getByText("tasks")).toBeDefined();
  });

  it("renders action buttons", () => {
    renderHeader();
    expect(screen.getByTitle("Import from GitHub")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();
  });

  it("calls onOpenSettings when settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings });
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("calls onOpenGitHubImport when import button is clicked", () => {
    const onOpenGitHubImport = vi.fn();
    renderHeader({ onOpenGitHubImport });
    fireEvent.click(screen.getByTitle("Import from GitHub"));
    expect(onOpenGitHubImport).toHaveBeenCalled();
  });

  describe("view toggle", () => {
    it("does not render view toggle when onChangeView is not provided", () => {
      renderHeader();
      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTitle("List view")).toBeNull();
    });

    it("renders view toggle when onChangeView is provided", () => {
      renderHeader({ onChangeView: noop });
      expect(screen.getByTitle("Board view")).toBeDefined();
      expect(screen.getByTitle("List view")).toBeDefined();
    });

    it("shows board view as active by default", () => {
      renderHeader({ onChangeView: noop });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).toContain("active");
      expect(listBtn.className).not.toContain("active");
    });

    it("shows list view as active when view is 'list'", () => {
      renderHeader({ onChangeView: noop, view: "list" });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).not.toContain("active");
      expect(listBtn.className).toContain("active");
    });

    it("calls onChangeView with 'board' when clicking board view button", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "list" });
      fireEvent.click(screen.getByTitle("Board view"));
      expect(onChangeView).toHaveBeenCalledWith("board");
    });

    it("calls onChangeView with 'list' when clicking list view button", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "board" });
      fireEvent.click(screen.getByTitle("List view"));
      expect(onChangeView).toHaveBeenCalledWith("list");
    });

    it("has correct aria attributes for accessibility", () => {
      renderHeader({ onChangeView: noop, view: "board" });
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("terminal button", () => {
    it("renders terminal button with correct title", () => {
      renderHeader({ onToggleTerminal: noop });
      expect(screen.getByTitle("Open Terminal")).toBeDefined();
    });

    it("calls onToggleTerminal when terminal button is clicked", () => {
      const onToggleTerminal = vi.fn();
      renderHeader({ onToggleTerminal });
      fireEvent.click(screen.getByTitle("Open Terminal"));
      expect(onToggleTerminal).toHaveBeenCalled();
    });

    it("is always enabled regardless of task state", () => {
      renderHeader({ onToggleTerminal: noop });
      const btn = screen.getByTitle("Open Terminal");
      expect(btn.hasAttribute("disabled")).toBe(false);
    });
  });

  describe("pause controls", () => {
    it("renders pause button for engine pause", () => {
      renderHeader();
      expect(screen.getByTitle("Pause scheduling")).toBeDefined();
    });

    it("renders stop button for global pause", () => {
      renderHeader();
      expect(screen.getByTitle("Stop AI engine")).toBeDefined();
    });

    it("calls onToggleEnginePause when pause button is clicked", () => {
      const onToggleEnginePause = vi.fn();
      renderHeader({ onToggleEnginePause });
      fireEvent.click(screen.getByTitle("Pause scheduling"));
      expect(onToggleEnginePause).toHaveBeenCalled();
    });

    it("calls onToggleGlobalPause when stop button is clicked", () => {
      const onToggleGlobalPause = vi.fn();
      renderHeader({ onToggleGlobalPause });
      fireEvent.click(screen.getByTitle("Stop AI engine"));
      expect(onToggleGlobalPause).toHaveBeenCalled();
    });

    it("shows resume text when engine is paused", () => {
      renderHeader({ enginePaused: true });
      expect(screen.getByTitle("Resume scheduling")).toBeDefined();
    });

    it("shows start text when global is paused", () => {
      renderHeader({ globalPaused: true });
      expect(screen.getByTitle("Start AI engine")).toBeDefined();
    });
  });

  describe("usage button", () => {
    it("does not render usage button when onOpenUsage is not provided", () => {
      renderHeader();
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("renders usage button with correct title when onOpenUsage is provided", () => {
      renderHeader({ onOpenUsage: vi.fn() });
      expect(screen.getByTitle("View usage")).toBeDefined();
    });

    it("calls onOpenUsage when usage button is clicked", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage });
      fireEvent.click(screen.getByTitle("View usage"));
      expect(onOpenUsage).toHaveBeenCalled();
    });
  });

  describe("planning button", () => {
    it("renders planning button with correct title", () => {
      renderHeader({ onOpenPlanning: vi.fn() });
      expect(screen.getByTitle("Create a task with AI planning")).toBeDefined();
    });

    it("calls onOpenPlanning when planning button is clicked", () => {
      const onOpenPlanning = vi.fn();
      renderHeader({ onOpenPlanning });
      fireEvent.click(screen.getByTitle("Create a task with AI planning"));
      expect(onOpenPlanning).toHaveBeenCalled();
    });

    it("has correct data-testid for testing", () => {
      renderHeader({ onOpenPlanning: vi.fn() });
      expect(screen.getByTestId("planning-btn")).toBeDefined();
    });
  });

  describe("search functionality", () => {
    it("does not render search input when onSearchChange is not provided", () => {
      renderHeader({ view: "board" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("renders search input when onSearchChange and view='board' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("does not render search input when view is 'list'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("calls onSearchChange when typing in search input", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      const input = screen.getByPlaceholderText("Search tasks...");
      fireEvent.change(input, { target: { value: "test query" } });
      expect(onSearchChange).toHaveBeenCalledWith("test query");
    });

    it("shows clear button when search query is not empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "test" });
      expect(screen.getByLabelText("Clear search")).toBeDefined();
    });

    it("does not show clear button when search query is empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "" });
      expect(screen.queryByLabelText("Clear search")).toBeNull();
    });

    it("calls onSearchChange with empty string when clear button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board", searchQuery: "test" });
      fireEvent.click(screen.getByLabelText("Clear search"));
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("search input has correct placeholder text", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      const input = screen.getByPlaceholderText("Search tasks...");
      expect(input).toBeDefined();
    });
  });
});

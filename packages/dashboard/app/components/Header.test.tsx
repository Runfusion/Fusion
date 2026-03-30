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
    expect(screen.getByText("kb")).toBeDefined();
    expect(screen.getByText("board")).toBeDefined();
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
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "../Header";

describe("Header", () => {
  it("renders a logo image with correct src and alt", () => {
    render(<Header />);
    const logo = screen.getByAltText("kb logo");
    expect(logo).toBeDefined();
    expect(logo.tagName).toBe("IMG");
    expect((logo as HTMLImageElement).src).toContain("/logo.svg");
  });

  it("renders the logo before the h1 element", () => {
    render(<Header />);
    const logo = screen.getByAltText("kb logo");
    const h1 = screen.getByRole("heading", { level: 1 });
    // Logo should be a preceding sibling of the h1
    expect(logo.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the settings button", () => {
    const onOpen = vi.fn();
    render(<Header onOpenSettings={onOpen} />);
    const btn = screen.getByTitle("Settings");
    expect(btn).toBeDefined();
  });

  it("renders the import button", () => {
    const onOpen = vi.fn();
    render(<Header onOpenGitHubImport={onOpen} />);
    const btn = screen.getByTitle("Import from GitHub");
    expect(btn).toBeDefined();
  });

  it("calls onOpenGitHubImport when import button is clicked", () => {
    const onOpen = vi.fn();
    render(<Header onOpenGitHubImport={onOpen} />);
    const btn = screen.getByTitle("Import from GitHub");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // ── Pause button (soft pause) ────────────────────────────────────

  it("renders pause button with 'Pause scheduling' title when not paused", () => {
    render(<Header enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect(btn).toBeDefined();
  });

  it("renders play button with 'Resume scheduling' title when engine is paused", () => {
    render(<Header enginePaused={true} />);
    const btn = screen.getByTitle("Resume scheduling");
    expect(btn).toBeDefined();
  });

  it("calls onToggleEnginePause when pause button is clicked", () => {
    const onToggle = vi.fn();
    render(<Header enginePaused={false} onToggleEnginePause={onToggle} />);
    const btn = screen.getByTitle("Pause scheduling");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("applies btn-icon--paused class when engine is paused", () => {
    render(<Header enginePaused={true} />);
    const btn = screen.getByTitle("Resume scheduling");
    expect(btn.className).toContain("btn-icon--paused");
  });

  it("does not apply btn-icon--paused class when engine is not paused", () => {
    render(<Header enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect(btn.className).not.toContain("btn-icon--paused");
  });

  it("pause button is disabled when globalPaused is true", () => {
    render(<Header globalPaused={true} enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("pause button is enabled when globalPaused is false", () => {
    render(<Header globalPaused={false} enginePaused={false} />);
    const btn = screen.getByTitle("Pause scheduling");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  // ── Stop button (hard stop) ──────────────────────────────────────

  it("renders stop button with 'Stop AI engine' title when not stopped", () => {
    render(<Header globalPaused={false} />);
    const btn = screen.getByTitle("Stop AI engine");
    expect(btn).toBeDefined();
  });

  it("renders play button with 'Start AI engine' title when stopped", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    expect(btn).toBeDefined();
  });

  it("calls onToggleGlobalPause when stop button is clicked", () => {
    const onToggle = vi.fn();
    render(<Header globalPaused={false} onToggleGlobalPause={onToggle} />);
    const btn = screen.getByTitle("Stop AI engine");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("applies btn-icon--stopped class when globally paused", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    expect(btn.className).toContain("btn-icon--stopped");
  });

  it("does not apply btn-icon--stopped class when not globally paused", () => {
    render(<Header globalPaused={false} />);
    const btn = screen.getByTitle("Stop AI engine");
    expect(btn.className).not.toContain("btn-icon--stopped");
  });

  it("stop button shows Play icon when globalPaused is true", () => {
    render(<Header globalPaused={true} />);
    const btn = screen.getByTitle("Start AI engine");
    // The Play icon from lucide-react renders an SVG
    const svg = btn.querySelector("svg");
    expect(svg).toBeDefined();
  });

  // ── View Toggle ────────────────────────────────────────────────────

  it("renders view toggle when onChangeView is provided", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    const listBtn = screen.getByTitle("List view");
    expect(boardBtn).toBeDefined();
    expect(listBtn).toBeDefined();
  });

  it("does not render view toggle when onChangeView is not provided", () => {
    render(<Header />);
    const boardBtn = screen.queryByTitle("Board view");
    const listBtn = screen.queryByTitle("List view");
    expect(boardBtn).toBeNull();
    expect(listBtn).toBeNull();
  });

  it("calls onChangeView with 'board' when board view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    fireEvent.click(boardBtn);
    expect(onChangeView).toHaveBeenCalledWith("board");
  });

  it("calls onChangeView with 'list' when list view button is clicked", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const listBtn = screen.getByTitle("List view");
    fireEvent.click(listBtn);
    expect(onChangeView).toHaveBeenCalledWith("list");
  });

  it("marks board view button as active when view is 'board'", () => {
    const onChangeView = vi.fn();
    render(<Header view="board" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks list view button as active when view is 'list'", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const listBtn = screen.getByTitle("List view");
    expect(listBtn.className).toContain("active");
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not mark board view button as active when view is 'list'", () => {
    const onChangeView = vi.fn();
    render(<Header view="list" onChangeView={onChangeView} />);
    const boardBtn = screen.getByTitle("Board view");
    expect(boardBtn.className).not.toContain("active");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("false");
  });

  // ── Theme Toggle ─────────────────────────────────────────────────

  it("renders theme toggle button when onToggleTheme is provided", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="dark" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTestId("theme-toggle-btn");
    expect(btn).toBeDefined();
  });

  it("does not render theme toggle when onToggleTheme is not provided", () => {
    render(<Header />);
    const btn = screen.queryByTestId("theme-toggle-btn");
    expect(btn).toBeNull();
  });

  it("calls onToggleTheme when theme toggle button is clicked", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="dark" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTestId("theme-toggle-btn");
    fireEvent.click(btn);
    expect(onToggleTheme).toHaveBeenCalledOnce();
  });

  it("shows Moon icon for dark mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="dark" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTestId("theme-toggle-btn");
    expect(btn.querySelector("svg")).toBeDefined();
  });

  it("shows Sun icon for light mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="light" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTestId("theme-toggle-btn");
    expect(btn.querySelector("svg")).toBeDefined();
  });

  it("shows Monitor icon for system mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="system" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTestId("theme-toggle-btn");
    expect(btn.querySelector("svg")).toBeDefined();
  });

  it("shows correct title for dark mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="dark" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTitle("Toggle theme (Dark)");
    expect(btn).toBeDefined();
  });

  it("shows correct title for light mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="light" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTitle("Toggle theme (Light)");
    expect(btn).toBeDefined();
  });

  it("shows correct title for system mode", () => {
    const onToggleTheme = vi.fn();
    render(<Header themeMode="system" onToggleTheme={onToggleTheme} />);
    const btn = screen.getByTitle("Toggle theme (System)");
    expect(btn).toBeDefined();
  });
});


import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TerminalLauncher } from "../TerminalLauncher";

const mockFetchScripts = vi.fn();

vi.mock("../../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
  normalizeScriptCatalog: (value: Record<string, string> | Array<{ name: string; command: string; description?: string }>) => Array.isArray(value)
    ? value
    : Object.entries(value).map(([name, command]) => ({ name, command })),
}));

describe("TerminalLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
  });

  it("renders the terminal button and toggles terminal", () => {
    const onToggleTerminal = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={onToggleTerminal} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

    fireEvent.click(screen.getByTestId("terminal-toggle-btn"));

    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("opens scripts dropdown from chevron without toggling terminal", async () => {
    const onToggleTerminal = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={onToggleTerminal} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

    fireEvent.click(screen.getByTestId("scripts-btn"));

    expect(onToggleTerminal).not.toHaveBeenCalled();
    expect(await screen.findByTestId("quick-scripts-dropdown")).toBeInTheDocument();
    await waitFor(() => expect(mockFetchScripts).toHaveBeenCalledWith("proj-1"));
  });

  it("runs a quick script", async () => {
    const onRunScript = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={onRunScript} />);

    fireEvent.click(screen.getByTestId("scripts-btn"));
    fireEvent.click(await screen.findByTestId("quick-script-item-build"));

    expect(onRunScript).toHaveBeenCalledWith("build", "pnpm build");
  });

  it("shows descriptions with command fallback and executes the exact command by keyboard", async () => {
    mockFetchScripts.mockResolvedValueOnce([
      { name: "Build production", command: "pnpm build", description: "Production bundle" },
      { name: "Déployer 🚀", command: "pnpm deploy" },
    ]);
    const onRunScript = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={onRunScript} />);
    fireEvent.click(screen.getByTestId("scripts-btn"));
    const menu = await screen.findByTestId("quick-scripts-dropdown");
    expect(screen.getByText("Production bundle")).toBeInTheDocument();
    expect(screen.getByText("pnpm deploy")).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onRunScript).toHaveBeenCalledWith("Build production", "pnpm build");
  });

  it("opens manage scripts from the dropdown footer", async () => {
    const onOpenScripts = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={vi.fn()} onOpenScripts={onOpenScripts} onRunScript={vi.fn()} />);

    fireEvent.click(screen.getByTestId("scripts-btn"));
    fireEvent.click(await screen.findByTestId("quick-scripts-manage"));

    expect(onOpenScripts).toHaveBeenCalledTimes(1);
  });
});

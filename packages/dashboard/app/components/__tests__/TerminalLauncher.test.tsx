import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TerminalLauncher } from "../TerminalLauncher";

const mockFetchScripts = vi.fn();

vi.mock("../../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
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

  it("opens manage scripts from the dropdown footer", async () => {
    const onOpenScripts = vi.fn();
    render(<TerminalLauncher projectId="proj-1" onToggleTerminal={vi.fn()} onOpenScripts={onOpenScripts} onRunScript={vi.fn()} />);

    fireEvent.click(screen.getByTestId("scripts-btn"));
    fireEvent.click(await screen.findByTestId("quick-scripts-manage"));

    expect(onOpenScripts).toHaveBeenCalledTimes(1);
  });
});

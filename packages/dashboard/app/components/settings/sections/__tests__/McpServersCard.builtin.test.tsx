import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { getFusionMemoryMcpDisplayDefinition, McpServersCard } from "../McpServersCard";

function renderCard(scope: "global" | "project", form: Settings, globalSettings?: Settings) {
  let current = form;
  const setForm = vi.fn((updater: Settings | ((previous: Settings) => Settings)) => {
    current = typeof updater === "function" ? updater(current) : updater;
  });
  const view = render(<McpServersCard scope={scope} form={current} setForm={setForm} globalSettings={globalSettings} builtInAvailable addToast={vi.fn()} />);
  setForm.mockImplementation((updater: Settings | ((previous: Settings) => Settings)) => {
    current = typeof updater === "function" ? updater(current) : updater;
    view.rerender(<McpServersCard scope={scope} form={current} setForm={setForm} globalSettings={globalSettings} builtInAvailable addToast={vi.fn()} />);
  });
  return { form: () => current };
}

describe("McpServersCard built-in memory server", () => {
  it("uses only a descriptor display row with no spawn command", () => {
    expect(getFusionMemoryMcpDisplayDefinition()).toMatchObject({ name: "fusion-memory", command: "", args: [] });
  });

  it("renders an uneditable built-in row and writes a tombstone then deletes it", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) }));
    const result = renderCard("global", { mcpServers: { enabled: true, servers: [] } } as Settings);
    expect(screen.getByTestId("mcp-server-row-fusion-memory")).toHaveTextContent("Fusion memory");
    expect(screen.queryByLabelText("Remove fusion-memory")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(result.form().mcpServers?.servers).toEqual([{ name: "fusion-memory", enabled: false }]);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(result.form().mcpServers?.servers).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("uses the project marker only when cancelling a global tombstone", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) }));
    const result = renderCard("project", { mcpServers: { enabled: true, servers: [{ name: "fusion-memory", enabled: false } as never] } as never } as Settings, { mcpServers: { enabled: true, servers: [{ name: "fusion-memory", enabled: false } as never] } as never } as Settings);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(result.form().mcpServers?.servers).toEqual([{ name: "fusion-memory", enabled: true }]);
    expect(screen.getByTestId("mcp-server-row-fusion-memory")).toHaveTextContent("built-in");
    expect(screen.getByTestId("mcp-server-row-fusion-memory")).not.toHaveTextContent("built-in disabled");
    vi.unstubAllGlobals();
  });
});

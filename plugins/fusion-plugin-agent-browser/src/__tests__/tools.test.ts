import { describe, expect, it, vi } from "vitest";
import { AGENT_BROWSER_TOOLS } from "../tools.js";
import type { PluginContext } from "@fusion/plugin-sdk";

const createContext = (settings: Record<string, unknown>): PluginContext => ({
  pluginId: "fusion-plugin-agent-browser",
  taskStore: {} as PluginContext["taskStore"],
  settings,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  emitEvent: vi.fn(),
});

describe("tools", () => {
  it("blocks disallowed domains", async () => {
    const tool = AGENT_BROWSER_TOOLS[0];
    const result = await tool.execute(
      { url: "https://forbidden.example.com/path" },
      createContext({ allowedDomains: ["allowed.example.com"] }),
    );
    expect(result.isError).toBe(true);
  });

  it("allows when allowlist is empty", async () => {
    const tool = AGENT_BROWSER_TOOLS[0];
    const result = await tool.execute(
      { url: "https://any.example.com/path" },
      createContext({ allowedDomains: [], headlessMode: true }),
    );
    expect(result.isError).not.toBe(true);
  });

  it("allows matching domains", async () => {
    const tool = AGENT_BROWSER_TOOLS[0];
    const result = await tool.execute(
      { url: "https://docs.allowed.example.com/path" },
      createContext({ allowedDomains: ["allowed.example.com"], headlessMode: true }),
    );
    expect(result.isError).not.toBe(true);
  });

  it("returns error for invalid URL", async () => {
    const tool = AGENT_BROWSER_TOOLS[0];
    const result = await tool.execute({ url: "not a url" }, createContext({ allowedDomains: [] }));
    expect(result.isError).toBe(true);
  });

  it("blocks sibling domains that only share suffix text", async () => {
    const tool = AGENT_BROWSER_TOOLS[0];
    const result = await tool.execute(
      { url: "https://notexample.com/path" },
      createContext({ allowedDomains: ["example.com"] }),
    );
    expect(result.isError).toBe(true);
  });
});

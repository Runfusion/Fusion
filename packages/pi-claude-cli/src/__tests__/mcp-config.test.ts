import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock references so they survive vi.mock hoisting
const mocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  tmpdir: vi.fn(() => "/tmp"),
}));

// Mock node:fs writeFileSync to avoid disk I/O
vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
}));

// Mock node:os tmpdir
vi.mock("node:os", () => ({
  tmpdir: mocks.tmpdir,
}));

import { getCustomToolDefs, writeMcpConfig } from "../mcp-config";
import type { McpToolDef } from "../mcp-config";

describe("getCustomToolDefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters out all 6 built-in tools and returns only custom tools", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
        {
          name: "search",
          description: "Custom search tool",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "deploy",
          description: "Deploy app",
          parameters: {
            type: "object",
            properties: { target: { type: "string" } },
          },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("search");
    expect(result[1].name).toBe("deploy");
  });

  it("returns empty array when all tools are built-in", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("includes custom tool with correct name, description, inputSchema from parameters", () => {
    const customParams = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number" },
      },
      required: ["query"],
    };

    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "custom_search",
          description: "Search the codebase",
          parameters: customParams,
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("custom_search");
    expect(result[0].description).toBe("Search the codebase");
    expect(result[0].inputSchema).toBe(customParams);
  });

  it("handles pi.getAllTools() returning empty array", () => {
    const mockPi = {
      getAllTools: vi.fn(() => []),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns undefined", () => {
    const mockPi = {
      getAllTools: vi.fn(() => undefined),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns null", () => {
    const mockPi = {
      getAllTools: vi.fn(() => null),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });
});

describe("writeMcpConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
  });

  it("writes schema file to tmpdir with correct content (JSON array of tool defs)", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // First writeFileSync call is the schema file
    const schemaCall = mocks.writeFileSync.mock.calls[0];
    expect(schemaCall[0]).toMatch(/pi-claude-mcp-schemas/);
    expect(JSON.parse(schemaCall[1])).toEqual(toolDefs);
  });

  it("writes config file to tmpdir with mcpServers.custom-tools entry", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // Second writeFileSync call is the config file
    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    expect(config).toHaveProperty("mcpServers");
    expect(config.mcpServers).toHaveProperty("custom-tools");
  });

  it("config uses 'command': 'node' format (not 'type': 'http')", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.command).toBe("node");
    expect(server).not.toHaveProperty("type");
  });

  it("config args include path to mcp-schema-server.cjs and schema file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.args).toHaveLength(2);
    // First arg should be the server .cjs path (normalize separators for Windows)
    expect(server.args[0].replace(/\\/g, "/")).toContain(
      "mcp-schema-server.cjs",
    );
    // Second arg should be the schema file path
    expect(server.args[1]).toMatch(/pi-claude-mcp-schemas/);
  });

  it("returns the config file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    const result = writeMcpConfig(toolDefs);

    expect(result).toMatch(/pi-claude-mcp-config/);
    expect(result).toMatch(/\.json$/);
  });
});

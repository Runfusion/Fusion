import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const piSource = () => readFileSync(join(process.cwd(), "src/pi.ts"), "utf8");

describe("pi MCP session tool integration", () => {
  it("registers MCP tools through customTools instead of passing mcpServers to pi", () => {
    const source = piSource();
    expect(source).toContain("connectMcpSessionTools(forwardedMcpServers");
    expect(source).toContain("...(mcpToolset?.tools ?? [])");
    expect(source).toContain("wrapToolsWithActionGate(");
    expect(source).toContain("wrapToolsWithBoundary(");
    expect(source).not.toContain("mcpServers: forwardedMcpServers");
  });

  it("keeps readonly MCP exposure behind an explicit opt-in while preserving disposal", () => {
    const source = piSource();
    expect(source).toContain("allowMcpToolsInReadonly");
    expect(source).toContain("forwardedMcpServers.length > 0 && (!isReadonly || allowReadonlyMcpTools)");
    expect(source).toContain("readonly session — MCP servers");
    expect(source).toContain("allowReadonlyMcpTools ? { allowTool: (tool) => mcpReadonlyTools.has(tool) } : {}");
    expect(source).toContain("await mcpToolset.dispose()");
    expect(source).toContain("await mcpToolset?.dispose()");
  });
});

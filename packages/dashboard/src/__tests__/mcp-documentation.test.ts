// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("MCP documentation contract", () => {
  it("includes the canonical MCP guide and required cross-references", () => {
    const mcpGuide = readDoc("docs/mcp.md");
    const docsIndex = readDoc("docs/README.md");
    const settingsReference = readDoc("docs/settings-reference.md");
    const cliReference = readDoc("docs/cli-reference.md");
    const dashboardGuide = readDoc("docs/dashboard-guide.md");

    expect(mcpGuide).toContain("# MCP (Model Context Protocol)");
    expect(mcpGuide).toContain("## Overview");
    expect(mcpGuide).toContain("## Server definitions and transports");
    expect(mcpGuide).toContain("## Secret references");
    expect(mcpGuide).toContain("## Validation and reachability");
    expect(mcpGuide).toContain("## Managing servers in the dashboard");
    expect(mcpGuide).toContain("## Managing servers from the CLI");
    expect(mcpGuide).toContain("## Importing Claude Desktop configuration");
    expect(mcpGuide).toContain("## Exporting Fusion MCP configuration");
    expect(mcpGuide).toContain("## How MCP servers reach AI lanes");

    expect(docsIndex).toContain("[MCP](./mcp.md)");
    expect(settingsReference).toContain("[MCP](./mcp.md)");
    expect(cliReference).toContain("[MCP](./mcp.md)");
    expect(dashboardGuide).toContain("[MCP](./mcp.md)");
  });

  it("keeps documented MCP implementation surfaces aligned with source", () => {
    const mcpGuide = readDoc("docs/mcp.md");
    const routeSource = readDoc("packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts");
    const cliSource = readDoc("packages/cli/src/commands/mcp.ts");
    const settingsModalSource = readDoc("packages/dashboard/app/components/SettingsModal.tsx");

    expect(routeSource).toContain('router.post("/mcp/validate"');
    expect(routeSource).toContain("server?: unknown");
    expect(routeSource).toContain("definition?: unknown");
    expect(routeSource).toContain("timeoutMs?: unknown");
    expect(mcpGuide).toContain("POST /api/mcp/validate");
    expect(mcpGuide).toContain("`valid`");
    expect(mcpGuide).toContain("`unreachable`");
    expect(mcpGuide).toContain("`error`");

    for (const command of ["runMcpList", "runMcpAdd", "runMcpEdit", "runMcpRemove", "runMcpEnable", "runMcpDisable", "runMcpImport", "runMcpExport", "runMcpValidate"]) {
      expect(cliSource).toContain(`export async function ${command}`);
    }
    for (const flag of ["--scope", "--transport", "--secret-ref", "--secret-scope", "--output", "--json", "--yes"]) {
      expect(mcpGuide).toContain(flag);
    }

    expect(settingsModalSource).toContain('id: "global-mcp"');
    expect(settingsModalSource).toContain('id: "mcp"');
    expect(mcpGuide).toContain("Settings → Global → MCP Servers");
    expect(mcpGuide).toContain("Settings → Project → MCP Servers");
  });
});

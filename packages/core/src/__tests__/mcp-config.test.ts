import { describe, expect, it } from "vitest";
import {
  exportMcpServersJson,
  importMcpServersJson,
  materializeMcpServerSecrets,
  resolveEffectiveMcpServers,
} from "../mcp-config.js";
import {
  validateMcpServerDefinition,
  validateMcpServerDefinitions,
  validateMcpServerDefinitionsDetailed,
} from "../settings-validation.js";
import type { McpServerDefinition } from "../types.js";

const projectSecret = { secretRef: "project-token", scope: "project" as const };
const globalSecret = { secretRef: "global-token", scope: "global" as const };

describe("MCP core config", () => {
  it("resolves project servers over global servers by name", () => {
    const globalServer: McpServerDefinition = {
      name: "github",
      transport: "stdio",
      command: "global-gh",
      env: { TOKEN: globalSecret },
    };
    const projectServer: McpServerDefinition = {
      name: "github",
      transport: "stdio",
      command: "project-gh",
      args: ["serve"],
      env: { TOKEN: projectSecret },
    };

    expect(
      resolveEffectiveMcpServers(
        { mcpServers: { enabled: true, servers: [globalServer] } },
        { mcpServers: { enabled: true, servers: [projectServer] } },
      ),
    ).toEqual([projectServer]);
  });

  it("merges enabled plugin contributions between global and project settings", () => {
    const plugin = { pluginId: "roslyn", server: { name: "navigator", transport: "stdio" as const, command: "cwm-roslyn-navigator" } };
    const override: McpServerDefinition = { name: "navigator", transport: "stdio", command: "project-navigator" };
    expect(resolveEffectiveMcpServers(
      { mcpServers: { enabled: true, servers: [{ name: "global", transport: "stdio", command: "global" }] } },
      { mcpServers: { enabled: true, servers: [override] } }, [plugin],
    )).toEqual([
      { name: "global", transport: "stdio", command: "global" }, override,
    ]);
    expect(resolveEffectiveMcpServers(
      { mcpServers: { enabled: true } },
      { mcpServers: { enabled: true, servers: [{ ...override, enabled: false }] } }, [plugin],
    )).toEqual([]);
    expect(resolveEffectiveMcpServers(
      { mcpServers: { enabled: true } }, { mcpServers: { enabled: true } },
      [{ pluginId: "off", server: { ...plugin.server, enabledByDefault: false } }],
    )).toEqual([]);
  });

  it("skips malformed runtime plugin entries without disabling healthy settings", () => {
    const validGlobal: McpServerDefinition = { name: "global", transport: "stdio", command: "global" };
    const validProject: McpServerDefinition = { name: "project", transport: "stdio", command: "project" };
    expect(resolveEffectiveMcpServers(
      { mcpServers: { enabled: true, servers: [validGlobal] } },
      { mcpServers: { enabled: true, servers: [validProject] } },
      [
        null as unknown as { pluginId: string; server: never },
        { pluginId: "bad-null", server: null as unknown as never },
        { pluginId: "bad-default", server: { name: "bad", transport: "stdio", command: "bad", enabledByDefault: "no" } as unknown as never },
      ],
    )).toEqual([validGlobal, validProject]);
  });

  it("lets a project disabled entry remove a global server", () => {
    const globalServer: McpServerDefinition = {
      name: "global-only",
      transport: "stdio",
      command: "global-command",
    };
    const disabledProjectOverride: McpServerDefinition = {
      name: "global-only",
      enabled: false,
      transport: "stdio",
      command: "ignored",
    };

    expect(
      resolveEffectiveMcpServers(
        { mcpServers: { enabled: true, servers: [globalServer] } },
        { mcpServers: { enabled: true, servers: [disabledProjectOverride] } },
      ),
    ).toEqual([]);
  });

  it("rejects plaintext sensitive env and header values while accepting secret refs", () => {
    expect(
      validateMcpServerDefinition({
        name: "bad-env",
        transport: "stdio",
        command: "node",
        env: { TOKEN: "plaintext" },
      }),
    ).toBeUndefined();

    expect(
      validateMcpServerDefinition({
        name: "bad-header",
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: "Bearer plaintext" },
      }),
    ).toBeUndefined();

    expect(
      validateMcpServerDefinition({
        name: "good",
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: projectSecret },
      }),
    ).toEqual({
      name: "good",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: projectSecret },
    });
  });

  it("validates required fields by transport and rejects duplicate names", () => {
    expect(validateMcpServerDefinition({ name: "stdio", transport: "stdio" })).toBeUndefined();
    expect(validateMcpServerDefinition({ name: "sse", transport: "sse" })).toBeUndefined();
    expect(validateMcpServerDefinition({ name: "http", transport: "streamable-http" })).toBeUndefined();

    const duplicateResult = validateMcpServerDefinitionsDetailed([
      { name: "dup", transport: "stdio", command: "one" },
      { name: "dup", transport: "stdio", command: "two" },
    ]);
    expect(duplicateResult.value).toBeUndefined();
    expect(duplicateResult.errors.map((error) => error.code)).toContain("duplicate-name");
    expect(
      validateMcpServerDefinitions([
        { name: "one", transport: "stdio", command: "one" },
        { name: "two", transport: "streamable-http", url: "https://example.test/mcp" },
      ]),
    ).toHaveLength(2);
  });

  it("imports plaintext sensitive values as secret descriptors and round-trips exported refs", () => {
    const imported = importMcpServersJson({
      mcpServers: {
        github: {
          command: "github-mcp-server",
          args: ["stdio"],
          env: { GITHUB_TOKEN: "ghp_secret" },
        },
        docs: {
          transport: "streamable-http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: globalSecret },
        },
      },
    });

    expect(imported.errors).toEqual([]);
    expect(imported.secretsToCreate).toEqual([
      {
        serverName: "github",
        field: "env",
        key: "GITHUB_TOKEN",
        scope: "project",
        suggestedKey: "mcp.github.env.GITHUB_TOKEN",
        plaintextValue: "ghp_secret",
      },
    ]);
    expect(imported.definitions[0]).toMatchObject({
      name: "github",
      transport: "stdio",
      env: { GITHUB_TOKEN: { secretRef: "mcp.github.env.GITHUB_TOKEN", scope: "project" } },
    });

    const original: McpServerDefinition[] = [
      {
        name: "docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        headers: { Authorization: globalSecret },
      },
    ];
    const roundTrip = importMcpServersJson(exportMcpServersJson(original));
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.secretsToCreate).toEqual([]);
    expect(roundTrip.definitions).toEqual(original);
  });

  it("materializes secret refs through an injected reader and omits failed refs", async () => {
    const calls: Array<{ id: string; scope: string; userId?: string | null }> = [];
    const server: McpServerDefinition = {
      name: "secure",
      transport: "stdio",
      command: "secure-mcp",
      env: {
        OK: { secretRef: "ok", scope: "project" },
        MISSING: { secretRef: "missing", scope: "global" },
      },
    };

    const resolved = await materializeMcpServerSecrets(
      server,
      {
        async revealSecret(id, scope, reader) {
          calls.push({ id, scope, userId: reader.userId });
          if (id === "missing") throw new Error("not found");
          return { key: id, plaintextValue: "resolved-value" };
        },
      },
      { userId: "tester" },
    );

    expect(calls).toEqual([
      { id: "ok", scope: "project", userId: "tester" },
      { id: "missing", scope: "global", userId: "tester" },
    ]);
    expect(resolved.value).toMatchObject({
      name: "secure",
      transport: "stdio",
      env: { OK: "resolved-value" },
    });
    expect((resolved.value as Extract<typeof resolved.value, { transport: "stdio" }>)?.env).not.toHaveProperty("MISSING");
    expect(resolved.errors).toHaveLength(1);
  });
});

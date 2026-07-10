import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  if (impl) mock.mockImplementation(impl);
  return mock;
}

type SecretRecord = { id: string; key: string; scope: "global" | "project"; plaintextValue: string };

const state = vi.hoisted(() => ({
  globalSettings: { mcpServers: { enabled: false, servers: [] as any[] } },
  projectSettings: { mcpServers: { enabled: false, servers: [] as any[] } },
  secrets: [] as SecretRecord[],
  nextSecretId: 1,
}));

vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  const secretsStore = {
    getSecretMetadata: vi.fn((id: string, scope: "global" | "project") => state.secrets.find((secret) => secret.id === id && secret.scope === scope) ?? null),
    listSecrets: vi.fn((scope?: "global" | "project") => state.secrets.filter((secret) => !scope || secret.scope === scope)),
    createSecret: vi.fn(async (input: { scope: "global" | "project"; key: string; plaintextValue: string }) => {
      const created = { id: `sec-${state.nextSecretId++}`, key: input.key, scope: input.scope, plaintextValue: input.plaintextValue };
      state.secrets.push(created);
      return created;
    }),
  };
  return {
    ...actual,
    GlobalSettingsStore: makeConstructibleMock(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn(async () => state.globalSettings),
      updateSettings: vi.fn(async (patch: any) => {
        state.globalSettings = { ...state.globalSettings, ...patch };
        return state.globalSettings;
      }),
    })),
    TaskStore: makeConstructibleMock(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      getSecretsStore: vi.fn(async () => secretsStore),
    })),
  };
});

vi.mock("../../project-context.js", () => ({
  closeProjectStore: vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
    try {
      await context.store.close?.();
    } catch {
      // best-effort, mirrors production closeProjectStore
    }
  }),
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
  resolveProject: vi.fn(async () => ({
    projectId: "proj-1",
    projectName: "demo",
    projectPath: "/tmp/demo",
    isRegistered: true,
    store: {
      getSettingsByScope: vi.fn(async () => ({ global: state.globalSettings, project: state.projectSettings })),
      updateSettings: vi.fn(async (patch: any) => {
        state.projectSettings = { ...state.projectSettings, ...patch };
        return { ...state.globalSettings, ...state.projectSettings };
      }),
      getSecretsStore: vi.fn(async () => ({
        getSecretMetadata: (id: string, scope: "global" | "project") => state.secrets.find((secret) => secret.id === id && secret.scope === scope) ?? null,
        listSecrets: (scope?: "global" | "project") => state.secrets.filter((secret) => !scope || secret.scope === scope),
        createSecret: async (input: { scope: "global" | "project"; key: string; plaintextValue: string }) => {
          const created = { id: `sec-${state.nextSecretId++}`, key: input.key, scope: input.scope, plaintextValue: input.plaintextValue };
          state.secrets.push(created);
          return created;
        },
      })),
    },
  })),
}));

import {
  runMcpAdd,
  runMcpDisable,
  runMcpEnable,
  runMcpExport,
  runMcpImport,
  runMcpList,
  runMcpRemove,
} from "../mcp.js";

function resetState() {
  state.globalSettings = { mcpServers: { enabled: false, servers: [] } };
  state.projectSettings = { mcpServers: { enabled: false, servers: [] } };
  state.secrets = [];
  state.nextSecretId = 1;
}

function captureConsole() {
  const output: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.map(String).join(" ")));
  return { output, restore: () => logSpy.mockRestore() };
}

describe("mcp commands", () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    resetState();
    tempDir = mkdtempSync(join(tmpdir(), "fusion-mcp-cli-"));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("round-trips add list remove across global and project scopes with effective resolution", async () => {
    const consoleCapture = captureConsole();
    await runMcpAdd("github", { scope: "global", transport: "stdio", command: "global-gh" });
    await runMcpAdd("github", { scope: "project", transport: "stdio", command: "project-gh" });
    await runMcpList({ json: true });

    const listed = JSON.parse(consoleCapture.output.at(-1) ?? "{}");
    expect(listed.global[0]).toMatchObject({ name: "github", command: "global-gh" });
    expect(listed.project[0]).toMatchObject({ name: "github", command: "project-gh" });
    expect(listed.effective).toEqual([expect.objectContaining({ name: "github", command: "project-gh" })]);

    await runMcpDisable("github", { scope: "project" });
    await runMcpList({ json: true });
    expect(JSON.parse(consoleCapture.output.at(-1) ?? "{}").effective).toEqual([]);

    await runMcpRemove("github", { scope: "project" });
    await runMcpList({ json: true });
    expect(JSON.parse(consoleCapture.output.at(-1) ?? "{}").effective).toEqual([expect.objectContaining({ command: "global-gh" })]);
    consoleCapture.restore();
  });

  it("imports Claude Desktop mcpServers JSON by creating secrets and persisting only references", async () => {
    const fixture = join(tempDir!, "claude.json");
    writeFileSync(fixture, JSON.stringify({
      mcpServers: {
        github: { command: "github-mcp-server", args: ["stdio"], env: { GITHUB_TOKEN: "ghp_raw" } },
      },
    }));
    const consoleCapture = captureConsole();

    await runMcpImport(fixture, { scope: "project", yes: true });

    expect(state.secrets).toEqual([expect.objectContaining({ key: "mcp.github.env.GITHUB_TOKEN", plaintextValue: "ghp_raw", scope: "project" })]);
    expect(JSON.stringify(state.projectSettings)).not.toContain("ghp_raw");
    expect(state.projectSettings.mcpServers.servers[0]).toMatchObject({
      name: "github",
      transport: "stdio",
      env: { GITHUB_TOKEN: { secretRef: "sec-1", scope: "project" } },
    });
    consoleCapture.restore();
  });

  it("exports Fusion MCP JSON with secret references instead of raw values", async () => {
    state.secrets.push({ id: "sec-existing", key: "GITHUB_TOKEN", scope: "project", plaintextValue: "raw-token" });
    await runMcpAdd("github", { scope: "project", transport: "stdio", command: "github-mcp-server", env: ["GITHUB_TOKEN=GITHUB_TOKEN"] });
    const consoleCapture = captureConsole();

    await runMcpExport({ scope: "project" });

    const exported = JSON.parse(consoleCapture.output.at(-1) ?? "{}");
    expect(exported.mcpServers.github.env.GITHUB_TOKEN).toEqual({ secretRef: "sec-existing", scope: "project" });
    expect(JSON.stringify(exported)).not.toContain("raw-token");
    consoleCapture.restore();
  });

  it("rejects plaintext secrets on add and writes nothing", async () => {
    await expect(runMcpAdd("bad", { scope: "project", transport: "stdio", command: "bad", envRaw: ["TOKEN=plaintext"] })).rejects.toThrow(/Plaintext MCP env\/header\/token values are not allowed/);
    expect(state.projectSettings.mcpServers.servers).toEqual([]);
  });

  it("toggles enabled state at the chosen scope", async () => {
    await runMcpAdd("docs", { scope: "project", transport: "http", url: "https://docs.example.test/mcp" });
    await runMcpDisable("docs", { scope: "project" });
    expect(state.projectSettings.mcpServers.servers[0].enabled).toBe(false);
    await runMcpEnable("docs", { scope: "project" });
    expect(state.projectSettings.mcpServers.servers[0].enabled).toBe(true);
  });
});

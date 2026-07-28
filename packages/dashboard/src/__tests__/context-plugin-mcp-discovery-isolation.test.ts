/*
 * The route-context closure delegates provider construction to the exported
 * narrow binding seam. This exercises that exact production seam with a real
 * cross-root provider pass, without booting the dashboard HTTP server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader, type PluginInstallation } from "@fusion/core";
import { createDashboardProjectScopedPluginMcpProvider, createDiscoveryPluginLoaderOptions } from "../routes/context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project() {
  const root = await mkdtemp(join(tmpdir(), "fusion-dashboard-mcp-isolation-"));
  roots.push(root);
  const path = join(root, "plugin.mjs");
  await writeFile(path, `export default { manifest: { id: "dashboard-fixture", name: "Dashboard fixture", version: "1.0.0", description: "fixture" }, state: "installed", hooks: {}, mcpServers: [{ name: "dashboard-mcp", transport: "stdio", command: "fixture" }] };`);
  const installation: PluginInstallation = { id: "dashboard-fixture", name: "Dashboard fixture", version: "1.0.0", description: "fixture", path, enabled: true, state: "installed", settings: {}, dependencies: [], createdAt: "", updatedAt: "1" };
  const pluginStore = { init: vi.fn(async () => undefined), getPlugin: vi.fn(async () => ({ ...installation })), listPlugins: vi.fn(async () => [{ ...installation }]), updatePluginState: vi.fn(async () => undefined) };
  const taskStore = { getRootDir: () => root, getPluginStore: () => pluginStore, preflightPluginSchema: vi.fn(() => null), runPluginSchemaInits: vi.fn(async () => undefined), recordPluginActivation: vi.fn() };
  return { root, pluginStore, taskStore };
}

describe("dashboard plugin MCP discovery binding", () => {
  it("uses an isolated loader and preserves an owning target loader during cross-root discovery", async () => {
    const target = await project();
    const owner = new PluginLoader({ pluginStore: target.pluginStore as any, taskStore: target.taskStore as any });
    await owner.loadAllPlugins();
    target.pluginStore.updatePluginState.mockClear();
    const host = await project();

    const entries = await createDashboardProjectScopedPluginMcpProvider({
      hostRootDir: host.root,
      hostLoader: new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any }),
    }).get(target.taskStore);

    expect(createDiscoveryPluginLoaderOptions(target.taskStore as any)).toMatchObject({ lifecycleScope: "isolated", persistRuntimeState: false });
    expect(entries.map((entry) => entry.server.name)).toEqual(["dashboard-mcp"]);
    expect(owner.isPluginLoaded("dashboard-fixture")).toBe(true);
    expect(owner.getPluginMcpServers()).toHaveLength(1);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
    expect([...((PluginLoader as any).processPluginLifecycles as Map<string, unknown>).keys()].some((key) => key.startsWith(`${target.root}\0`))).toBe(true);
    await owner.stopAllPlugins();
  });
});

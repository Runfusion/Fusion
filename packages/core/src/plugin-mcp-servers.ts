import { resolve as resolvePath } from "node:path";
import { PluginLoader } from "./plugins/plugin-loader.js";
import type { PluginMcpServerContribution } from "./plugins/plugin-types.js";

export type PluginMcpServerEntry = { pluginId: string; server: PluginMcpServerContribution };

/** Minimal project seams required by the shared MCP contribution provider. */
export interface ProjectPluginMcpStore {
  getRootDir(): string;
  getPluginStore(): {
    init(): Promise<void>;
    listPlugins(filter?: { enabled?: boolean }): Promise<Array<{ id: string; updatedAt: string | number | Date }>>;
  };
}

export interface ProjectScopedPluginMcpProviderOptions {
  hostRootDir: string;
  hostLoader: Pick<PluginLoader, "getPluginMcpServers">;
  /** Creates a non-persisting loader for a project other than the host root. */
  createScopedLoader?: (store: ProjectPluginMcpStore) => Pick<PluginLoader, "loadAllPlugins" | "stopAllPlugins" | "getPluginMcpServers">;
}

/**
 * Creates the only project-aware plugin MCP provider. The caller supplies the
 * target project store, allowing daemon, dashboard, CLI, and engine adapters to
 * share the exact same enablement and cache invariant without raw enumeration.
 *
 * FNXC:PluginMcpServers 2026-07-22-12:00:
 * FN-8491 / #2401 requires plugin MCP declarations only in projects where the
 * plugin is enabled. Cache keys include normalized project root AND enabled
 * id:updatedAt state, preventing project A's contributions leaking into B.
 */
export function createProjectScopedPluginMcpProvider(options: ProjectScopedPluginMcpProviderOptions): {
  get(store: ProjectPluginMcpStore): Promise<PluginMcpServerEntry[]>;
} {
  const cache = new Map<string, { enabledKey: string; entries: PluginMcpServerEntry[] }>();
  const normalizedHostRoot = resolvePath(options.hostRootDir);

  return {
    async get(store): Promise<PluginMcpServerEntry[]> {
      const root = resolvePath(store.getRootDir());
      const pluginStore = store.getPluginStore();
      await pluginStore.init();
      const enabled = await pluginStore.listPlugins({ enabled: true });
      const enabledKey = enabled.map((plugin) => `${plugin.id}:${plugin.updatedAt}`).sort().join("\0");
      const existing = cache.get(root);
      if (existing?.enabledKey === enabledKey) return existing.entries;
      if (enabled.length === 0) {
        const entries: PluginMcpServerEntry[] = [];
        cache.set(root, { enabledKey, entries });
        return entries;
      }

      const enabledIds = new Set(enabled.map((plugin) => plugin.id));
      // Same-root callers reuse their active loader. Other roots load only their
      // own enabled plugins and never persist lifecycle state during discovery.
      if (root === normalizedHostRoot) {
        const entries = options.hostLoader.getPluginMcpServers().filter((entry) => enabledIds.has(entry.pluginId));
        cache.set(root, { enabledKey, entries });
        return entries;
      }
      if (!options.createScopedLoader) {
        const entries: PluginMcpServerEntry[] = [];
        cache.set(root, { enabledKey, entries });
        return entries;
      }
      const loader = options.createScopedLoader(store);
      try {
        await loader.loadAllPlugins();
        const entries = loader.getPluginMcpServers().filter((entry) => enabledIds.has(entry.pluginId));
        cache.set(root, { enabledKey, entries });
        return entries;
      } finally {
        await loader.stopAllPlugins();
      }
    },
  };
}

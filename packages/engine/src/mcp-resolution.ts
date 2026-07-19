import {
  materializeMcpServersSecrets,
  resolveEffectiveMcpServers,
  type GlobalSettings,
  type McpSecretReader,
  type McpSecretReaderIdentity,
  type McpSecretResolutionError,
  type ProjectSettings,
  type ResolvedMcpServerDefinition,
} from "@fusion/core";

export interface ResolveMcpServersForRuntimeOptions {
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null;
  projectSettings?: Pick<ProjectSettings, "mcpServers"> | null;
  secrets: McpSecretReader;
  reader?: McpSecretReaderIdentity;
}

export interface ResolvedMcpServersForRuntime {
  servers: ResolvedMcpServerDefinition[];
  errors: McpSecretResolutionError[];
}

/**
 * FNXC:McpConfig 2026-06-25-21:43:
 * Runtime MCP forwarding uses Fusion's trusted-once-enabled model: enabled effective servers are materialized once at session/probe creation and then forwarded without per-call prompts. Plaintext env/header values exist only in this in-memory return value and callers must log only counts/errors, never server contents.
 */
export async function resolveMcpServersForRuntime(
  options: ResolveMcpServersForRuntimeOptions,
): Promise<ResolvedMcpServersForRuntime> {
  const effective = resolveEffectiveMcpServers(options.globalSettings, options.projectSettings);
  if (effective.length === 0) return { servers: [], errors: [] };

  const materialized = await materializeMcpServersSecrets(
    effective,
    options.secrets,
    options.reader ?? {},
  );
  const failedServerNames = new Set(materialized.errors.map((error) => error.serverName));
  return {
    // Never forward a partially materialized definition: it could connect
    // without the operator-required credential. Other healthy MCP servers and
    // the owning agent session remain available.
    servers: (materialized.value ?? []).filter((server) => !failedServerNames.has(server.name)),
    errors: materialized.errors,
  };
}

export interface McpSettingsAndSecretsStore {
  getSettingsByScope?(): Promise<{
    global: Pick<GlobalSettings, "mcpServers">;
    project: Partial<Pick<ProjectSettings, "mcpServers">>;
  }>;
  getSecretsStore?(): Promise<McpSecretReader> | McpSecretReader;
}

const emptyMcpSecretReader: McpSecretReader = {
  async revealSecret() {
    throw new Error("MCP secret reader is unavailable");
  },
};

export async function resolveMcpServersForStore(
  store: McpSettingsAndSecretsStore,
  reader?: McpSecretReaderIdentity,
): Promise<ResolvedMcpServersForRuntime> {
  /*
   * FNXC:McpConfig 2026-06-26-01:07:
   * Older tests and lightweight TaskStore doubles may not implement the settings/secrets seams because they never configure MCP. Treat those stores as having no enabled MCP servers so all AI lanes keep their existing behavior while real stores still forward the resolved runtime configuration.
   */
  if (typeof store.getSettingsByScope !== "function") {
    return { servers: [], errors: [] };
  }

  const [settings, secrets] = await Promise.all([
    store.getSettingsByScope(),
    typeof store.getSecretsStore === "function" ? store.getSecretsStore() : emptyMcpSecretReader,
  ]);
  return resolveMcpServersForRuntime({
    globalSettings: settings.global,
    projectSettings: settings.project,
    secrets,
    reader,
  });
}

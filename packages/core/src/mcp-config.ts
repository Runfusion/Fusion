import type {
  GlobalSettings,
  McpSecretRef,
  McpServerDefinition,
  McpServersSettings,
  McpStdioTransport,
  McpSseTransport,
  McpStreamableHttpTransport,
  ProjectSettings,
} from "./types.js";
import type { PluginMcpServerContribution } from "./plugin-types.js";
import { isMcpSecretRef } from "./types.js";
import type { SecretScope } from "./secrets-store.js";
import { validateMcpServerDefinition } from "./settings-validation.js";

export interface McpSecretImportDescriptor {
  serverName: string;
  field: "env" | "headers" | "token";
  key: string;
  scope: SecretScope;
  suggestedKey: string;
  plaintextValue: string;
}

export interface McpServersImportResult {
  definitions: McpServerDefinition[];
  secretsToCreate: McpSecretImportDescriptor[];
  errors: string[];
}

export type McpSecretReaderIdentity = { agentId?: string | null; userId?: string | null };

export interface McpSecretReader {
  revealSecret(
    id: string,
    scope: SecretScope,
    reader: McpSecretReaderIdentity,
  ): Promise<{ key: string; plaintextValue: string }>;
}

export interface ResolvedMcpStdioTransport extends Omit<McpStdioTransport, "env"> {
  env?: Record<string, string>;
}

export interface ResolvedMcpSseTransport extends Omit<McpSseTransport, "headers"> {
  headers?: Record<string, string>;
}

export interface ResolvedMcpStreamableHttpTransport extends Omit<McpStreamableHttpTransport, "headers"> {
  headers?: Record<string, string>;
}

export type ResolvedMcpServerDefinition = {
  name: string;
  enabled?: boolean;
} & (ResolvedMcpStdioTransport | ResolvedMcpSseTransport | ResolvedMcpStreamableHttpTransport);

export interface McpSecretResolutionError {
  serverName: string;
  path: string;
  secretRef: McpSecretRef;
  message: string;
}

export interface McpSecretResolutionResult<T> {
  value?: T;
  errors: McpSecretResolutionError[];
}

function normalizeMcpServersSettings(settings?: McpServersSettings): McpServersSettings {
  return {
    enabled: settings?.enabled === true,
    servers: Array.isArray(settings?.servers) ? settings.servers : [],
  };
}

function validServers(settings?: McpServersSettings): McpServerDefinition[] {
  return normalizeMcpServersSettings(settings).servers
    ?.map(validateMcpServerDefinition)
    .filter((server): server is McpServerDefinition => Boolean(server)) ?? [];
}

/** Converts a declarative plugin contribution into a validated settings-shaped server. */
export function mapPluginMcpServerContribution(server: PluginMcpServerContribution | unknown): McpServerDefinition | undefined {
  if (!server || typeof server !== "object" || Array.isArray(server)) return undefined;
  const input = server as Record<string, unknown>;
  // Plugin declarations have no enabled field: project settings own per-project
  // enablement. Reject malformed runtime values individually before reading them.
  if ("enabled" in input || (input.enabledByDefault !== undefined && typeof input.enabledByDefault !== "boolean")) return undefined;
  return validateMcpServerDefinition(input);
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * FN-8491 / #2401 resolves global → enabled plugin → project by server name.
 * A project enabled:false tombstone removes inherited global or plugin declarations;
 * invalid plugin entries are ignored and this pure resolver never throws.
 */
export function resolveEffectiveMcpServers(
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null,
  projectSettings?: Pick<ProjectSettings, "mcpServers"> | null,
  pluginServers: Array<{ pluginId: string; server: PluginMcpServerContribution }> = [],
): McpServerDefinition[] {
  try {
    const globalMcp = normalizeMcpServersSettings(globalSettings?.mcpServers);
    const projectMcp = projectSettings?.mcpServers;
    const effectiveEnabled = typeof projectMcp?.enabled === "boolean" ? projectMcp.enabled : globalMcp.enabled;
    if (!effectiveEnabled) return [];

    const byName = new Map<string, McpServerDefinition>();
    for (const server of validServers(globalSettings?.mcpServers)) {
      if (server.enabled === false) continue;
      byName.set(server.name, server);
    }
    // Plugin order is deterministic at the scoped-provider boundary; later plugins win
    // duplicate names just as later project settings win inherited definitions.
    for (const contribution of pluginServers) {
      // Runtime plugin output is untrusted even though TypeScript callers use the
      // public contribution type. A malformed entry must not disable healthy
      // global/project MCP servers (FN-8491 / #2401).
      if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) continue;
      const rawServer = (contribution as { server?: unknown }).server;
      if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
      if ((rawServer as { enabledByDefault?: unknown }).enabledByDefault === false) continue;
      const server = mapPluginMcpServerContribution(rawServer);
      if (server) byName.set(server.name, server);
    }
    for (const server of validServers(projectMcp)) {
      if (server.enabled === false) {
        byName.delete(server.name);
        continue;
      }
      byName.set(server.name, server);
    }
    return [...byName.values()].filter((server) => server.enabled !== false);
  } catch {
    return [];
  }
}

async function materializeSensitiveMap(params: {
  serverName: string;
  path: string;
  values?: Record<string, McpSecretRef | string>;
  secrets: McpSecretReader;
  reader: McpSecretReaderIdentity;
}): Promise<McpSecretResolutionResult<Record<string, string> | undefined>> {
  const { values, secrets, reader, serverName, path } = params;
  if (!values) return { value: undefined, errors: [] };
  const resolved: Record<string, string> = {};
  const errors: McpSecretResolutionError[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!isMcpSecretRef(value)) {
      errors.push({
        serverName,
        path: `${path}.${key}`,
        secretRef: { secretRef: "", scope: "project" },
        message: "MCP sensitive values must be secret references; plaintext was not materialized",
      });
      continue;
    }
    try {
      const revealed = await secrets.revealSecret(value.secretRef, value.scope, reader);
      resolved[key] = revealed.plaintextValue;
    } catch (error) {
      errors.push({
        serverName,
        path: `${path}.${key}`,
        secretRef: value,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { value: Object.keys(resolved).length > 0 ? resolved : undefined, errors };
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * MCP secret materialization happens only at the use seam by calling the injected SecretsStore-compatible revealSecret method. Failed references are reported and omitted; the function never logs or returns unresolved secret material as plaintext.
 */
export async function materializeMcpServerSecrets(
  server: McpServerDefinition,
  secrets: McpSecretReader,
  reader: McpSecretReaderIdentity,
): Promise<McpSecretResolutionResult<ResolvedMcpServerDefinition>> {
  if (server.transport === "stdio") {
    const env = await materializeSensitiveMap({
      serverName: server.name,
      path: "env",
      values: server.env,
      secrets,
      reader,
    });
    return {
      value: {
        name: server.name,
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        transport: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(env.value ? { env: env.value } : {}),
      },
      errors: env.errors,
    };
  }

  const headers = await materializeSensitiveMap({
    serverName: server.name,
    path: "headers",
    values: server.headers,
    secrets,
    reader,
  });
  return {
    value: {
      name: server.name,
      ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
      transport: server.transport,
      url: server.url,
      ...(headers.value ? { headers: headers.value } : {}),
    },
    errors: headers.errors,
  };
}

export async function materializeMcpServersSecrets(
  servers: McpServerDefinition[],
  secrets: McpSecretReader,
  reader: McpSecretReaderIdentity,
): Promise<McpSecretResolutionResult<ResolvedMcpServerDefinition[]>> {
  const values: ResolvedMcpServerDefinition[] = [];
  const errors: McpSecretResolutionError[] = [];
  for (const server of servers) {
    const resolved = await materializeMcpServerSecrets(server, secrets, reader);
    if (resolved.value) values.push(resolved.value);
    errors.push(...resolved.errors);
  }
  return { value: values, errors };
}

function parseMcpJson(json: string | unknown): { data?: unknown; error?: string } {
  if (typeof json !== "string") return { data: json };
  try {
    return { data: JSON.parse(json) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function suggestedSecretKey(serverName: string, field: "env" | "headers" | "token", key: string): string {
  const clean = (value: string): string => value.trim().replace(/[^A-Za-z0-9_.-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return ["mcp", clean(serverName), clean(field), clean(key)].filter(Boolean).join(".");
}

function importSensitiveMap(params: {
  value: unknown;
  serverName: string;
  field: "env" | "headers";
  scope: SecretScope;
  secretsToCreate: McpSecretImportDescriptor[];
  errors: string[];
}): Record<string, McpSecretRef> | undefined {
  const { value, serverName, field, scope, secretsToCreate, errors } = params;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${serverName}.${field} must be an object`);
    return undefined;
  }
  const out: Record<string, McpSecretRef> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isMcpSecretRef(raw)) {
      out[key] = { secretRef: raw.secretRef.trim(), scope: raw.scope };
      continue;
    }
    if (typeof raw === "string") {
      const secretRef = suggestedSecretKey(serverName, field, key);
      out[key] = { secretRef, scope };
      secretsToCreate.push({
        serverName,
        field,
        key,
        scope,
        suggestedKey: secretRef,
        plaintextValue: raw,
      });
      continue;
    }
    errors.push(`${serverName}.${field}.${key} must be a string or MCP secret reference`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Import Claude Desktop-style `{ mcpServers: { [name]: ... } }` JSON into Fusion
 * definitions. Plain env/header strings are surfaced as secret creation
 * descriptors and replaced with secret references; plaintext is never stored in
 * the returned definitions.
 */
export function importMcpServersJson(json: string | unknown, options: { scope?: SecretScope } = {}): McpServersImportResult {
  const parsed = parseMcpJson(json);
  if (parsed.error) return { definitions: [], secretsToCreate: [], errors: [parsed.error] };
  const errors: string[] = [];
  const secretsToCreate: McpSecretImportDescriptor[] = [];
  const scope = options.scope ?? "project";
  const root = parsed.data;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { definitions: [], secretsToCreate, errors: ["MCP import data must be an object"] };
  }
  const servers = (root as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { definitions: [], secretsToCreate, errors: ["MCP import data must contain an mcpServers object"] };
  }

  const definitions: McpServerDefinition[] = [];
  const names = new Set<string>();
  for (const [name, rawServer] of Object.entries(servers as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
      errors.push(`${name} must be an object`);
      continue;
    }
    const raw = rawServer as Record<string, unknown>;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
    const base = { name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : name, ...(enabled !== undefined ? { enabled } : {}) };
    const transport = typeof raw.transport === "string" ? raw.transport : typeof raw.command === "string" ? "stdio" : undefined;
    let candidate: McpServerDefinition | undefined;
    if (transport === "stdio") {
      candidate = validateMcpServerDefinition({
        ...base,
        transport: "stdio",
        command: raw.command,
        args: raw.args,
        env: importSensitiveMap({ value: raw.env, serverName: base.name, field: "env", scope, secretsToCreate, errors }),
      });
    } else if (transport === "sse" || transport === "streamable-http") {
      candidate = validateMcpServerDefinition({
        ...base,
        transport,
        url: raw.url,
        headers: importSensitiveMap({ value: raw.headers, serverName: base.name, field: "headers", scope, secretsToCreate, errors }),
      });
    } else {
      errors.push(`${name}.transport must be stdio, sse, or streamable-http`);
    }
    if (!candidate) {
      errors.push(`${name} is not a valid MCP server definition`);
      continue;
    }
    if (names.has(candidate.name)) {
      errors.push(`Duplicate MCP server name: ${candidate.name}`);
      continue;
    }
    names.add(candidate.name);
    definitions.push(candidate);
  }
  return { definitions, secretsToCreate, errors };
}

function exportSensitiveMap(values: Record<string, McpSecretRef | string> | undefined): Record<string, McpSecretRef> | undefined {
  if (!values) return undefined;
  const out: Record<string, McpSecretRef> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isMcpSecretRef(value)) out[key] = { secretRef: value.secretRef, scope: value.scope };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Export Fusion MCP definitions as JSON-safe `mcpServers` data with secret refs preserved and never resolved. */
export function exportMcpServersJson(definitions: McpServerDefinition[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const definition of definitions) {
    const server = validateMcpServerDefinition(definition);
    if (!server) continue;
    if (server.transport === "stdio") {
      mcpServers[server.name] = {
        transport: "stdio",
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: exportSensitiveMap(server.env) } : {}),
      };
      continue;
    }
    mcpServers[server.name] = {
      transport: server.transport,
      ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
      url: server.url,
      ...(server.headers ? { headers: exportSensitiveMap(server.headers) } : {}),
    };
  }
  return { mcpServers };
}

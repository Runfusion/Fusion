import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GlobalSettingsStore,
  exportMcpServersJson,
  importMcpServersJson,
  isMcpSecretRef,
  resolveEffectiveMcpServers,
  validateMcpServerDefinitionDetailed,
  validateMcpServerDefinitionsDetailed,
  type GlobalSettings,
  type McpSecretRef,
  type McpServerDefinition,
  type McpServersSettings,
  type ProjectSettings,
  type SecretScope,
  type Settings,
} from "@fusion/core";
import { resolveProject, createLocalStore, type ProjectContext } from "../project-context.js";

export type McpScope = "global" | "project";
export type McpTransportInput = "stdio" | "sse" | "http" | "streamable-http";

export interface McpSensitiveInputOptions {
  env?: string[];
  headers?: string[];
  envRaw?: string[];
  headersRaw?: string[];
  createEnv?: string[];
  createHeaders?: string[];
  secretRef?: string;
  secretScope?: SecretScope;
  scope?: McpScope;
}

export interface McpMutationOptions extends McpSensitiveInputOptions {
  projectName?: string;
  scope?: McpScope;
  transport?: McpTransportInput;
  command?: string;
  args?: string[] | string;
  url?: string;
  enabled?: boolean;
}

interface McpContext {
  project?: ProjectContext;
  globalStore: GlobalSettingsStore;
}

const DEFAULT_SCOPE: McpScope = "project";

async function createGlobalSettingsStore(): Promise<GlobalSettingsStore> {
  const store = new GlobalSettingsStore();
  await store.init();
  return store;
}

async function loadContext(projectName?: string, requireProject = false): Promise<McpContext> {
  const globalStore = await createGlobalSettingsStore();
  let project: ProjectContext | undefined;
  try {
    project = await resolveProject(projectName);
  } catch (error) {
    if (requireProject || projectName) throw error;
  }
  return { project, globalStore };
}

function normalizeScope(scope?: McpScope): McpScope {
  if (!scope) return DEFAULT_SCOPE;
  if (scope !== "global" && scope !== "project") {
    throw new Error(`Invalid MCP scope "${scope}". Use global or project.`);
  }
  return scope;
}

function normalizeTransport(transport?: McpTransportInput): "stdio" | "sse" | "streamable-http" {
  if (!transport) return "stdio";
  if (transport === "http" || transport === "streamable-http") return "streamable-http";
  if (transport === "stdio" || transport === "sse") return transport;
  throw new Error(`Invalid MCP transport "${transport}". Use stdio, sse, or http.`);
}

function ensureProject(context: McpContext): ProjectContext {
  if (!context.project) {
    throw new Error("Project scope requires --project or running from a Fusion project directory.");
  }
  return context.project;
}

function mcpSettings(settings?: Pick<GlobalSettings | ProjectSettings | Settings, "mcpServers"> | null): McpServersSettings {
  return {
    enabled: settings?.mcpServers?.enabled ?? false,
    servers: Array.isArray(settings?.mcpServers?.servers) ? settings.mcpServers.servers : [],
  };
}

async function readScopedSettings(context: McpContext, scope: McpScope): Promise<McpServersSettings> {
  if (scope === "global") return mcpSettings(await context.globalStore.getSettings());
  const project = ensureProject(context);
  const scoped = await project.store.getSettingsByScope();
  return mcpSettings(scoped.project);
}

async function writeScopedSettings(context: McpContext, scope: McpScope, next: McpServersSettings): Promise<void> {
  const validation = validateMcpServerDefinitionsDetailed(next.servers ?? [], "mcpServers.servers");
  if (validation.errors.length > 0) {
    throw new Error(formatValidationErrors(validation.errors));
  }
  const normalized = { enabled: next.enabled ?? true, servers: validation.value ?? [] };
  if (scope === "global") {
    await context.globalStore.updateSettings({ mcpServers: normalized } as Partial<GlobalSettings> & Record<string, unknown>);
    return;
  }
  const project = ensureProject(context);
  await project.store.updateSettings({ mcpServers: normalized } as Partial<Settings>);
}

function upsertServer(servers: McpServerDefinition[], server: McpServerDefinition): McpServerDefinition[] {
  const without = servers.filter((entry) => entry.name !== server.name);
  return [...without, server];
}

function removeServer(servers: McpServerDefinition[], name: string): { servers: McpServerDefinition[]; removed: boolean } {
  const next = servers.filter((entry) => entry.name !== name);
  return { servers: next, removed: next.length !== servers.length };
}

function parseKeyValuePairs(values: string[] | undefined, flag: string): Array<{ key: string; value: string }> {
  return (values ?? []).map((entry) => {
    const index = entry.indexOf("=");
    if (index <= 0 || index === entry.length - 1) {
      throw new Error(`Invalid ${flag} value "${entry}". Use KEY=SECRET_REF.`);
    }
    return { key: entry.slice(0, index).trim(), value: entry.slice(index + 1).trim() };
  });
}

function assertNoPlaintextSensitiveOptions(opts: McpSensitiveInputOptions): void {
  const raw = [...(opts.envRaw ?? []), ...(opts.headersRaw ?? [])];
  if (raw.length > 0) {
    throw new Error("Plaintext MCP env/header/token values are not allowed in settings. Use --secret-ref for an existing Fusion secret or --create-secret-* to store the value in SecretsStore first.");
  }
}

async function getSecretsStore(context: McpContext) {
  const project = context.project;
  // FNXC:PostgresCutover 2026-07-05-12:00: boot the cwd fallback through the
  // PostgreSQL startup factory; bare `new TaskStore` throws in backend mode.
  const store = project?.store ?? (await createLocalStore(process.cwd()));
  return store.getSecretsStore();
}

async function resolveExistingSecret(context: McpContext, secretRef: string, scope: SecretScope): Promise<McpSecretRef> {
  const secrets = await getSecretsStore(context);
  const byId = await secrets.getSecretMetadata(secretRef, scope);
  if (byId) return { secretRef: byId.id, scope };
  const byKey = (await secrets.listSecrets(scope)).find((secret) => secret.key === secretRef);
  if (!byKey) {
    throw new Error(`Secret "${secretRef}" not found in ${scope} scope. Create it first or use --create-secret-env/--create-secret-header.`);
  }
  return { secretRef: byKey.id, scope };
}

async function createSecretRef(context: McpContext, params: { scope: SecretScope; key: string; plaintextValue: string; description: string }): Promise<McpSecretRef> {
  const secrets = await getSecretsStore(context);
  const created = await secrets.createSecret({
    scope: params.scope,
    key: params.key,
    plaintextValue: params.plaintextValue,
    description: params.description,
  });
  return { secretRef: created.id, scope: params.scope };
}

function suggestedSecretKey(serverName: string, field: "env" | "headers", key: string): string {
  const clean = (value: string): string => value.trim().replace(/[^A-Za-z0-9_.-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return ["mcp", clean(serverName), field, clean(key)].filter(Boolean).join(".");
}

async function buildSensitiveMap(
  context: McpContext,
  serverName: string,
  field: "env" | "headers",
  refValues: string[] | undefined,
  createValues: string[] | undefined,
  opts: McpSensitiveInputOptions,
): Promise<Record<string, McpSecretRef> | undefined> {
  const out: Record<string, McpSecretRef> = {};
  const secretScope = opts.secretScope ?? normalizeScope(opts.scope as McpScope | undefined);
  for (const { key, value } of parseKeyValuePairs(refValues, field === "env" ? "--env" : "--header")) {
    out[key] = await resolveExistingSecret(context, value, secretScope);
  }
  const creates = parseKeyValuePairs(createValues, field === "env" ? "--create-secret-env" : "--create-secret-header");
  for (const { key, value } of creates) {
    out[key] = await createSecretRef(context, {
      scope: secretScope,
      key: suggestedSecretKey(serverName, field, key),
      plaintextValue: value,
      description: `MCP ${field} ${key} for ${serverName}`,
    });
  }
  if (opts.secretRef && Object.keys(out).length === 0) {
    const key = field === "env" ? "TOKEN" : "Authorization";
    out[key] = await resolveExistingSecret(context, opts.secretRef, secretScope);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeArgs(value: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value : undefined;
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
  } catch {
    // Fall through to comma/space parsing for CLI convenience.
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function formatValidationErrors(errors: Array<{ path: string; message: string }>): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

async function buildServerDefinition(context: McpContext, name: string, opts: McpMutationOptions, existing?: McpServerDefinition): Promise<McpServerDefinition> {
  assertNoPlaintextSensitiveOptions(opts);
  const transport = normalizeTransport(opts.transport ?? existing?.transport as McpTransportInput | undefined);
  const enabled = opts.enabled ?? existing?.enabled;
  const base = { name, ...(enabled !== undefined ? { enabled } : {}) };
  let candidate: unknown;
  if (transport === "stdio") {
    candidate = {
      ...base,
      transport,
      command: opts.command ?? (existing?.transport === "stdio" ? existing.command : undefined),
      args: normalizeArgs(opts.args) ?? (existing?.transport === "stdio" ? existing.args : undefined),
      env: await buildSensitiveMap(context, name, "env", opts.env, opts.createEnv, opts) ?? (existing?.transport === "stdio" ? existing.env : undefined),
    };
  } else {
    candidate = {
      ...base,
      transport,
      url: opts.url ?? (existing?.transport === "sse" || existing?.transport === "streamable-http" ? existing.url : undefined),
      headers: await buildSensitiveMap(context, name, "headers", opts.headers, opts.createHeaders, opts) ?? (existing?.transport === "sse" || existing?.transport === "streamable-http" ? existing.headers : undefined),
    };
  }
  const validation = validateMcpServerDefinitionDetailed(candidate);
  if (!validation.value) throw new Error(formatValidationErrors(validation.errors));
  return validation.value;
}

function sensitiveSummary(server: McpServerDefinition): string {
  const values = server.transport === "stdio" ? server.env : server.headers;
  if (!values || Object.keys(values).length === 0) return "none";
  return Object.entries(values).map(([key, value]) => `${key}:${isMcpSecretRef(value) ? `${value.scope} secret` : "INVALID plaintext"}`).join(", ");
}

function serverLine(server: McpServerDefinition, source: string, effectiveNames: Set<string>): string {
  const state = server.enabled === false ? "disabled" : effectiveNames.has(server.name) ? "effective" : "overridden";
  const target = server.transport === "stdio" ? server.command : server.url;
  return `  ${server.name.padEnd(20)} ${source.padEnd(8)} ${state.padEnd(10)} ${server.transport.padEnd(15)} ${target ?? ""} secrets=${sensitiveSummary(server)}`;
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Listing must show global declarations, project declarations, and the project-over-global effective result without exposing secret material. Sensitive env/header fields are summarized as Fusion secret references only.
 */
export async function runMcpList(opts: { projectName?: string; json?: boolean } = {}): Promise<void> {
  const context = await loadContext(opts.projectName, false);
  const globalSettings = mcpSettings(await context.globalStore.getSettings());
  const projectSettings = context.project ? mcpSettings((await context.project.store.getSettingsByScope()).project) : undefined;
  const effective = resolveEffectiveMcpServers({ mcpServers: globalSettings }, projectSettings ? { mcpServers: projectSettings } : null);
  if (opts.json) {
    console.log(JSON.stringify({ global: globalSettings.servers ?? [], project: projectSettings?.servers ?? [], effective }, null, 2));
    return;
  }
  console.log();
  console.log("  MCP servers");
  console.log("  " + "─".repeat(80));
  const effectiveNames = new Set(effective.map((server) => server.name));
  for (const server of globalSettings.servers ?? []) console.log(serverLine(server, "global", effectiveNames));
  for (const server of projectSettings?.servers ?? []) console.log(serverLine(server, "project", effectiveNames));
  if ((globalSettings.servers?.length ?? 0) === 0 && (projectSettings?.servers?.length ?? 0) === 0) console.log("  No MCP servers configured.");
  console.log();
  console.log(`  Effective: ${effective.map((server) => server.name).join(", ") || "none"}`);
  console.log();
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Add persists an MCP server at the chosen global/project scope and lets the shared resolver decide project-over-global behavior. Env/header/token material must be an existing Fusion secret reference or be created in SecretsStore before validation; raw values never enter settings.
 */
export async function runMcpAdd(name: string, opts: McpMutationOptions = {}): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const context = await loadContext(opts.projectName, scope === "project");
  const current = await readScopedSettings(context, scope);
  if ((current.servers ?? []).some((server) => server.name === name)) throw new Error(`MCP server "${name}" already exists in ${scope} scope. Use edit to update it.`);
  const server = await buildServerDefinition(context, name, opts);
  await writeScopedSettings(context, scope, { enabled: true, servers: upsertServer(current.servers ?? [], server) });
  console.log(`✓ Added MCP server "${name}" to ${scope} scope`);
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Edit updates only the selected scope; project definitions override same-named globals and may be disabled locally. Secret-bearing fields are replaced only with Fusion secret references or newly created SecretsStore records.
 */
export async function runMcpEdit(name: string, opts: McpMutationOptions = {}): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const context = await loadContext(opts.projectName, scope === "project");
  const current = await readScopedSettings(context, scope);
  const existing = (current.servers ?? []).find((server) => server.name === name);
  if (!existing) throw new Error(`MCP server "${name}" not found in ${scope} scope.`);
  const server = await buildServerDefinition(context, name, opts, existing);
  await writeScopedSettings(context, scope, { enabled: true, servers: upsertServer(current.servers ?? [], server) });
  console.log(`✓ Updated MCP server "${name}" in ${scope} scope`);
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Remove deletes only the scoped declaration. Removing a project override can reveal an inherited global declaration again because effective MCP resolution is project-over-global by server name.
 */
export async function runMcpRemove(name: string, opts: { projectName?: string; scope?: McpScope } = {}): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const context = await loadContext(opts.projectName, scope === "project");
  const current = await readScopedSettings(context, scope);
  const next = removeServer(current.servers ?? [], name);
  if (!next.removed) throw new Error(`MCP server "${name}" not found in ${scope} scope.`);
  await writeScopedSettings(context, scope, { enabled: current.enabled ?? true, servers: next.servers });
  console.log(`✓ Removed MCP server "${name}" from ${scope} scope`);
}

async function setEnabled(name: string, enabled: boolean, opts: { projectName?: string; scope?: McpScope } = {}): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const context = await loadContext(opts.projectName, scope === "project");
  const current = await readScopedSettings(context, scope);
  const existing = (current.servers ?? []).find((server) => server.name === name);
  if (!existing) throw new Error(`MCP server "${name}" not found in ${scope} scope.`);
  await writeScopedSettings(context, scope, { enabled: current.enabled ?? true, servers: upsertServer(current.servers ?? [], { ...existing, enabled }) });
  console.log(`✓ ${enabled ? "Enabled" : "Disabled"} MCP server "${name}" in ${scope} scope`);
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Enable flips the scoped server flag only; effective availability is still computed by the foundation resolver. No secret values are read or printed while toggling MCP servers.
 */
export async function runMcpEnable(name: string, opts: { projectName?: string; scope?: McpScope } = {}): Promise<void> {
  await setEnabled(name, true, opts);
}

/**
 * FNXC:McpConfig 2026-06-25-20:52:
 * Disable records a scoped enabled:false declaration. At project scope this intentionally masks a same-named global server without deleting global configuration or exposing any secret-backed fields.
 */
export async function runMcpDisable(name: string, opts: { projectName?: string; scope?: McpScope } = {}): Promise<void> {
  await setEnabled(name, false, opts);
}

/**
 * FNXC:McpConfig 2026-06-25-21:03:
 * Claude Desktop imports must delegate parsing to the core importer. Any plaintext env/header values returned by the importer are immediately converted into SecretsStore records, then settings receive only the resulting Fusion secret references.
 */
export async function runMcpImport(filePath: string, opts: { projectName?: string; scope?: McpScope; yes?: boolean } = {}): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const context = await loadContext(opts.projectName, scope === "project");
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) throw new Error(`File not found: ${filePath}`);
  const imported = importMcpServersJson(await readFile(resolvedPath, "utf-8"), { scope });
  if (imported.errors.length > 0) throw new Error(`Invalid MCP import file:\n${imported.errors.map((error) => `  - ${error}`).join("\n")}`);
  console.log();
  console.log("  MCP Import Summary:");
  console.log(`  Source: ${resolvedPath}`);
  console.log(`  Scope: ${scope}`);
  console.log(`  Servers: ${imported.definitions.length}`);
  console.log(`  Secrets to create: ${imported.secretsToCreate.length}`);
  console.log();
  if (!opts.yes) throw new Error("Use --yes to confirm this import operation");
  const replacements = new Map<string, McpSecretRef>();
  for (const secret of imported.secretsToCreate) {
    replacements.set(`${secret.serverName}:${secret.field}:${secret.key}:${secret.suggestedKey}`, await createSecretRef(context, {
      scope: secret.scope,
      key: secret.suggestedKey,
      plaintextValue: secret.plaintextValue,
      description: `Imported MCP ${secret.field} ${secret.key} for ${secret.serverName}`,
    }));
  }
  const definitions = imported.definitions.map((server) => rewriteImportedSecretRefs(server, replacements));
  const current = await readScopedSettings(context, scope);
  await writeScopedSettings(context, scope, { enabled: true, servers: [...(current.servers ?? []).filter((server) => !definitions.some((entry) => entry.name === server.name)), ...definitions] });
  console.log(`✓ Imported ${definitions.length} MCP server(s) into ${scope} scope`);
}

function rewriteImportedSecretRefs(server: McpServerDefinition, replacements: Map<string, McpSecretRef>): McpServerDefinition {
  const rewrite = (field: "env" | "headers", values: Record<string, unknown> | undefined): Record<string, McpSecretRef> | undefined => {
    if (!values) return undefined;
    const out: Record<string, McpSecretRef> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!isMcpSecretRef(value)) continue;
      out[key] = replacements.get(`${server.name}:${field}:${key}:${value.secretRef}`) ?? value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  if (server.transport === "stdio") return { ...server, env: rewrite("env", server.env) };
  return { ...server, headers: rewrite("headers", server.headers) };
}

/**
 * FNXC:McpConfig 2026-06-25-21:03:
 * MCP export uses the core JSON exporter so secret-backed fields stay as descriptors and are never materialized. The default export is effective project-over-global configuration; explicit scope exports preserve stored declarations.
 */
export async function runMcpExport(opts: { projectName?: string; scope?: McpScope | "effective"; output?: string; json?: boolean } = {}): Promise<void> {
  const context = await loadContext(opts.projectName, opts.scope === "project");
  const scope = opts.scope ?? "effective";
  const globalSettings = mcpSettings(await context.globalStore.getSettings());
  const projectSettings = context.project ? mcpSettings((await context.project.store.getSettingsByScope()).project) : undefined;
  const definitions = scope === "global"
    ? globalSettings.servers ?? []
    : scope === "project"
      ? projectSettings?.servers ?? []
      : resolveEffectiveMcpServers({ mcpServers: globalSettings }, projectSettings ? { mcpServers: projectSettings } : null);
  const exported = exportMcpServersJson(definitions);
  const json = JSON.stringify(exported, null, 2);
  if (opts.output) {
    await writeFile(resolve(opts.output), json);
    console.log(`✓ Exported MCP servers to ${resolve(opts.output)}`);
    return;
  }
  console.log(json);
}

/**
 * FNXC:McpConfig 2026-06-25-21:03:
 * Validate is intentionally list-only until an optional MCP reachability service exists. It still uses the foundation validator so transport requirements and plaintext-secret rejection match every other MCP settings write path.
 */
export async function runMcpValidate(opts: { projectName?: string; scope?: McpScope | "effective"; json?: boolean } = {}): Promise<void> {
  const context = await loadContext(opts.projectName, opts.scope === "project");
  const scope = opts.scope ?? "effective";
  const globalSettings = mcpSettings(await context.globalStore.getSettings());
  const projectSettings = context.project ? mcpSettings((await context.project.store.getSettingsByScope()).project) : undefined;
  const definitions = scope === "global"
    ? globalSettings.servers ?? []
    : scope === "project"
      ? projectSettings?.servers ?? []
      : resolveEffectiveMcpServers({ mcpServers: globalSettings }, projectSettings ? { mcpServers: projectSettings } : null);
  const validation = validateMcpServerDefinitionsDetailed(definitions);
  const result = { ok: validation.errors.length === 0, servers: definitions.length, errors: validation.errors };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) console.log(`✓ ${definitions.length} MCP server definition(s) valid`);
  else throw new Error(formatValidationErrors(validation.errors));
}

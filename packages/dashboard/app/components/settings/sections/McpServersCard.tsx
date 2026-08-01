import "./McpServersCard.css";
import { Download, Pencil, Play, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  exportMcpServersJson,
  importMcpServersJson,
  isMcpSecretRef,
  mapPluginMcpServerContribution,
  resolveEffectiveMcpServers,
  validateMcpServerDefinitionDetailed,
  validateMcpServerDefinitionsDetailed,
  type GlobalSettings,
  type McpSecretRef,
  type McpServerDefinition,
  type McpServersSettings,
  type PluginMcpServerContribution,
  type Settings,
} from "@fusion/core";

export type McpSettingsScope = "global" | "project";
type ToastKind = "info" | "success" | "error";
type SecretScope = "project" | "global";
type Transport = McpServerDefinition["transport"];
type ValidationStatus = "idle" | "pending" | "valid" | "unreachable" | "error";
type DisplayState = "configured" | "disabled" | "inherited" | "overridden" | "project-local" | "disabled-global" | "plugin" | "plugin-overridden" | "plugin-disabled";

type FormSetter = Dispatch<SetStateAction<Settings>>;

interface SecretRecord {
  id: string;
  scope: SecretScope;
  key: string;
  description: string | null;
  accessPolicy: "auto" | "prompt" | "deny";
  envExportable: boolean;
  envExportKey: string | null;
  lastReadAt: string | null;
}

interface SensitiveRowDraft {
  id: string;
  key: string;
  secretRef: string;
  scope: SecretScope;
  createKey: string;
  createValue: string;
  required: boolean;
}

interface EditorDraft {
  originalName?: string;
  name: string;
  enabled: boolean;
  transport: Transport;
  command: string;
  argsText: string;
  url: string;
  env: SensitiveRowDraft[];
  headers: SensitiveRowDraft[];
}

interface ValidateState {
  status: ValidationStatus;
  message?: string;
}

interface DiscoveredMcpSecretDescriptor {
  field: "env" | "headers" | "token";
  key: string;
  suggestedKey: string;
  scope: SecretScope;
}

interface DiscoveredMcpServerEntry {
  source: { id: string; tool: string; label: string; scope: McpSettingsScope; path: string };
  definition: McpServerDefinition;
  alreadyConfigured: boolean;
  hasPlaintextSecrets?: boolean;
  secretDescriptors: DiscoveredMcpSecretDescriptor[];
}

interface DiscoveredMcpResponse {
  sources: Array<{ id: string; tool: string; label: string; scope: McpSettingsScope; path: string }>;
  servers: DiscoveredMcpServerEntry[];
  errors: string[];
}

export interface McpServersCardProps {
  scope: McpSettingsScope;
  form: Settings;
  setForm: FormSetter;
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null;
  projectId?: string;
  /** Already project-scoped contributions supplied by the API/provider. */
  pluginServers?: Array<{ pluginId: string; server: PluginMcpServerContribution }>;
  addToast: (message: string, type?: ToastKind) => void;
}

const EMPTY_MCP_SETTINGS: McpServersSettings = { enabled: false, servers: [] };
/*
FNXC:McpConfig 2026-07-09-00:00:
MCP-card buttons render inline lucide icons at the standard --icon-size-sm/--icon-size-md token values so icons align with button labels and match the rest of Settings.
The global .btn > svg selector is intentionally unsized, so inline icons must opt in here or they fall back to lucide's 24px default.
*/
const MCP_BUTTON_ICON_SIZE_SM = 14;
const MCP_BUTTON_ICON_SIZE_MD = 16;
let rowCounter = 0;

function nextRowId(): string {
  rowCounter += 1;
  return `mcp-sensitive-${rowCounter}`;
}

function normalizeMcpSettings(settings?: McpServersSettings): McpServersSettings {
  return {
    enabled: settings?.enabled === true,
    servers: Array.isArray(settings?.servers) ? settings.servers : [],
  };
}

function sensitiveRowsFromMap(values: Record<string, unknown> | undefined): SensitiveRowDraft[] {
  return Object.entries(values ?? {}).map(([key, value]) => {
    const ref = isMcpSecretRef(value) ? value : { secretRef: "", scope: "project" as const };
    return {
      id: nextRowId(),
      key,
      secretRef: ref.secretRef,
      scope: ref.scope,
      createKey: key,
      createValue: "",
      required: false,
    };
  });
}

function draftFromServer(server?: McpServerDefinition): EditorDraft {
  if (!server) {
    return {
      name: "",
      enabled: true,
      transport: "stdio",
      command: "",
      argsText: "",
      url: "",
      env: [],
      headers: [],
    };
  }
  return {
    originalName: server.name,
    name: server.name,
    enabled: server.enabled !== false,
    transport: server.transport,
    command: server.transport === "stdio" ? server.command : "",
    argsText: server.transport === "stdio" ? (server.args ?? []).join(" ") : "",
    url: server.transport === "stdio" ? "" : server.url,
    env: server.transport === "stdio" ? sensitiveRowsFromMap(server.env) : [],
    headers: server.transport === "stdio" ? [] : sensitiveRowsFromMap(server.headers),
  };
}

function draftFromDiscoveredServer(server: McpServerDefinition, descriptors: DiscoveredMcpSecretDescriptor[]): EditorDraft {
  const draft = draftFromServer(server);
  /* FNXC:McpConfig 2026-06-26-10:45: Discovered sensitive env/header/token descriptors are required placeholders, not optional editable rows; operators must bind each descriptor to a Fusion secret reference before the server can be saved. */
  const rowsFor = (field: "env" | "headers") => descriptors.filter((descriptor) => descriptor.field === field || (field === "headers" && descriptor.field === "token")).map((descriptor) => ({
    id: nextRowId(),
    key: descriptor.key,
    secretRef: "",
    scope: descriptor.scope,
    createKey: descriptor.suggestedKey,
    createValue: "",
    required: true,
  }));
  return server.transport === "stdio" ? { ...draft, env: rowsFor("env") } : { ...draft, headers: rowsFor("headers") };
}

function sensitiveRowsToMap(rows: SensitiveRowDraft[]): Record<string, McpSecretRef> | undefined {
  const out: Record<string, McpSecretRef> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !row.secretRef.trim()) continue;
    out[key] = { secretRef: row.secretRef.trim(), scope: row.scope };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function draftToServer(draft: EditorDraft): unknown {
  const base = { name: draft.name.trim(), ...(draft.enabled ? {} : { enabled: false }) };
  if (draft.transport === "stdio") {
    const args = draft.argsText.split(/\s+/u).map((entry) => entry.trim()).filter(Boolean);
    return {
      ...base,
      transport: "stdio",
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(sensitiveRowsToMap(draft.env) ? { env: sensitiveRowsToMap(draft.env) } : {}),
    };
  }
  return {
    ...base,
    transport: draft.transport,
    url: draft.url.trim(),
    ...(sensitiveRowsToMap(draft.headers) ? { headers: sensitiveRowsToMap(draft.headers) } : {}),
  };
}

function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Request failed" }));
      throw new Error(String(payload?.error ?? "Request failed"));
    }
    return response.json() as Promise<T>;
  });
}

function serverSummary(server: McpServerDefinition): string {
  if (server.transport === "stdio") return `${server.command}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`;
  return server.url;
}

function getValidateDotClass(status: ValidationStatus): string {
  if (status === "valid") return "status-dot status-dot--online";
  if (status === "pending") return "status-dot status-dot--pending";
  if (status === "unreachable" || status === "error") return "status-dot status-dot--error";
  return "status-dot";
}

function getStateLabel(state: DisplayState): string {
  if (state === "disabled-global") return "disabled global";
  if (state === "project-local") return "project local";
  if (state === "plugin-overridden") return "plugin overridden";
  if (state === "plugin-disabled") return "plugin disabled";
  return state;
}

function getValidationLabel(status: ValidationStatus): string {
  if (status === "idle") return "Not tested";
  if (status === "pending") return "Testing…";
  return status;
}

/**
 * FNXC:McpConfig 2026-06-26-01:17:
 * MCP settings are edited through one card for global and project scopes. Sensitive env/header/token-like values are modeled only as Fusion secret references; this component never writes plaintext sensitive values into the settings form.
 *
 * FNXC:McpConfig 2026-06-26-01:17:
 * FNXC:PluginMcpServers 2026-07-22-12:00:
 * FN-8491 renders plugin provenance only for the project card. Global settings
 * remain plugin-free; project actions persist only local overrides or tombstones.
 *
 * Project MCP declarations override global servers by matching name and may save enabled:false tombstones to disable inherited global servers. The project card shows inherited, overridden, local, and disabled states so operators can see effective behavior before saving.
 */
export function McpServersCard({ scope, form, setForm, globalSettings, projectId, pluginServers = [], addToast }: McpServersCardProps) {
  const { t } = useTranslation("app");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settings = normalizeMcpSettings(form.mcpServers ?? EMPTY_MCP_SETTINGS);
  const globalMcp = normalizeMcpSettings(globalSettings?.mcpServers);
  const configuredServers = settings.servers ?? [];
  const globalServers = globalMcp.servers ?? [];
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretRecord[]>([]);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [exportText, setExportText] = useState("");
  const [validateStates, setValidateStates] = useState<Record<string, ValidateState>>({});
  const [discovered, setDiscovered] = useState<DiscoveredMcpResponse | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const reloadSecrets = useCallback(async () => {
    try {
      const data = await requestJson<{ secrets: SecretRecord[] }>("/api/secrets");
      setSecrets(data.secrets);
      setSecretsError(null);
    } catch (error) {
      setSecretsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void reloadSecrets();
  }, [reloadSecrets]);

  const scanDiscoveredServers = useCallback(async () => {
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const params = new URLSearchParams({ scope });
      if (projectId) params.set("projectId", projectId);
      setDiscovered(await requestJson<DiscoveredMcpResponse>(`/api/mcp/discovered?${params.toString()}`));
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : String(error));
      setDiscovered({ sources: [], servers: [], errors: [] });
    } finally {
      setDiscoveryLoading(false);
    }
  }, [projectId, scope]);

  useEffect(() => {
    void scanDiscoveredServers();
  }, [scanDiscoveredServers]);

  const effectiveServers = useMemo(
    () => scope === "project" ? resolveEffectiveMcpServers({ mcpServers: globalMcp }, { mcpServers: form.mcpServers }, pluginServers) : configuredServers.filter((server) => server.enabled !== false),
    [configuredServers, form.mcpServers, globalMcp, pluginServers, scope],
  );
  const pluginByName = useMemo(() => new Map(pluginServers
    .filter((entry) => entry.server.enabledByDefault !== false)
    .map((entry) => ({ ...entry, definition: mapPluginMcpServerContribution(entry.server) }))
    .filter((entry): entry is { pluginId: string; server: PluginMcpServerContribution; definition: McpServerDefinition } => Boolean(entry.definition))
    .map((entry) => [entry.definition.name, entry])), [pluginServers]);

  const globalByName = useMemo(() => new Map(globalServers.map((server) => [server.name, server])), [globalServers]);
  const projectByName = useMemo(() => new Map(configuredServers.map((server) => [server.name, server])), [configuredServers]);
  const configuredNames = useMemo(() => new Set(configuredServers.map((server) => server.name)), [configuredServers]);
  const discoveredGroups = useMemo(() => {
    const groups = new Map<string, DiscoveredMcpServerEntry[]>();
    for (const entry of discovered?.servers ?? []) {
      const existing = groups.get(entry.source.label) ?? [];
      existing.push(entry);
      groups.set(entry.source.label, existing);
    }
    return [...groups.entries()];
  }, [discovered?.servers]);

  const displayRows = useMemo(() => {
    if (scope === "global") return configuredServers.map((server): { server: McpServerDefinition; state: DisplayState } => ({ server, state: server.enabled === false ? "disabled" : "configured" }));
    const effectiveByName = new Set(effectiveServers.map((server) => server.name));
    const rows: Array<{ server: McpServerDefinition; state: DisplayState }> = [];
    // FNXC:PluginMcpServers 2026-07-22-12:00:
    // The project card must display the same global → plugin → project winner
    // that session resolution uses. In particular, a plugin replaces a
    // same-name global server rather than being hidden behind it (FN-8491/#2401).
    const inheritedByName = new Map<string, { server: McpServerDefinition; plugin: boolean }>();
    for (const server of globalServers) inheritedByName.set(server.name, { server, plugin: false });
    for (const [name, entry] of pluginByName) inheritedByName.set(name, { server: entry.definition, plugin: true });
    for (const [name, inherited] of inheritedByName) {
      const projectServer = projectByName.get(name);
      if (projectServer?.enabled === false) {
        rows.push({ server: projectServer, state: inherited.plugin ? "plugin-disabled" : "disabled-global" });
      } else if (projectServer) {
        rows.push({ server: projectServer, state: inherited.plugin ? "plugin-overridden" : effectiveByName.has(name) ? "overridden" : "disabled" });
      } else {
        rows.push({ server: inherited.server, state: inherited.plugin ? (effectiveByName.has(name) ? "plugin" : "plugin-disabled") : (effectiveByName.has(name) ? "inherited" : "disabled") });
      }
    }
    for (const server of configuredServers) {
      if (!inheritedByName.has(server.name)) rows.push({ server, state: server.enabled === false || !effectiveByName.has(server.name) ? "disabled" : "project-local" });
    }
    return rows;
  }, [configuredServers, effectiveServers, globalServers, pluginByName, projectByName, scope]);

  const updateMcpSettings = (next: McpServersSettings) => {
    setForm((current) => ({ ...current, mcpServers: next }));
  };

  const setEnabled = (enabled: boolean) => updateMcpSettings({ ...settings, enabled });

  const saveServer = () => {
    if (!editor) return;
    setEditorError(null);
    const unboundRequired = [...editor.env, ...editor.headers].filter((row) => row.required && (!row.key.trim() || !row.secretRef.trim()));
    if (unboundRequired.length > 0) {
      setEditorError(t("settings.mcp.discoverySecretsRequired", "Bind or create Fusion secret references before saving this discovered server."));
      return;
    }
    const parsed = validateMcpServerDefinitionDetailed(draftToServer(editor));
    if (!parsed.value) {
      setEditorError(parsed.errors.map((error) => error.message).join("; "));
      return;
    }
    const nextServers = configuredServers.filter((server) => server.name !== (editor.originalName ?? parsed.value!.name));
    const duplicate = nextServers.some((server) => server.name === parsed.value!.name);
    if (duplicate) {
      setEditorError(t("settings.mcp.duplicateName", "Duplicate MCP server name"));
      return;
    }
    const all = [...nextServers, parsed.value];
    const allValid = validateMcpServerDefinitionsDetailed(all);
    if (!allValid.value) {
      setEditorError(allValid.errors.map((error) => error.message).join("; "));
      return;
    }
    updateMcpSettings({ ...settings, enabled: true, servers: allValid.value });
    setEditor(null);
  };

  const removeServer = (name: string) => {
    updateMcpSettings({ ...settings, servers: configuredServers.filter((server) => server.name !== name) });
    setValidateStates((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const addDiscoveredServer = (entry: DiscoveredMcpServerEntry) => {
    if (configuredNames.has(entry.definition.name)) return;
    /* FNXC:McpConfig 2026-06-26-10:31: Discovered MCP servers remain inert until this explicit Add action. Servers without sensitive fields can be copied into settings; servers with env/header/token descriptors open the editor with blank secret bindings so plaintext is never persisted. */
    if (entry.secretDescriptors.length > 0 || entry.hasPlaintextSecrets) {
      setEditor(draftFromDiscoveredServer(entry.definition, entry.secretDescriptors));
      setEditorError(t("settings.mcp.discoverySecretsRequired", "Bind or create Fusion secret references before saving this discovered server."));
      return;
    }
    const next = [...configuredServers.filter((server) => server.name !== entry.definition.name), entry.definition];
    updateMcpSettings({ ...settings, enabled: true, servers: next });
    addToast(t("settings.mcp.discoveredAdded", "Discovered MCP server added"), "success");
  };

  const disableInheritedServer = (name: string) => {
    const inherited = pluginByName.get(name)?.definition ?? globalByName.get(name);
    const tombstone: McpServerDefinition = inherited?.transport === "sse" || inherited?.transport === "streamable-http"
      ? { name, enabled: false, transport: inherited.transport, url: inherited.url }
      : { name, enabled: false, transport: "stdio", command: inherited?.transport === "stdio" ? inherited.command : "disabled" };
    updateMcpSettings({ ...settings, enabled: true, servers: [...configuredServers.filter((server) => server.name !== name), tombstone] });
  };

  const createSecretForRow = async (row: SensitiveRowDraft, field: "env" | "headers") => {
    if (!editor) return;
    const key = row.createKey.trim() || row.key.trim();
    if (!key || !row.createValue) {
      setEditorError(t("settings.mcp.secretCreateRequired", "Secret key and value are required."));
      return;
    }
    try {
      const secret = await requestJson<SecretRecord>("/api/secrets", {
        method: "POST",
        body: JSON.stringify({
          scope: row.scope,
          key,
          value: row.createValue,
          description: `MCP ${editor.name || "server"} ${field} ${row.key}`,
          accessPolicy: "prompt",
          envExportable: false,
          envExportKey: null,
        }),
      });
      setEditor((current) => current && {
        ...current,
        [field]: current[field].map((candidate) => candidate.id === row.id ? { ...candidate, secretRef: secret.id, scope: secret.scope, createKey: secret.key, createValue: "" } : candidate),
      });
      await reloadSecrets();
      addToast(t("settings.mcp.secretCreated", "Secret created"), "success");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    }
  };

  const validateServer = async (server: McpServerDefinition) => {
    setValidateStates((current) => ({ ...current, [server.name]: { status: "pending", message: t("settings.mcp.testing", "Testing…") } }));
    try {
      const result = await requestJson<{ status: "valid" | "unreachable" | "error"; message?: string }>("/api/mcp/validate", {
        method: "POST",
        body: JSON.stringify({ server }),
      });
      setValidateStates((current) => ({ ...current, [server.name]: { status: result.status, message: result.message ?? getValidationLabel(result.status) } }));
    } catch (error) {
      setValidateStates((current) => ({ ...current, [server.name]: { status: "error", message: error instanceof Error ? error.message : String(error) } }));
    }
  };

  const importServers = async (text: string) => {
    setImportError(null);
    const result = importMcpServersJson(text, { scope });
    if (result.errors.length > 0) {
      setImportError(result.errors.join("; "));
      return;
    }
    const existingNames = new Set(configuredServers.map((server) => server.name));
    const duplicate = result.definitions.find((server) => existingNames.has(server.name));
    if (duplicate) {
      setImportError(t("settings.mcp.importDuplicate", "Duplicate MCP server name: {{name}}", { name: duplicate.name }));
      return;
    }
    try {
      const refBySuggestedKey = new Map<string, McpSecretRef>();
      for (const descriptor of result.secretsToCreate) {
        const secret = await requestJson<SecretRecord>("/api/secrets", {
          method: "POST",
          body: JSON.stringify({
            scope: descriptor.scope,
            key: descriptor.suggestedKey,
            value: descriptor.plaintextValue,
            description: `MCP import ${descriptor.serverName} ${descriptor.field} ${descriptor.key}`,
            accessPolicy: "prompt",
            envExportable: false,
            envExportKey: null,
          }),
        });
        refBySuggestedKey.set(descriptor.suggestedKey, { secretRef: secret.id, scope: secret.scope });
      }
      const definitions = result.definitions.map((server) => {
        if (server.transport === "stdio") {
          const env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, isMcpSecretRef(value) && refBySuggestedKey.has(value.secretRef) ? refBySuggestedKey.get(value.secretRef)! : value]));
          return { ...server, ...(Object.keys(env).length > 0 ? { env } : {}) };
        }
        const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, isMcpSecretRef(value) && refBySuggestedKey.has(value.secretRef) ? refBySuggestedKey.get(value.secretRef)! : value]));
        return { ...server, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
      });
      updateMcpSettings({ ...settings, enabled: true, servers: [...configuredServers, ...definitions] });
      setImportText("");
      await reloadSecrets();
      addToast(t("settings.mcp.imported", "MCP servers imported"), "success");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const exportServers = async () => {
    const payload = JSON.stringify(exportMcpServersJson(configuredServers), null, 2);
    setExportText(payload);
    try {
      await navigator.clipboard?.writeText(payload);
      addToast(t("settings.mcp.exportCopied", "MCP JSON copied"), "success");
    } catch {
      addToast(t("settings.mcp.exportReady", "MCP JSON ready to copy"), "info");
    }
  };

  const renderSensitiveRows = (field: "env" | "headers", rows: SensitiveRowDraft[]) => (
    <div className="mcp-sensitive-list" data-testid={`mcp-${field}-rows`}>
      {/* FNXC:McpConfig 2026-06-26-01:17: This picker is the only UI seam for MCP env/header secrets. Operators may create a secret value here, but the settings draft receives only { secretRef, scope }, never the plaintext input. */}
      <div className="mcp-subheading">{field === "env" ? t("settings.mcp.env", "Environment secret refs") : t("settings.mcp.headers", "Header secret refs")}</div>
      {rows.length === 0 ? <p className="mcp-empty-inline">{t("settings.mcp.noSensitiveRows", "No secret references configured.")}</p> : null}
      {rows.map((row) => (
        <div className="mcp-sensitive-row" key={row.id}>
          <input className="input" aria-label={t("settings.mcp.sensitiveKey", "Sensitive field name")} value={row.key} onChange={(event) => setEditor((current) => current && { ...current, [field]: current[field].map((candidate) => candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate) })} placeholder={field === "env" ? "API_KEY" : "Authorization"} readOnly={row.required} />
          {row.required ? <span className="mcp-state-badge mcp-state-badge--required">{t("settings.mcp.requiredSecret", "Required")}</span> : null}
          <select className="select" aria-label={t("settings.mcp.secretReference", "Secret reference")} value={`${row.scope}:${row.secretRef}`} onChange={(event) => {
            const [nextScope, nextRef] = event.target.value.split(":");
            setEditor((current) => current && { ...current, [field]: current[field].map((candidate) => candidate.id === row.id ? { ...candidate, scope: nextScope as SecretScope, secretRef: nextRef } : candidate) });
          }}>
            <option value={`${row.scope}:`}>{t("settings.mcp.chooseSecret", "Choose a secret…")}</option>
            {secrets.map((secret) => <option key={`${secret.scope}:${secret.id}`} value={`${secret.scope}:${secret.id}`}>{secret.scope}: {secret.key}</option>)}
          </select>
          <input className="input" aria-label={t("settings.mcp.newSecretKey", "New secret key")} value={row.createKey} onChange={(event) => setEditor((current) => current && { ...current, [field]: current[field].map((candidate) => candidate.id === row.id ? { ...candidate, createKey: event.target.value } : candidate) })} placeholder={t("settings.mcp.newSecretKey", "New secret key")} />
          <input className="input" type="password" aria-label={t("settings.mcp.newSecretValue", "New secret value (not stored in settings)")} value={row.createValue} onChange={(event) => setEditor((current) => current && { ...current, [field]: current[field].map((candidate) => candidate.id === row.id ? { ...candidate, createValue: event.target.value } : candidate) })} placeholder={t("settings.mcp.createSecretPlaceholder", "Create secret value")} />
          <button type="button" className="btn btn-sm touch-target" onClick={() => void createSecretForRow(row, field)}>{t("settings.mcp.createSecret", "Create secret")}</button>
          {row.required ? null : <button type="button" className="btn btn-icon touch-target" aria-label={t("settings.mcp.removeSensitive", "Remove secret reference")} onClick={() => setEditor((current) => current && { ...current, [field]: current[field].filter((candidate) => candidate.id !== row.id) })}><Trash2 aria-hidden="true" /></button>}
        </div>
      ))}
      <button type="button" className="btn btn-sm touch-target" onClick={() => setEditor((current) => current && { ...current, [field]: [...current[field], { id: nextRowId(), key: "", secretRef: "", scope, createKey: "", createValue: "", required: false }] })}><Plus aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {t("settings.mcp.addSecretRef", "Add secret reference")}</button>
      {secretsError ? <p className="form-error">{secretsError}</p> : null}
    </div>
  );

  return (
    <section className="card mcp-servers-card" data-testid={`mcp-servers-card-${scope}`}>
      <div className="mcp-servers-card__header">
        <div>
          <h5 className="mcp-servers-card__title">{scope === "global" ? t("settings.mcp.globalTitle", "Global MCP servers") : t("settings.mcp.projectTitle", "Project MCP servers")}</h5>
          <p className="mcp-servers-card__description">{scope === "global" ? t("settings.mcp.globalDescription", "Configure MCP servers shared by all projects. Project settings may override or disable these servers by name.") : t("settings.mcp.projectDescription", "Configure project-specific MCP servers, overrides, and disabled inherited servers.")}</p>
        </div>
        <button type="button" className="btn btn-primary touch-target" onClick={() => { setEditor(draftFromServer()); setEditorError(null); }}><Plus aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_MD} /> {t("settings.mcp.addServer", "Add server")}</button>
      </div>

      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. settingKey is scope-suffixed because this card renders once per scope and bubble DOM ids must stay unique. */}
      <div className="settings-field-label-row">
        <label className="checkbox-label mcp-enabled-toggle">
          <input type="checkbox" checked={settings.enabled === true} onChange={(event) => setEnabled(event.target.checked)} />
          {t("settings.mcp.enabled", "Enable MCP servers for this scope")}
        </label>
        <SettingsHelpTip settingKey={`mcp-enabled-${scope}`}>{t("settings.mcp.enabledHint", "Default: disabled, with no servers configured.")}</SettingsHelpTip>
      </div>

      <div className="mcp-discovery card" data-testid={`mcp-discovery-${scope}`}>
        <div className="mcp-discovery__header">
          <div>
            <h6>{t("settings.mcp.discoveryTitle", "Discovered on this machine")}</h6>
            <p>{t("settings.mcp.discoveryDescription", "Read-only scan of Claude, Cursor, Windsurf, and VS Code MCP config files. Add a server to enable it in Fusion.")}</p>
          </div>
          <button type="button" className="btn btn-sm touch-target" onClick={() => void scanDiscoveredServers()} disabled={discoveryLoading}><RefreshCw aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {discoveryLoading ? t("settings.mcp.scanning", "Scanning…") : t("settings.mcp.scanAgain", "Scan again")}</button>
        </div>
        {discoveryError ? <p className="form-error">{discoveryError}</p> : null}
        {(discovered?.errors?.length ?? 0) > 0 ? <div className="mcp-discovery__notes" role="note">{discovered?.errors?.map((error) => <p key={error}>{error}</p>)}</div> : null}
        {!discoveryLoading && discoveredGroups.length === 0 ? <p className="mcp-empty" data-testid={`mcp-discovery-empty-${scope}`}>{t("settings.mcp.discoveryEmpty", "No MCP servers found in supported tool configs yet.")}</p> : null}
        {discoveredGroups.map(([label, entries]) => (
          <div className="mcp-discovery__group" key={label}>
            <div className="mcp-subheading">{label}</div>
            {entries.map((entry) => {
              const isConfigured = entry.alreadyConfigured || configuredNames.has(entry.definition.name);
              return (
                <article className="mcp-discovery-row" key={`${entry.source.id}:${entry.definition.name}`} data-testid={`mcp-discovery-row-${scope}-${entry.source.id}-${entry.definition.name}`}>
                  <div className="mcp-server-row__main">
                    <div className="mcp-server-row__titleline"><strong>{entry.definition.name}</strong><span className="mcp-transport-badge">{entry.definition.transport}</span>{isConfigured ? <span className="mcp-state-badge mcp-state-badge--configured">{t("settings.mcp.configuredBadge", "Configured")}</span> : null}</div>
                    <p>{serverSummary(entry.definition)}</p>
                    {entry.secretDescriptors.length > 0 ? <p className="mcp-discovery-row__note">{t("settings.mcp.discoverySecrets", "Requires Fusion secret references before saving.")}</p> : null}
                  </div>
                  <div className="mcp-server-row__actions"><button type="button" className="btn btn-sm touch-target" onClick={() => addDiscoveredServer(entry)} disabled={isConfigured}>{isConfigured ? t("settings.mcp.configured", "Configured") : t("settings.mcp.addDiscovered", "Add")}</button></div>
                </article>
              );
            })}
          </div>
        ))}
      </div>

      {displayRows.length === 0 ? <p className="mcp-empty" data-testid={`mcp-empty-${scope}`}>{t("settings.mcp.empty", "No MCP servers configured.")}</p> : (
        <div className="mcp-server-list">
          {displayRows.map(({ server, state }) => {
            const validation = validateStates[server.name] ?? { status: "idle" as const };
            const editable = scope === "global" || state !== "inherited";
            return (
              /*
              FNXC:McpSettings 2026-07-22-12:10:
              Row identity is server.name alone. Embedding the derived `state` in the key remounted the row on every state transition (inherited -> project-local, enable/disable) even though the row represents the same server; validation state lives externally in `validateStates`, so nothing relies on the remount.
              */
              <article className="mcp-server-row" key={server.name} data-testid={`mcp-server-row-${server.name}`}>
                <div className="mcp-server-row__main">
                  <div className="mcp-server-row__titleline">
                    <strong>{server.name}</strong>
                    <span className={`mcp-state-badge mcp-state-badge--${state}`} data-state={state}>{getStateLabel(state)}</span>{scope === "project" && pluginByName.has(server.name) ? <span className="mcp-state-badge" data-testid={`mcp-plugin-provenance-${server.name}`}>{`plugin:${pluginByName.get(server.name)!.pluginId}`}</span> : null}
                    <span className="mcp-transport-badge">{server.transport}</span>
                  </div>
                  <p>{serverSummary(server)}</p>
                  <p className={`mcp-validation-status mcp-validation-status--${validation.status}`} data-testid={`mcp-validation-${server.name}`} aria-live="polite"><span className={getValidateDotClass(validation.status)} aria-hidden="true" /> <span className="mcp-validation-status__badge">{validation.status === "idle" ? t("settings.mcp.notTested", "Not tested") : getValidationLabel(validation.status)}</span>{validation.message ? <span>{validation.message}</span> : null}</p>
                </div>
                <div className="mcp-server-row__actions">
                  <button type="button" className="btn btn-sm touch-target" onClick={() => void validateServer(server)} disabled={validation.status === "pending"}><Play aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {validation.status === "pending" ? t("settings.mcp.testing", "Testing…") : t("settings.mcp.test", "Test")}</button>
                  {(state === "inherited" || state === "plugin") ? <button type="button" className="btn btn-sm touch-target" onClick={() => { setEditor(draftFromServer(server)); setEditorError(null); }}><Pencil aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {t("settings.mcp.override", "Override")}</button> : null}
                  {(state === "inherited" || state === "plugin") ? <button type="button" className="btn btn-warning btn-sm touch-target" onClick={() => disableInheritedServer(server.name)}>{t("settings.mcp.disableInherited", "Disable")}</button> : null}
                  {editable ? <button type="button" className="btn btn-sm touch-target" onClick={() => { setEditor(draftFromServer(server)); setEditorError(null); }}><Pencil aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {t("actions.edit", "Edit")}</button> : null}
                  {editable ? <button type="button" className="btn btn-icon touch-target" aria-label={t("settings.mcp.removeServer", "Remove {{name}}", { name: server.name })} onClick={() => removeServer(server.name)}><Trash2 aria-hidden="true" /></button> : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editor ? (
        <div className="mcp-editor card" data-testid="mcp-server-editor">
          <div className="mcp-editor-grid">
            <label className="form-group"><span>{t("settings.mcp.name", "Name")}</span><input className="input" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
            <label className="form-group"><span>{t("settings.mcp.transport", "Transport")}</span><select className="select" value={editor.transport} onChange={(event) => setEditor({ ...editor, transport: event.target.value as Transport })}><option value="stdio">stdio</option><option value="sse">SSE</option><option value="streamable-http">HTTP</option></select></label>
            <label className="checkbox-label"><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} /> {t("settings.mcp.serverEnabled", "Server enabled")}</label>
            {editor.transport === "stdio" ? <><label className="form-group"><span>{t("settings.mcp.command", "Command")}</span><input className="input" value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} /></label><label className="form-group"><span>{t("settings.mcp.args", "Arguments")}</span><input className="input" value={editor.argsText} onChange={(event) => setEditor({ ...editor, argsText: event.target.value })} /></label></> : <label className="form-group mcp-editor-grid__wide"><span>{t("settings.mcp.url", "URL")}</span><input className="input" value={editor.url} onChange={(event) => setEditor({ ...editor, url: event.target.value })} /></label>}
          </div>
          {editor.transport === "stdio" ? renderSensitiveRows("env", editor.env) : renderSensitiveRows("headers", editor.headers)}
          {editorError ? <p className="form-error">{editorError}</p> : null}
          <div className="modal-actions"><button type="button" className="btn" onClick={() => { setEditor(null); setEditorError(null); }}>{t("actions.cancel", "Cancel")}</button><button type="button" className="btn btn-primary" onClick={saveServer}>{t("actions.save", "Save")}</button></div>
        </div>
      ) : null}

      <div className="mcp-import-export">
        <div className="mcp-import-export__pane">
          <h6>{t("settings.mcp.import", "Import")}</h6>
          <textarea className="input mcp-json-textarea" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={t("settings.mcp.importPlaceholder", "Paste Claude Desktop mcpServers JSON")} />
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void file.text().then(setImportText); event.target.value = ""; }} />
          <div className="mcp-inline-actions"><button type="button" className="btn btn-sm touch-target" onClick={() => fileInputRef.current?.click()}><Upload aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {t("settings.mcp.uploadJson", "Upload JSON")}</button><button type="button" className="btn btn-sm touch-target" onClick={() => void importServers(importText)}>{t("settings.mcp.import", "Import")}</button></div>
          {importError ? <p className="form-error">{importError}</p> : null}
        </div>
        <div className="mcp-import-export__pane">
          <h6>{t("settings.mcp.export", "Export")}</h6>
          <button type="button" className="btn btn-sm touch-target" onClick={() => void exportServers()}><Download aria-hidden="true" size={MCP_BUTTON_ICON_SIZE_SM} /> {t("settings.mcp.copyExport", "Copy Fusion MCP JSON")}</button>
          {exportText ? <a className="btn btn-sm touch-target" download="fusion-mcp-servers.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(exportText)}`}>{t("settings.mcp.downloadExport", "Download JSON")}</a> : null}
          {exportText ? <textarea className="input mcp-json-textarea" readOnly value={exportText} aria-label={t("settings.mcp.exportedJson", "Exported MCP JSON")} /> : null}
        </div>
      </div>
      {scope === "project" ? <p className="mcp-effective-count">{t("settings.mcp.effectiveCount", "Effective enabled servers: {{count}}", { count: effectiveServers.length })}</p> : null}
    </section>
  );
}

export default McpServersCard;

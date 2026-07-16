import type {
  DirectMergeCommitStrategy,
  GithubAuthMode,
  HeartbeatPromptTemplate,
  HeartbeatScopeDisciplineMode,
  Locale,
  McpSensitiveValue,
  McpServerDefinition,
  McpServersSettings,
  SandboxBackendName,
  SandboxFailureMode,
  SandboxPolicy,
  SandboxProjectSettings,
  UnavailableNodePolicy,
} from "./types.js";
import { isLocale, isMcpSecretRef } from "./types.js";

/*
FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
`recycleWorktrees` and `worktreeNaming: "task-id"` are MUTUALLY EXCLUSIVE. "task-id" naming enables
task-pinned worktrees — each task owns exactly one derivable directory `<worktreesDir>/<task-id>` for its
whole lifecycle — which is fundamentally incompatible with the cross-task recycle pool (a recycled dir
belongs to a different task and carries the wrong name). The operator rule is "task-pinned worktrees only
apply when recycling is off", so the combination is rejected at every settings-write boundary
(store.updateSettings backstop + dashboard PUT /settings for a clean 400) instead of being silently resolved.
*/
export const RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE =
  'recycleWorktrees and worktreeNaming:"task-id" are mutually exclusive: "task-id" naming pins each task to its own worktree directory, which is incompatible with the cross-task recycle pool. Disable recycleWorktrees to use "task-id" naming, or choose "random"/"task-title" naming to keep recycling.';

/** True when the resolved settings enable BOTH the recycle pool and task-pinned ("task-id") naming. */
export function isRecycleWorktreeNamingConflict(
  settings: { recycleWorktrees?: boolean; worktreeNaming?: string } | undefined,
): boolean {
  return settings?.recycleWorktrees === true && settings?.worktreeNaming === "task-id";
}

/** Throws with {@link RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE} when both settings are enabled together. */
export function assertWorktreeNamingRecycleExclusive(
  settings: { recycleWorktrees?: boolean; worktreeNaming?: string } | undefined,
): void {
  if (isRecycleWorktreeNamingConflict(settings)) {
    throw new Error(RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE);
  }
}

const UNAVAILABLE_NODE_POLICIES: readonly UnavailableNodePolicy[] = ["block", "fallback-local"] as const;
const DIRECT_MERGE_COMMIT_STRATEGIES: readonly DirectMergeCommitStrategy[] = ["auto", "always-squash", "always-rebase"] as const;
const GITHUB_AUTH_MODES: readonly GithubAuthMode[] = ["gh-cli", "token"] as const;
const GITHUB_REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const HEARTBEAT_SCOPE_DISCIPLINE_MODES: readonly HeartbeatScopeDisciplineMode[] = [
  "strict",
  "lite",
  "off",
] as const;
const HEARTBEAT_PROMPT_TEMPLATES: readonly HeartbeatPromptTemplate[] = [
  "default",
  "compact",
] as const;

export const SANDBOX_BACKEND_NAMES: readonly SandboxBackendName[] = [
  "native",
  "sandbox-exec",
  "bubblewrap",
  "docker",
  "podman",
  "custom",
] as const;

export const SANDBOX_FAILURE_MODES: readonly SandboxFailureMode[] = ["fail-hard", "fallback-native"] as const;

/**
 * Validates a project unavailable-node routing policy value.
 *
 * Returns the normalized policy value when valid, otherwise undefined.
 */
export function validateUnavailableNodePolicy(value: unknown): UnavailableNodePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (UNAVAILABLE_NODE_POLICIES as readonly string[]).includes(value)
    ? (value as UnavailableNodePolicy)
    : undefined;
}

/** Returns a validated UI locale for global settings, otherwise undefined. */
export function validateLocale(value: unknown): Locale | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isLocale(value) ? value : undefined;
}

/** Returns a validated direct-merge commit strategy for project settings, otherwise undefined. */
export function validateDirectMergeCommitStrategy(value: unknown): DirectMergeCommitStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (DIRECT_MERGE_COMMIT_STRATEGIES as readonly string[]).includes(value)
    ? (value as DirectMergeCommitStrategy)
    : undefined;
}

/** Returns a validated GitHub auth mode for project settings, otherwise undefined. */
export function validateGithubAuthMode(value: unknown): GithubAuthMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (GITHUB_AUTH_MODES as readonly string[]).includes(value) ? (value as GithubAuthMode) : undefined;
}

/** Returns a validated owner/repo GitHub slug, otherwise undefined. Empty string is treated as unset. */
export function validateGithubRepoSlug(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return GITHUB_REPO_SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Returns a validated heartbeat scope-discipline mode for project/agent settings, otherwise undefined. */
export function validateHeartbeatScopeDisciplineMode(value: unknown): HeartbeatScopeDisciplineMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (HEARTBEAT_SCOPE_DISCIPLINE_MODES as readonly string[]).includes(value)
    ? (value as HeartbeatScopeDisciplineMode)
    : undefined;
}

/** Returns a validated heartbeat prompt template for project/agent settings, otherwise undefined. */
export function validateHeartbeatPromptTemplate(value: unknown): HeartbeatPromptTemplate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (HEARTBEAT_PROMPT_TEMPLATES as readonly string[]).includes(value)
    ? (value as HeartbeatPromptTemplate)
    : undefined;
}

/** Returns a validated sandbox backend name for project settings, otherwise undefined. */
export function validateSandboxBackendName(value: unknown): SandboxBackendName | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (SANDBOX_BACKEND_NAMES as readonly string[]).includes(value) ? (value as SandboxBackendName) : undefined;
}

/** Returns a validated sandbox failure mode for project settings, otherwise undefined. */
export function validateSandboxFailureMode(value: unknown): SandboxFailureMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (SANDBOX_FAILURE_MODES as readonly string[]).includes(value) ? (value as SandboxFailureMode) : undefined;
}

/** Returns a validated sandbox policy object for project settings, otherwise undefined. */
export function validateSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const raw = value as { allowNetwork?: unknown; allowedPaths?: unknown };
  const policy: SandboxPolicy = {};

  if (typeof raw.allowNetwork === "boolean") {
    policy.allowNetwork = raw.allowNetwork;
  }

  if (Array.isArray(raw.allowedPaths)) {
    const candidatePaths = raw.allowedPaths;
    const hasOnlyValidPaths = candidatePaths.every(
      (entry) => typeof entry === "string" && entry.length > 0 && !entry.includes("..") && !entry.startsWith("~"),
    );
    if (hasOnlyValidPaths) {
      policy.allowedPaths = candidatePaths as string[];
    }
  }

  if (policy.allowNetwork === undefined && policy.allowedPaths === undefined) {
    return undefined;
  }
  return policy;
}

/** Returns validated sandbox project settings, otherwise undefined. */
export function validateSandboxProjectSettings(value: unknown): SandboxProjectSettings | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const raw = value as {
    backend?: unknown;
    policy?: unknown;
    failureMode?: unknown;
  };

  const backend = validateSandboxBackendName(raw.backend);
  const policy = validateSandboxPolicy(raw.policy);
  const failureMode = validateSandboxFailureMode(raw.failureMode);

  if (backend === undefined && policy === undefined && failureMode === undefined) {
    return undefined;
  }

  return {
    ...(backend !== undefined ? { backend } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(failureMode !== undefined ? { failureMode } : {}),
  };
}

export interface McpValidationError {
  path: string;
  code:
    | "invalid-shape"
    | "invalid-name"
    | "duplicate-name"
    | "invalid-transport"
    | "missing-command"
    | "missing-url"
    | "invalid-args"
    | "invalid-sensitive-map"
    | "plaintext-secret";
  message: string;
}

export interface McpValidationResult<T> {
  value?: T;
  errors: McpValidationError[];
}

function mcpError(path: string, code: McpValidationError["code"], message: string): McpValidationError {
  return { path, code, message };
}

function validateMcpStringArray(value: unknown, path: string): McpValidationResult<string[] | undefined> {
  if (value === undefined) return { value: undefined, errors: [] };
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return { errors: [mcpError(path, "invalid-args", "Expected an array of non-empty strings")] };
  }
  return { value: value.map((entry) => entry.trim()), errors: [] };
}

function validateMcpSensitiveMap(
  value: unknown,
  path: string,
): McpValidationResult<Record<string, McpSensitiveValue> | undefined> {
  if (value === undefined) return { value: undefined, errors: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { errors: [mcpError(path, "invalid-sensitive-map", "Expected an object whose values are secret references")] };
  }
  const out: Record<string, McpSensitiveValue> = {};
  const errors: McpValidationError[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) {
      errors.push(mcpError(`${path}.${key}`, "invalid-sensitive-map", "Sensitive field names must be non-empty"));
      continue;
    }
    if (typeof entry === "string") {
      errors.push(mcpError(`${path}.${key}`, "plaintext-secret", "Sensitive MCP values must be Fusion secret references, never plaintext strings"));
      continue;
    }
    if (!isMcpSecretRef(entry)) {
      errors.push(mcpError(`${path}.${key}`, "invalid-sensitive-map", "Sensitive MCP values must be { secretRef, scope } objects"));
      continue;
    }
    out[key.trim()] = { secretRef: entry.secretRef.trim(), scope: entry.scope };
  }
  return errors.length > 0 ? { errors } : { value: out, errors: [] };
}

export function validateMcpServerDefinitionDetailed(value: unknown, path = "server"): McpValidationResult<McpServerDefinition> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { errors: [mcpError(path, "invalid-shape", "MCP server definition must be an object")] };
  }
  const input = value as Record<string, unknown>;
  const errors: McpValidationError[] = [];
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    errors.push(mcpError(`${path}.name`, "invalid-name", "MCP server name is required"));
  }
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;

  if (input.transport === "stdio") {
    if (typeof input.command !== "string" || input.command.trim().length === 0) {
      errors.push(mcpError(`${path}.command`, "missing-command", "stdio MCP servers require a command"));
    }
    const args = validateMcpStringArray(input.args, `${path}.args`);
    const env = validateMcpSensitiveMap(input.env, `${path}.env`);
    errors.push(...args.errors, ...env.errors);
    if (errors.length > 0) return { errors };
    return {
      value: {
        name: (input.name as string).trim(),
        ...(enabled !== undefined ? { enabled } : {}),
        transport: "stdio",
        command: (input.command as string).trim(),
        ...(args.value ? { args: args.value } : {}),
        ...(env.value ? { env: env.value } : {}),
      },
      errors: [],
    };
  }

  if (input.transport === "sse" || input.transport === "streamable-http") {
    if (typeof input.url !== "string" || input.url.trim().length === 0) {
      errors.push(mcpError(`${path}.url`, "missing-url", `${input.transport} MCP servers require a url`));
    }
    const headers = validateMcpSensitiveMap(input.headers, `${path}.headers`);
    errors.push(...headers.errors);
    if (errors.length > 0) return { errors };
    return {
      value: {
        name: (input.name as string).trim(),
        ...(enabled !== undefined ? { enabled } : {}),
        transport: input.transport,
        url: (input.url as string).trim(),
        ...(headers.value ? { headers: headers.value } : {}),
      },
      errors: [],
    };
  }

  errors.push(mcpError(`${path}.transport`, "invalid-transport", "MCP transport must be stdio, sse, or streamable-http"));
  return { errors };
}

/** Returns a normalized MCP server definition, or undefined with rejection details available from validateMcpServerDefinitionDetailed. */
export function validateMcpServerDefinition(value: unknown): McpServerDefinition | undefined {
  return validateMcpServerDefinitionDetailed(value).value;
}

export function validateMcpServerDefinitionsDetailed(value: unknown, path = "servers"): McpValidationResult<McpServerDefinition[]> {
  if (!Array.isArray(value)) {
    return { errors: [mcpError(path, "invalid-shape", "MCP servers must be an array")] };
  }
  const errors: McpValidationError[] = [];
  const out: McpServerDefinition[] = [];
  const names = new Set<string>();
  value.forEach((entry, index) => {
    const result = validateMcpServerDefinitionDetailed(entry, `${path}.${index}`);
    errors.push(...result.errors);
    if (!result.value) return;
    if (names.has(result.value.name)) {
      errors.push(mcpError(`${path}.${index}.name`, "duplicate-name", `Duplicate MCP server name: ${result.value.name}`));
      return;
    }
    names.add(result.value.name);
    out.push(result.value);
  });
  return errors.length > 0 ? { errors } : { value: out, errors: [] };
}

/** Returns unique normalized MCP server definitions, otherwise undefined. */
export function validateMcpServerDefinitions(value: unknown): McpServerDefinition[] | undefined {
  return validateMcpServerDefinitionsDetailed(value).value;
}

export function validateMcpServersSettingsDetailed(value: unknown, path = "mcpServers"): McpValidationResult<McpServersSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { errors: [mcpError(path, "invalid-shape", "MCP settings must be an object")] };
  }
  const input = value as Record<string, unknown>;
  const servers = input.servers === undefined ? { value: [], errors: [] } : validateMcpServerDefinitionsDetailed(input.servers, `${path}.servers`);
  if (servers.errors.length > 0) return { errors: servers.errors };
  return {
    value: {
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
      servers: servers.value ?? [],
    },
    errors: [],
  };
}

/** Returns normalized MCP settings, otherwise undefined. */
export function validateMcpServersSettings(value: unknown): McpServersSettings | undefined {
  return validateMcpServersSettingsDetailed(value).value;
}

export type ShellHostKind = "browser" | "desktop-shell" | "mobile-shell";
export type ShellHostMode = "local" | "remote";

export type ShellHostContext =
  | { kind: "browser" }
  | {
      kind: "desktop-shell" | "mobile-shell";
      mode?: ShellHostMode;
      connectionId?: string;
      serverUrl?: string;
      canOpenConnectionManager?: boolean;
    };

export const SHELL_HOST_QUERY_KEYS = [
  "shellKind",
  "shellMode",
  "profileId",
  "serverBaseUrl",
  "serverLabel",
  "shellCanOpenConnectionManager",
  "hostKind",
  "mode",
  "connectionId",
  "serverUrl",
  "canOpenConnectionManager",
] as const;

const BOOTSTRAP_GLOBAL_KEYS = [
  "__FUSION_SHELL_HOST_CONTEXT__",
  "__fusionShellHostContext",
  "__FUSION_SHELL_CONTEXT__",
] as const;

let cachedContext: ShellHostContext | null = null;
let bootstrapped = false;

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function normalizeServerUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function normalizeKind(value: unknown): ShellHostKind | undefined {
  if (value === "browser" || value === "desktop-shell" || value === "mobile-shell") return value;
  if (value === "desktop") return "desktop-shell";
  if (value === "mobile") return "mobile-shell";
  return undefined;
}

function normalizeMode(value: unknown): ShellHostMode | undefined {
  return value === "local" || value === "remote" ? value : undefined;
}

function normalizeNativeHost(input: {
  kind: "desktop-shell" | "mobile-shell";
  mode?: unknown;
  connectionId?: unknown;
  serverUrl?: unknown;
  canOpenConnectionManager?: unknown;
}): ShellHostContext {
  const mode = normalizeMode(input.mode);
  const connectionId = typeof input.connectionId === "string" && input.connectionId.trim() ? input.connectionId : undefined;
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const canOpenConnectionManager = parseBoolean(input.canOpenConnectionManager);

  return {
    kind: input.kind,
    ...(mode ? { mode } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    ...(canOpenConnectionManager !== undefined ? { canOpenConnectionManager } : {}),
  };
}

function fromBootstrapGlobal(target: Window): ShellHostContext | null {
  for (const key of BOOTSTRAP_GLOBAL_KEYS) {
    const raw = (target as Window & Record<string, unknown>)[key];
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const kind = normalizeKind(record.kind ?? record.shellKind ?? record.hostKind);
    if (!kind) continue;
    if (kind === "browser") return { kind };
    return normalizeNativeHost({
      kind,
      mode: record.mode ?? record.shellMode,
      connectionId: record.connectionId ?? record.profileId,
      serverUrl: record.serverUrl ?? record.serverBaseUrl,
      canOpenConnectionManager: record.canOpenConnectionManager ?? record.shellCanOpenConnectionManager,
    });
  }
  return null;
}

function fromQuery(target: Window): ShellHostContext | null {
  let url: URL;
  try {
    url = new URL(target.location.href);
  } catch {
    return null;
  }
  const params = url.searchParams;
  const kind = normalizeKind(params.get("hostKind") ?? params.get("kind") ?? params.get("shellKind"));
  if (!kind) return null;
  if (kind === "browser") return { kind };
  return normalizeNativeHost({
    kind,
    mode: params.get("mode") ?? params.get("shellMode"),
    connectionId: params.get("connectionId") ?? params.get("profileId"),
    serverUrl: params.get("serverUrl") ?? params.get("serverBaseUrl"),
    canOpenConnectionManager: params.get("canOpenConnectionManager") ?? params.get("shellCanOpenConnectionManager"),
  });
}

function stripShellQueryParams(target: Window): void {
  try {
    const url = new URL(target.location.href);
    let changed = false;
    for (const key of SHELL_HOST_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    const cleaned = url.pathname + (url.search ? url.search : "") + url.hash;
    target.history.replaceState(target.history.state, "", cleaned);
  } catch {
    // no-op
  }
}

export function detectShellHostContext(target: Window = window): ShellHostContext {
  const globalContext = fromBootstrapGlobal(target);
  if (globalContext) return globalContext;

  const queryContext = fromQuery(target);
  if (queryContext) return queryContext;

  if (typeof (target as Window & { fusionAPI?: unknown }).fusionAPI !== "undefined") {
    return { kind: "desktop-shell" };
  }

  return { kind: "browser" };
}

export function bootstrapShellHostContext(target: Window = window): ShellHostContext {
  if (!bootstrapped && typeof window !== "undefined") {
    cachedContext = detectShellHostContext(target);
    stripShellQueryParams(target);
    bootstrapped = true;
  }
  return cachedContext ?? { kind: "browser" };
}

export function getShellHostContext(): ShellHostContext {
  if (cachedContext) return cachedContext;
  if (typeof window === "undefined") return { kind: "browser" };
  return bootstrapShellHostContext(window);
}

export function __resetShellHostContextForTests(): void {
  cachedContext = null;
  bootstrapped = false;
}

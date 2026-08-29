import { URL_TOKEN_PARAM } from "./auth";

export type ShellKind = "desktop" | "mobile";
export type ShellMode = "local" | "remote";

export interface ShellCapabilities {
  canOpenConnectionManager: boolean;
}

export interface ShellContext {
  shellKind: ShellKind;
  shellMode: ShellMode;
  profileId?: string;
  serverBaseUrl?: string;
  serverLabel?: string;
  capabilities: ShellCapabilities;
}

export interface RemoteShellLaunch {
  shellKind: ShellKind;
  shellMode: "remote";
  profileId: string;
  serverBaseUrl: string;
  serverLabel?: string;
  token?: string;
  capabilities?: Partial<ShellCapabilities>;
}

export const SHELL_KIND_PARAM = "shellKind";
export const SHELL_MODE_PARAM = "shellMode";
export const SHELL_PROFILE_ID_PARAM = "profileId";
export const SHELL_SERVER_BASE_URL_PARAM = "serverBaseUrl";
export const SHELL_SERVER_LABEL_PARAM = "serverLabel";
export const SHELL_CAN_OPEN_CONNECTION_MANAGER_PARAM = "shellCanOpenConnectionManager";
export const SHELL_TOKEN_PARAM = URL_TOKEN_PARAM;

const DEFAULT_CAPABILITIES: ShellCapabilities = {
  canOpenConnectionManager: false,
};

function isShellKind(value: string | null): value is ShellKind {
  return value === "desktop" || value === "mobile";
}

function isShellMode(value: string | null): value is ShellMode {
  return value === "local" || value === "remote";
}

function normalizeServerBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseBooleanParam(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function parseShellContextFromUrl(url: string): ShellContext | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  } catch {
    return null;
  }

  const shellKind = parsedUrl.searchParams.get(SHELL_KIND_PARAM);
  const shellMode = parsedUrl.searchParams.get(SHELL_MODE_PARAM);

  if (!isShellKind(shellKind) || !isShellMode(shellMode)) {
    return null;
  }

  const capabilities: ShellCapabilities = {
    canOpenConnectionManager: parseBooleanParam(parsedUrl.searchParams.get(SHELL_CAN_OPEN_CONNECTION_MANAGER_PARAM)),
  };

  if (shellMode === "local") {
    return {
      shellKind,
      shellMode,
      capabilities,
    };
  }

  const profileId = parsedUrl.searchParams.get(SHELL_PROFILE_ID_PARAM);
  const serverBaseUrlRaw = parsedUrl.searchParams.get(SHELL_SERVER_BASE_URL_PARAM);
  const serverBaseUrl = serverBaseUrlRaw ? normalizeServerBaseUrl(serverBaseUrlRaw) : null;

  if (!profileId || !serverBaseUrl) {
    return null;
  }

  const serverLabel = parsedUrl.searchParams.get(SHELL_SERVER_LABEL_PARAM) ?? undefined;

  return {
    shellKind,
    shellMode,
    profileId,
    serverBaseUrl,
    ...(serverLabel ? { serverLabel } : {}),
    capabilities,
  };
}

export function parseRemoteShellLaunchFromUrl(url: string): RemoteShellLaunch | null {
  const parsed = parseShellContextFromUrl(url);
  if (!parsed || parsed.shellMode !== "remote" || !parsed.profileId || !parsed.serverBaseUrl) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  } catch {
    return null;
  }

  const token = parsedUrl.searchParams.get(SHELL_TOKEN_PARAM) ?? undefined;

  return {
    shellKind: parsed.shellKind,
    shellMode: "remote",
    profileId: parsed.profileId,
    serverBaseUrl: parsed.serverBaseUrl,
    ...(parsed.serverLabel ? { serverLabel: parsed.serverLabel } : {}),
    ...(token ? { token } : {}),
    capabilities: parsed.capabilities,
  };
}

export function buildRemoteShellLaunchUrl(launch: RemoteShellLaunch): string {
  const normalizedBaseUrl = normalizeServerBaseUrl(launch.serverBaseUrl);
  if (!normalizedBaseUrl) {
    throw new Error("Invalid serverBaseUrl");
  }

  if (!launch.profileId.trim()) {
    throw new Error("profileId is required");
  }

  const url = new URL(normalizedBaseUrl);
  url.searchParams.set(SHELL_KIND_PARAM, launch.shellKind);
  url.searchParams.set(SHELL_MODE_PARAM, "remote");
  url.searchParams.set(SHELL_PROFILE_ID_PARAM, launch.profileId);
  url.searchParams.set(SHELL_SERVER_BASE_URL_PARAM, normalizedBaseUrl);
  if (launch.serverLabel) {
    url.searchParams.set(SHELL_SERVER_LABEL_PARAM, launch.serverLabel);
  }
  if (launch.token) {
    url.searchParams.set(SHELL_TOKEN_PARAM, launch.token);
  }

  const capabilities = { ...DEFAULT_CAPABILITIES, ...launch.capabilities };
  if (capabilities.canOpenConnectionManager) {
    url.searchParams.set(SHELL_CAN_OPEN_CONNECTION_MANAGER_PARAM, "1");
  }

  return url.toString();
}

import type {
  MobileRemoteShellLaunch,
  ShellConnectionProfile,
  ShellConnectionState,
  MobileShellHandoffResult,
} from "../types.js";

export const SHELL_HANDOFF_QUERY = {
  shellKind: "shellKind",
  shellMode: "shellMode",
  profileId: "profileId",
  serverBaseUrl: "serverBaseUrl",
  serverLabel: "serverLabel",
  token: "token",
  canOpenConnectionManager: "shellCanOpenConnectionManager",
} as const;

function normalizeServerBaseUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function findActiveProfile(state: ShellConnectionState): ShellConnectionProfile | null {
  if (!state.activeProfileId) {
    return null;
  }
  return state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
}

export function buildMobileShellHandoff(state: ShellConnectionState): MobileShellHandoffResult {
  const activeProfile = findActiveProfile(state);
  if (!state.activeProfileId) {
    return { kind: "fallback", reason: "no-active-profile" };
  }
  if (!activeProfile) {
    return { kind: "fallback", reason: "missing-profile" };
  }

  const serverBaseUrl = normalizeServerBaseUrl(activeProfile.serverUrl);
  if (!serverBaseUrl) {
    return { kind: "fallback", reason: "invalid-server-url" };
  }

  const launch: MobileRemoteShellLaunch = {
    shellKind: "mobile",
    shellMode: "remote",
    profileId: activeProfile.id,
    serverBaseUrl,
    ...(activeProfile.name ? { serverLabel: activeProfile.name } : {}),
    ...(activeProfile.authToken ? { token: activeProfile.authToken } : {}),
  };

  const url = new URL(serverBaseUrl);
  url.searchParams.set(SHELL_HANDOFF_QUERY.shellKind, launch.shellKind);
  url.searchParams.set(SHELL_HANDOFF_QUERY.shellMode, launch.shellMode);
  url.searchParams.set(SHELL_HANDOFF_QUERY.profileId, launch.profileId);
  url.searchParams.set(SHELL_HANDOFF_QUERY.serverBaseUrl, launch.serverBaseUrl);
  if (launch.serverLabel) {
    url.searchParams.set(SHELL_HANDOFF_QUERY.serverLabel, launch.serverLabel);
  }
  if (launch.token) {
    url.searchParams.set(SHELL_HANDOFF_QUERY.token, launch.token);
  }
  url.searchParams.set(SHELL_HANDOFF_QUERY.canOpenConnectionManager, "1");

  return { kind: "remote-launch", launch, url: url.toString() };
}

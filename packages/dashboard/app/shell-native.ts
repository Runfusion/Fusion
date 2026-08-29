import type { ShellHostContext } from "./shell-host";
import type { FusionShellApi, ShellConnectionProfile, ShellConnectionState } from "./types/native-shell";

export interface ShellConnectionNativeResult {
  hostKind: ShellHostContext["kind"];
  available: boolean;
  mode?: "local" | "remote";
  profileId?: string;
  profileLabel?: string;
  serverOrigin?: string;
  openConnectionManager: () => Promise<{ ok: true } | { ok: false; reason: "unsupported" | "failed"; error?: string }>;
}

type FusionApiBridge = {
  openConnectionManager?: () => Promise<void>;
};

function toOrigin(serverUrl?: string): string | undefined {
  if (!serverUrl) return undefined;
  try {
    return new URL(serverUrl).origin;
  } catch {
    return undefined;
  }
}

function resolveProfile(
  state: Pick<ShellConnectionState, "activeProfileId" | "profiles">,
  host: ShellHostContext,
): ShellConnectionProfile | null {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
  if (active) return active;
  if (host.kind === "browser" || !host.connectionId) return null;
  return state.profiles.find((profile) => profile.id === host.connectionId) ?? null;
}

async function readShellState(shellApi?: Pick<FusionShellApi, "getState">): Promise<ShellConnectionState | null> {
  if (!shellApi?.getState) return null;
  try {
    return await shellApi.getState();
  } catch {
    return null;
  }
}

export async function getShellConnectionNativeResult(
  host: ShellHostContext,
  target: Window & typeof globalThis = window,
): Promise<ShellConnectionNativeResult> {
  const fusionApi = (target as Window & { fusionAPI?: FusionApiBridge }).fusionAPI;
  const shellApi = (target as Window & { fusionShell?: FusionShellApi }).fusionShell;
  const shellState = await readShellState(shellApi);

  const profile = shellState ? resolveProfile(shellState, host) : null;
  const mode = host.kind === "browser" ? undefined : host.mode ?? shellState?.desktopMode;
  const profileId = profile?.id ?? (host.kind === "browser" ? undefined : host.connectionId);
  const profileLabel = profile?.name;
  const serverOrigin = toOrigin(profile?.serverUrl ?? (host.kind === "browser" ? undefined : host.serverUrl));

  const desktopSupported = host.kind === "desktop-shell" && typeof fusionApi?.openConnectionManager === "function";
  const mobileSupported = host.kind === "mobile-shell" && typeof shellApi?.openConnectionManager === "function";
  const available = desktopSupported || mobileSupported;

  return {
    hostKind: host.kind,
    available,
    ...(mode ? { mode } : {}),
    ...(profileId ? { profileId } : {}),
    ...(profileLabel ? { profileLabel } : {}),
    ...(serverOrigin ? { serverOrigin } : {}),
    openConnectionManager: async () => {
      try {
        if (desktopSupported) {
          await fusionApi.openConnectionManager?.();
          return { ok: true };
        }
        if (mobileSupported) {
          await shellApi.openConnectionManager();
          return { ok: true };
        }
        return { ok: false, reason: "unsupported" };
      } catch (error) {
        return {
          ok: false,
          reason: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

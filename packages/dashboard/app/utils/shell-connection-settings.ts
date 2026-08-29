import type {
  FusionShellApi,
  ShellConnectionProfile,
  ShellConnectionProfileInput,
  ShellConnectionState,
} from "../types/native-shell";

export const DEFAULT_WEB_SHELL_STATE: ShellConnectionState = {
  host: "web",
  activeProfileId: null,
  profiles: [],
};

export function normalizeShellState(state: ShellConnectionState | null | undefined): ShellConnectionState {
  if (!state) {
    return DEFAULT_WEB_SHELL_STATE;
  }

  const profiles = Array.isArray(state.profiles)
    ? state.profiles.filter((profile): profile is ShellConnectionProfile => Boolean(profile && profile.id && profile.serverUrl))
    : [];

  const activeProfileId =
    state.activeProfileId && profiles.some((profile) => profile.id === state.activeProfileId)
      ? state.activeProfileId
      : null;

  return {
    ...state,
    activeProfileId,
    profiles,
  };
}

function unsupportedError(action: string): Error {
  return new Error(`${action} is only available in native shell mode`);
}

export async function createOrUpdateProfile(
  shellApi: FusionShellApi | null,
  profile: ShellConnectionProfileInput,
): Promise<ShellConnectionProfile> {
  if (!shellApi) {
    throw unsupportedError("Saving connection profiles");
  }
  return shellApi.saveProfile(profile);
}

export async function deleteProfile(shellApi: FusionShellApi | null, profileId: string): Promise<void> {
  if (!shellApi) {
    throw unsupportedError("Deleting connection profiles");
  }
  await shellApi.deleteProfile(profileId);
}

export async function selectActiveProfile(
  shellApi: FusionShellApi | null,
  profileId: string | null,
): Promise<ShellConnectionState> {
  if (!shellApi) {
    throw unsupportedError("Switching connection profiles");
  }
  return shellApi.setActiveProfile(profileId);
}

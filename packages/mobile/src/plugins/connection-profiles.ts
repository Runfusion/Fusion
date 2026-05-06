import { Preferences } from "@capacitor/preferences";
import type { ShellConnectionProfile, ShellConnectionProfileInput } from "../types.js";

const STORAGE_KEY = "fusion.shell.connections.v1";

interface PersistedShellState {
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(): string {
  return `profile_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Server URL must be a valid absolute URL");
  }
  if (!parsed.protocol || !/^https?:$/.test(parsed.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  return normalized;
}

function toPersisted(input: unknown): PersistedShellState {
  if (!input || typeof input !== "object") {
    return { activeProfileId: null, profiles: [] };
  }

  const candidate = input as Partial<PersistedShellState>;
  const profiles = Array.isArray(candidate.profiles) ? candidate.profiles.filter((profile) => profile && typeof profile === "object") as ShellConnectionProfile[] : [];
  return {
    activeProfileId: typeof candidate.activeProfileId === "string" ? candidate.activeProfileId : null,
    profiles,
  };
}

export async function loadShellProfiles(): Promise<PersistedShellState> {
  const { value } = await Preferences.get({ key: STORAGE_KEY });
  if (!value) {
    return { activeProfileId: null, profiles: [] };
  }

  try {
    return toPersisted(JSON.parse(value));
  } catch {
    return { activeProfileId: null, profiles: [] };
  }
}

async function saveShellState(state: PersistedShellState): Promise<void> {
  await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(state) });
}

export async function listShellProfiles(): Promise<ShellConnectionProfile[]> {
  const state = await loadShellProfiles();
  return state.profiles;
}

export async function saveShellProfile(input: ShellConnectionProfileInput): Promise<ShellConnectionProfile> {
  const state = await loadShellProfiles();
  const existing = input.id ? state.profiles.find((p) => p.id === input.id) : undefined;
  const timestamp = nowIso();

  const profile: ShellConnectionProfile = {
    id: existing?.id ?? input.id ?? createId(),
    name: input.name.trim(),
    serverUrl: normalizeUrl(input.serverUrl),
    authToken: input.authToken ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };

  const profiles = existing
    ? state.profiles.map((item) => (item.id === existing.id ? profile : item))
    : [...state.profiles, profile];

  await saveShellState({ ...state, profiles });
  return profile;
}

export async function deleteShellProfile(profileId: string): Promise<void> {
  const state = await loadShellProfiles();
  const profiles = state.profiles.filter((profile) => profile.id !== profileId);
  const activeProfileId = state.activeProfileId === profileId ? null : state.activeProfileId;
  await saveShellState({ activeProfileId, profiles });
}

export async function setActiveShellProfile(profileId: string | null): Promise<PersistedShellState> {
  const state = await loadShellProfiles();
  const activeProfileId =
    profileId && state.profiles.some((profile) => profile.id === profileId)
      ? profileId
      : null;

  const profiles = state.profiles.map((profile) =>
    profile.id === activeProfileId
      ? { ...profile, lastUsedAt: nowIso(), updatedAt: nowIso() }
      : profile,
  );

  const next = { activeProfileId, profiles };
  await saveShellState(next);
  return next;
}

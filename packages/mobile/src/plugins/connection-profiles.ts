import { createHash } from "node:crypto";
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

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "Remote Server";
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

function deterministicBaseId(name: string, serverUrl: string): string {
  const hash = createHash("sha1").update(`${name}|${serverUrl}`).digest("hex").slice(0, 10);
  return `profile_${hash}`;
}

function ensureUniqueName(name: string, profiles: ShellConnectionProfile[], skipId?: string): string {
  const used = new Set(profiles.filter((profile) => profile.id !== skipId).map((profile) => profile.name.toLocaleLowerCase()));
  if (!used.has(name.toLocaleLowerCase())) {
    return name;
  }
  let suffix = 2;
  let candidate = `${name} (${suffix})`;
  while (used.has(candidate.toLocaleLowerCase())) {
    suffix += 1;
    candidate = `${name} (${suffix})`;
  }
  return candidate;
}

function ensureUniqueId(name: string, serverUrl: string, profiles: ShellConnectionProfile[], skipId?: string): string {
  const base = deterministicBaseId(name, serverUrl);
  const used = new Set(profiles.filter((profile) => profile.id !== skipId).map((profile) => profile.id));
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  let candidate = `${base}_${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

function normalizePersistedProfile(input: unknown, index: number): ShellConnectionProfile | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<ShellConnectionProfile>;
  if (typeof candidate.serverUrl !== "string") {
    return null;
  }

  let serverUrl: string;
  try {
    serverUrl = normalizeUrl(candidate.serverUrl);
  } catch {
    return null;
  }

  const name = normalizeName(typeof candidate.name === "string" ? candidate.name : "");
  const createdAt = typeof candidate.createdAt === "string" && candidate.createdAt.length > 0 ? candidate.createdAt : nowIso();
  const updatedAt = typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0 ? candidate.updatedAt : createdAt;

  return {
    id: typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : `profile_imported_${index}`,
    name,
    serverUrl,
    authToken: typeof candidate.authToken === "string" ? candidate.authToken : null,
    createdAt,
    updatedAt,
    lastUsedAt: typeof candidate.lastUsedAt === "string" ? candidate.lastUsedAt : null,
  };
}

function toPersisted(input: unknown): PersistedShellState {
  if (!input || typeof input !== "object") {
    return { activeProfileId: null, profiles: [] };
  }

  const candidate = input as Partial<PersistedShellState>;
  const source = Array.isArray(candidate.profiles) ? candidate.profiles : [];
  const profiles: ShellConnectionProfile[] = [];
  for (const [index, value] of source.entries()) {
    const normalized = normalizePersistedProfile(value, index);
    if (!normalized) {
      continue;
    }
    const uniqueName = ensureUniqueName(normalized.name, profiles);
    const idAlreadyUsed = profiles.some((profile) => profile.id === normalized.id);
    const id = idAlreadyUsed ? ensureUniqueId(uniqueName, normalized.serverUrl, profiles) : normalized.id;
    profiles.push({ ...normalized, name: uniqueName, id });
  }

  const activeProfileId =
    typeof candidate.activeProfileId === "string" && profiles.some((profile) => profile.id === candidate.activeProfileId)
      ? candidate.activeProfileId
      : null;

  return {
    activeProfileId,
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
  const serverUrl = normalizeUrl(input.serverUrl);
  const normalizedName = normalizeName(input.name);
  const name = ensureUniqueName(normalizedName, state.profiles, existing?.id);

  const profile: ShellConnectionProfile = {
    id: existing?.id ?? ensureUniqueId(name, serverUrl, state.profiles, existing?.id),
    name,
    serverUrl,
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
  const activeProfileId =
    state.activeProfileId !== profileId
      ? state.activeProfileId
      : profiles.length > 0
        ? profiles[0]?.id ?? null
        : null;
  await saveShellState({ activeProfileId, profiles });
}

export async function setActiveShellProfile(profileId: string | null): Promise<PersistedShellState> {
  const state = await loadShellProfiles();
  const activeProfileId =
    profileId && state.profiles.some((profile) => profile.id === profileId)
      ? profileId
      : null;

  const timestamp = nowIso();
  const profiles = state.profiles.map((profile) =>
    profile.id === activeProfileId
      ? { ...profile, lastUsedAt: timestamp, updatedAt: timestamp }
      : profile,
  );

  const next = { activeProfileId, profiles };
  await saveShellState(next);
  return next;
}

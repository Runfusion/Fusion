import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";

export interface ShellConnectionProfile {
  id: string;
  name: string;
  serverUrl: string;
  authToken?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export type DesktopShellMode = "local" | "remote";

export interface DesktopShellModeState {
  isFirstRun: boolean;
  desktopMode: DesktopShellMode | null;
}

export interface DesktopShellSettings {
  desktopMode: DesktopShellMode | null;
  hasCompletedModeSelection: boolean;
  activeProfileId: string | null;
  profiles: ShellConnectionProfile[];
}

const DEFAULT_SETTINGS: DesktopShellSettings = {
  desktopMode: null,
  hasCompletedModeSelection: false,
  activeProfileId: null,
  profiles: [],
};

function getSettingsPath(): string {
  return join(app.getPath("userData"), "shell-connections.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDesktopMode(value: unknown): DesktopShellMode | null {
  return value === "local" || value === "remote" ? value : null;
}

function normalizeServerUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Server URL must be a valid absolute URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  return normalized;
}

function normalizeProfileName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "Remote Server";
}

function profileBaseId(name: string, serverUrl: string): string {
  const hash = createHash("sha1").update(`${name}|${serverUrl}`).digest("hex").slice(0, 10);
  return `profile_${hash}`;
}

function ensureUniqueProfileName(name: string, profiles: ShellConnectionProfile[], skipId?: string): string {
  const used = new Set(
    profiles.filter((profile) => profile.id !== skipId).map((profile) => profile.name.toLocaleLowerCase()),
  );
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

function createDeterministicProfileId(name: string, serverUrl: string, profiles: ShellConnectionProfile[], skipId?: string): string {
  const used = new Set(profiles.filter((profile) => profile.id !== skipId).map((profile) => profile.id));
  const base = profileBaseId(name, serverUrl);
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

function normalizeProfileRecord(input: unknown, fallbackIndex: number): ShellConnectionProfile | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<ShellConnectionProfile>;
  if (typeof candidate.serverUrl !== "string") {
    return null;
  }

  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(candidate.serverUrl);
  } catch {
    return null;
  }

  const name = normalizeProfileName(typeof candidate.name === "string" ? candidate.name : "");
  const createdAt = typeof candidate.createdAt === "string" && candidate.createdAt.length > 0 ? candidate.createdAt : nowIso();
  const updatedAt = typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0 ? candidate.updatedAt : createdAt;
  return {
    id: typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : `profile_imported_${fallbackIndex}`,
    name,
    serverUrl,
    authToken: typeof candidate.authToken === "string" ? candidate.authToken : null,
    createdAt,
    updatedAt,
    lastUsedAt: typeof candidate.lastUsedAt === "string" ? candidate.lastUsedAt : null,
  };
}

function normalize(input: unknown): DesktopShellSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS };
  }

  const candidate = input as Partial<DesktopShellSettings>;
  const desktopMode = normalizeDesktopMode(candidate.desktopMode);
  const inferredCompleted = desktopMode !== null;

  const profiles: ShellConnectionProfile[] = [];
  const profileSource = Array.isArray(candidate.profiles) ? candidate.profiles : [];
  for (const [index, profileValue] of profileSource.entries()) {
    const normalizedProfile = normalizeProfileRecord(profileValue, index);
    if (!normalizedProfile) {
      continue;
    }
    const uniqueName = ensureUniqueProfileName(normalizedProfile.name, profiles);
    const idAlreadyUsed = profiles.some((profile) => profile.id === normalizedProfile.id);
    const id = idAlreadyUsed
      ? createDeterministicProfileId(uniqueName, normalizedProfile.serverUrl, profiles)
      : normalizedProfile.id;
    profiles.push({ ...normalizedProfile, name: uniqueName, id });
  }

  const persistedActiveId = typeof candidate.activeProfileId === "string" ? candidate.activeProfileId : null;
  const activeProfileId = persistedActiveId && profiles.some((profile) => profile.id === persistedActiveId)
    ? persistedActiveId
    : null;

  return {
    desktopMode,
    hasCompletedModeSelection: typeof candidate.hasCompletedModeSelection === "boolean" ? candidate.hasCompletedModeSelection : inferredCompleted,
    activeProfileId,
    profiles,
  };
}

export function buildSavedProfile(
  settings: DesktopShellSettings,
  input: { id?: string; name: string; serverUrl: string; authToken?: string | null },
): ShellConnectionProfile {
  const existing = input.id ? settings.profiles.find((item) => item.id === input.id) : undefined;
  const normalizedServerUrl = normalizeServerUrl(input.serverUrl);
  const normalizedName = normalizeProfileName(input.name);
  const name = ensureUniqueProfileName(normalizedName, settings.profiles, existing?.id);
  const timestamp = nowIso();

  return {
    id: existing?.id ?? createDeterministicProfileId(name, normalizedServerUrl, settings.profiles, existing?.id),
    name,
    serverUrl: normalizedServerUrl,
    authToken: input.authToken ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };
}

export function applyDeleteProfile(settings: DesktopShellSettings, profileId: string): DesktopShellSettings {
  const profiles = settings.profiles.filter((item) => item.id !== profileId);
  const activeProfileId =
    settings.activeProfileId !== profileId
      ? settings.activeProfileId
      : profiles.length > 0
        ? profiles[0]?.id ?? null
        : null;
  return { ...settings, profiles, activeProfileId };
}

export function applySetActiveProfile(settings: DesktopShellSettings, profileId: string | null): DesktopShellSettings {
  const activeProfileId = profileId && settings.profiles.some((item) => item.id === profileId) ? profileId : null;
  const timestamp = nowIso();
  const profiles = settings.profiles.map((item) =>
    item.id === activeProfileId
      ? { ...item, lastUsedAt: timestamp, updatedAt: timestamp }
      : item,
  );

  return {
    ...settings,
    activeProfileId,
    profiles,
  };
}

export async function readShellSettings(): Promise<DesktopShellSettings> {
  try {
    const raw = await readFile(getSettingsPath(), "utf-8");
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getDesktopShellModeState(settings: DesktopShellSettings): DesktopShellModeState {
  if (!settings.hasCompletedModeSelection || settings.desktopMode === null) {
    return {
      isFirstRun: true,
      desktopMode: null,
    };
  }

  return {
    isFirstRun: false,
    desktopMode: settings.desktopMode,
  };
}

export async function writeShellSettings(settings: DesktopShellSettings): Promise<void> {
  const path = getSettingsPath();
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), "utf-8");
  await rename(temp, path);
}

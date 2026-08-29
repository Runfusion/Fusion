import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createDevServerId,
  type DevServerConfig,
  type DevServerSession,
} from "./devserver-types.js";

interface PersistenceData {
  configs: DevServerConfig[];
}

export function projectDevServerFile(projectDir: string): string {
  return join(resolve(projectDir), ".fusion", "devserver.json");
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const parsed: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "string") {
      parsed[key] = candidate;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseConfig(candidate: unknown): DevServerConfig | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const value = candidate as Record<string, unknown>;
  if (typeof value.id !== "string") {
    return null;
  }
  if (typeof value.name !== "string" || typeof value.command !== "string" || typeof value.cwd !== "string") {
    return null;
  }

  return {
    id: createDevServerId(value.id),
    name: value.name,
    command: value.command,
    cwd: value.cwd,
    env: parseEnv(value.env),
    autoStart: typeof value.autoStart === "boolean" ? value.autoStart : undefined,
  };
}

export async function loadDevServerConfigs(projectDir: string): Promise<DevServerConfig[]> {
  const filePath = projectDevServerFile(projectDir);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistenceData>;
    if (!Array.isArray(parsed.configs)) {
      return [];
    }

    return parsed.configs
      .map((config) => parseConfig(config))
      .filter((config): config is DevServerConfig => config !== null);
  } catch {
    return [];
  }
}

export async function saveDevServerConfigs(projectDir: string, configs: DevServerConfig[]): Promise<void> {
  const filePath = projectDevServerFile(projectDir);
  const folder = dirname(filePath);

  try {
    await mkdir(folder, { recursive: true });
    const payload: PersistenceData = { configs };
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Graceful no-op: callers can continue operating with in-memory state.
  }
}

export function reconstructSessions(configs: DevServerConfig[]): Map<string, DevServerSession> {
  const sessions = new Map<string, DevServerSession>();

  for (const config of configs) {
    sessions.set(config.id, {
      config,
      status: "stopped",
      logHistory: [],
    });
  }

  return sessions;
}

export type { PersistenceData };

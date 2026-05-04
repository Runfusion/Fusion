import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LLAMA_SERVER_URL, PROVIDER_ID } from "./constants.js";

type AuthFile = Record<string, { type?: string; key?: string } | undefined>;

let cachedUrl: string | null = null;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function resolveLlamaServerUrl(cwd: string): Promise<string> {
  if (cachedUrl) return cachedUrl;

  const projectCfg = await readJson<{ url?: string }>(
    join(cwd, ".pi", "llama-server.json"),
  );
  if (projectCfg?.url) {
    cachedUrl = normalizeUrl(projectCfg.url);
    return cachedUrl;
  }

  const envUrl = process.env.LLAMA_SERVER_URL;
  if (envUrl) {
    cachedUrl = normalizeUrl(envUrl);
    return cachedUrl;
  }

  const globalCfg = await readJson<{ llamaServerUrl?: string }>(
    join(process.env.HOME ?? ".", ".pi", "agent", "settings.json"),
  );
  if (globalCfg?.llamaServerUrl) {
    cachedUrl = normalizeUrl(globalCfg.llamaServerUrl);
    return cachedUrl;
  }

  cachedUrl = DEFAULT_LLAMA_SERVER_URL;
  return cachedUrl;
}

export async function resolveLlamaServerApiKey(): Promise<string | undefined> {
  const authCfg = await readJson<AuthFile>(
    join(process.env.HOME ?? ".", ".pi", "agent", "auth.json"),
  );
  const auth = authCfg?.[PROVIDER_ID];
  const key = typeof auth?.key === "string" ? auth.key.trim() : "";
  return key.length > 0 ? key : undefined;
}

export function resetLlamaResolverCache(): void {
  cachedUrl = null;
}

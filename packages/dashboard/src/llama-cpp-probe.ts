import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";

type LlamaProjectConfig = { url?: string };
type LlamaGlobalConfig = { llamaServerUrl?: string };
type LlamaAuthConfig = Record<string, { key?: string } | undefined>;

export interface LlamaCppProbeStatus {
  reachable: boolean;
  url: string;
  hasApiKey: boolean;
  reason?: string;
}

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

async function resolveLlamaServerUrl(cwd: string): Promise<string> {
  const projectCfg = await readJson<LlamaProjectConfig>(join(cwd, ".pi", "llama-server.json"));
  if (projectCfg?.url) return normalizeUrl(projectCfg.url);

  const envUrl = process.env.LLAMA_SERVER_URL;
  if (envUrl) return normalizeUrl(envUrl);

  const globalCfg = await readJson<LlamaGlobalConfig>(
    join(process.env.HOME ?? ".", ".pi", "agent", "settings.json"),
  );
  if (globalCfg?.llamaServerUrl) return normalizeUrl(globalCfg.llamaServerUrl);

  return DEFAULT_LLAMA_SERVER_URL;
}

async function resolveLlamaServerApiKey(): Promise<string | undefined> {
  const authCfg = await readJson<LlamaAuthConfig>(join(process.env.HOME ?? ".", ".pi", "agent", "auth.json"));
  const key = authCfg?.["llama-server"]?.key?.trim();
  return key ? key : undefined;
}

async function isLlamaServerReady(url: string, apiKey?: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { status?: string };
    return payload.status === "ok";
  } catch {
    return false;
  }
}

export async function probeLlamaCpp(options: { cwd?: string } = {}): Promise<LlamaCppProbeStatus> {
  const cwd = options.cwd ?? process.cwd();
  const url = await resolveLlamaServerUrl(cwd);
  const apiKey = await resolveLlamaServerApiKey();
  const reachable = await isLlamaServerReady(url, apiKey);

  return {
    reachable,
    url,
    hasApiKey: Boolean(apiKey),
    reason: reachable ? undefined : "llama.cpp server did not return a healthy response",
  };
}

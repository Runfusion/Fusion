import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "./resolver.js";

export type LlamaModel = {
  id: string;
  object?: string;
  owned_by?: string;
};

export type LlamaProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export async function llamaRpc<T>(endpoint: string, cwd = process.cwd()): Promise<T> {
  const url = `${await resolveLlamaServerUrl(cwd)}${endpoint}`;
  const apiKey = await resolveLlamaServerApiKey();
  const response = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function isLlamaServerReady(cwd = process.cwd()): Promise<boolean> {
  try {
    const status = await llamaRpc<{ status?: string }>("/health", cwd);
    return status.status === "ok";
  } catch {
    return false;
  }
}

export async function listLlamaModels(cwd = process.cwd()): Promise<LlamaModel[]> {
  const response = await llamaRpc<{ data?: LlamaModel[]; models?: unknown }>("/models", cwd);
  return Array.isArray(response.data) ? response.data : [];
}

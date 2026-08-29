import { runOmpCommand } from "./cli-spawn.js";

/*
FNXC:OmpAcp 2026-07-11-23:35:
Model discovery for the omp-cli provider card. Prefer a structured list when
available; fall soft to an empty list with a clear reason so the picker stays
usable without inventing model ids.

FNXC:OmpAcp 2026-07-18-16:40:
Bare table ids like MiniMax-M2.5 are ambiguous across omp providers
(minimax-code vs alibaba-coding-plan). Prefer `omp models --json` `selector`
fields (`minimax-code/MiniMax-M2.5`) so ACP `--model` hits the authenticated
provider instead of failing with "No API key found for alibaba-coding-plan" /
JSON-RPC Internal error.
*/

export interface OmpModelDiscoveryResult {
  models: string[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

/**
 * Attempt to list models from the local omp install.
 * Prefers `omp models --json` selectors, then text table, then empty.
 */
export async function discoverOmpModels(
  binary: string,
  timeoutMs = 8000,
): Promise<OmpModelDiscoveryResult> {
  const jsonResult = await runOmpCommand(binary, ["models", "--json"], timeoutMs);
  if (jsonResult.code === 0) {
    const models = parseModelListJson(jsonResult.stdout || jsonResult.stderr);
    if (models.length > 0) {
      return { models, source: "omp models --json", fallbackUsed: false };
    }
  }

  const result = await runOmpCommand(binary, ["models"], timeoutMs);
  if (result.code === 0) {
    const models = parseModelList(result.stdout || result.stderr);
    if (models.length > 0) {
      return { models, source: "omp models", fallbackUsed: false };
    }
  }

  // Some installs may only expose models via help text; do not invent ids.
  return {
    models: [],
    source: "probe",
    fallbackUsed: true,
    reason:
      result.code === 0
        ? "omp models returned no parseable model ids"
        : `omp models failed (code ${result.code ?? "null"})`,
  };
}

/**
 * FNXC:OmpAcp 2026-07-18-16:40:
 * Map a bare or omp-cli-prefixed model id to a unique provider-qualified selector
 * from discovery (e.g. MiniMax-M2.5 → minimax-code/MiniMax-M2.5). Returns the
 * original id when already qualified, unique, or discovery is empty.
 */
export async function resolveOmpModelSelector(
  binary: string,
  model: string | undefined,
  timeoutMs = 8000,
): Promise<string | undefined> {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  if (normalized.includes("/")) return normalized;

  const discovered = await discoverOmpModels(binary, timeoutMs);
  if (discovered.models.length === 0) return normalized;

  const exact = discovered.models.filter((id) => id === normalized);
  if (exact.length === 1) return exact[0];

  const qualified = discovered.models.filter((id) => id.endsWith(`/${normalized}`));
  if (qualified.length === 1) return qualified[0];
  if (qualified.length > 1) {
    // Prefer common coding providers when bare ids collide across plans.
    const preferred =
      qualified.find((id) => id.startsWith("minimax-code/"))
      ?? qualified.find((id) => !id.includes("alibaba") && !id.includes("coding-plan"))
      ?? qualified[0];
    return preferred;
  }

  return normalized;
}

function parseModelListJson(text: string): string[] {
  try {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
        ? (data as { models: unknown[] }).models
        : null;
    if (!list) return [];

    const models: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const selector = typeof record.selector === "string" ? record.selector.trim() : "";
      const provider = typeof record.provider === "string" ? record.provider.trim() : "";
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const candidate = selector || (provider && id ? `${provider}/${id}` : id);
      if (!candidate || candidate.length < 2 || seen.has(candidate)) continue;
      seen.add(candidate);
      models.push(candidate);
    }
    return models;
  } catch {
    return [];
  }
}

function parseModelList(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const models: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("┌") || line.startsWith("├") || line.startsWith("└") || line.startsWith("│ model")) {
      continue;
    }

    // omp models table rows: │ claude-sonnet-4-5           │    200K │ ...
    const tableCell = line.match(/^│\s*([a-zA-Z0-9][\w./+-]*)\s*│/);
    // Common shapes: "* model-id (default)", "- model-id", "model-id", "provider/model-id"
    const bullet = line.match(/^[-*•]\s+(\S+)/);
    const bare = !tableCell && !bullet && !line.includes(" ") ? line : undefined;
    const candidate = (tableCell?.[1] ?? bullet?.[1] ?? bare)?.replace(/[(),]/g, "") ?? "";
    if (!candidate || candidate.length < 2) continue;
    if (/^(available|default|models?|provider|context|max-out|thinking|images)$/i.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    models.push(candidate);
  }

  return models;
}

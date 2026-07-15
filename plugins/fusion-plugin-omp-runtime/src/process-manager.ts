import { runOmpCommand } from "./cli-spawn.js";

/*
FNXC:OmpAcp 2026-07-11-23:35:
Model discovery for the omp-cli provider card. Prefer a structured list when
available; fall soft to an empty list with a clear reason so the picker stays
usable without inventing model ids.
*/

export interface OmpModelDiscoveryResult {
  models: string[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

/**
 * Attempt to list models from the local omp install.
 * Tries `omp models` then falls back to empty (CLI default still works via ACP).
 */
export async function discoverOmpModels(
  binary: string,
  timeoutMs = 8000,
): Promise<OmpModelDiscoveryResult> {
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

import { runGrokCommand } from "./cli-spawn.js";

/*
FNXC:GrokCli 2026-07-08-19:30:
FN-7712: the `grok models` output shape is now VERIFIED from a real capture
(attachment 1871.png in FN-7712): the CLI prints a login/session preamble
("You are logged in with grok..."), a "Default model: <id>" line, an
"Available models:" header, then a bulleted list — `* <id> (default)` for
the active model and `- <id>` for the rest. We drop the preamble/header
lines (case-insensitively, tolerating a trailing colon and leading/trailing
whitespace), strip a leading `* `/`- ` bullet marker from each remaining
candidate line, then strip a trailing ` (default)`/`(default)` annotation
before id extraction so the picker only ever sees bare model ids. Legacy
extraction (leading token before a ` - ` label separator, else before the
first run of 2+ spaces for columnar/pricing layouts, else the whole trimmed
token) is preserved unchanged so older `id - Label (pricing)` and columnar
fixtures still parse. Defensive JSON-tolerant parsing is attempted first
(mirroring Cursor's process-manager.ts), even though the real CLI is not
known to emit JSON.
*/
function parseModelLines(raw: string): string[] {
  const ids = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^available models:?$/i.test(line))
    .filter((line) => !/^you are logged in\b/i.test(line))
    .filter((line) => !/^default model:?/i.test(line))
    .filter((line) => !/^models?:?$/i.test(line))
    .filter((line) => !/^no models? available/i.test(line))
    .filter((line) => !/^tip:/i.test(line))
    .filter((line) => !/^usage/i.test(line))
    .map((line) => line.replace(/^[*-]\s+/, ""))
    .map((line) => line.replace(/\s*\(default\)\s*$/i, ""))
    .map((line) => line.trim())
    .map((line) => {
      const dashIndex = line.indexOf(" - ");
      if (dashIndex !== -1) return line.slice(0, dashIndex).trim();
      const columnMatch = line.match(/\s{2,}/);
      if (columnMatch && typeof columnMatch.index === "number") {
        return line.slice(0, columnMatch.index).trim();
      }
      return line;
    })
    .filter(Boolean);

  return Array.from(new Set(ids));
}

export interface GrokModelDiscoveryResult {
  models: string[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

export async function discoverGrokModels(binary: string, timeoutMs = 5000): Promise<GrokModelDiscoveryResult> {
  const res = await runGrokCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
  }

  const output = (res.stdout || "").trim();
  if (!output) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" };
  }

  if (/^no models? available/i.test(output)) {
    return { models: [], source: "models-text", fallbackUsed: false, reason: "no models available for this account" };
  }

  // Defensive fallback: tolerate output that happens to be JSON, even though
  // the real CLI is not known to support a --json flag today.
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const ids: string[] = [];
      for (const entry of parsed) {
        const id = typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : undefined;
        if (id) ids.push(id);
      }
      if (ids.length > 0) {
        return { models: Array.from(new Set(ids)), source: "models-json", fallbackUsed: false };
      }
    }
  } catch {
    // output is not JSON; fall through to line-based parsing
  }

  const ids = parseModelLines(output);
  if (ids.length > 0) {
    return { models: ids, source: "models-text", fallbackUsed: false };
  }

  return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
}

import { runGrokCommand } from "./cli-spawn.js";

/*
FNXC:GrokCli 2026-07-08-00:00:
FN-7705: the exact `grok models` output line shape is
`upstream-pending-verification` — the upstream README documents the command
lists available Grok models "with pricing hints" but does not pin an exact
column/separator format. We parse CONSERVATIVELY: strip obvious header/tip/
empty-state lines, then take the leading token before a ` - ` label
separator (mirroring the Cursor CLI's `<id> - <Label>` shape) or, absent
that, before the first run of 2+ spaces (a common columnar pricing-hint
layout), falling back to the whole trimmed line as a single-token id.
Defensive JSON-tolerant parsing is attempted first (mirroring Cursor's
process-manager.ts), even though the real CLI is not known to emit JSON.
*/
function parseModelLines(raw: string): string[] {
  const ids = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^available models$/i.test(line))
    .filter((line) => !/^models?:?$/i.test(line))
    .filter((line) => !/^no models? available/i.test(line))
    .filter((line) => !/^tip:/i.test(line))
    .filter((line) => !/^usage/i.test(line))
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

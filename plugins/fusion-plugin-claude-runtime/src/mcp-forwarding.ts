/*
FNXC:ClaudeAcp 2026-07-11-14:00:
Convert engine-resolved MCP server definitions (FN-7022 three-transport shape)
into ACP `session/new.mcpServers` entries so Claude agent stdio receives the same
operator-approved MCP set as other Fusion AI lanes. Env/header secrets are
already materialized by the engine; this module only reshapes them and never logs
server contents.
*/

export type AcpMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    }
  | {
      type: "sse";
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapEntries(map: Record<string, string> | undefined): { name: string; value: string }[] {
  if (!map) return [];
  return Object.entries(map)
    .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    .map(([name, value]) => ({ name, value }));
}

/**
 * Normalize engine `mcpServers` (ResolvedMcpServerDefinition or legacy ACP
 * stdio shape) into the ACP wire format Claude accepts.
 */
export function toAcpMcpServers(servers: unknown): AcpMcpServer[] {
  if (!Array.isArray(servers) || servers.length === 0) return [];
  const out: AcpMcpServer[] = [];

  for (const raw of servers) {
    const server = asRecord(raw);
    if (!server) continue;
    const name = typeof server.name === "string" ? server.name.trim() : "";
    if (!name || server.enabled === false) continue;

    // Legacy ACP stdio shape: { name, command, args, env: [{name,value}] }
    if (typeof server.command === "string" && server.command.trim() && !("transport" in server) && !("type" in server) && !("url" in server)) {
      const envPairs = Array.isArray(server.env)
        ? server.env
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .filter((entry) => typeof entry.name === "string" && typeof entry.value === "string")
            .map((entry) => ({ name: String(entry.name), value: String(entry.value) }))
        : mapEntries(asRecord(server.env) as Record<string, string> | undefined);
      out.push({
        name,
        command: server.command.trim(),
        args: Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === "string") : [],
        env: envPairs,
      });
      continue;
    }

    const transport = typeof server.transport === "string" ? server.transport : typeof server.type === "string" ? server.type : "stdio";

    if (transport === "stdio") {
      const command = typeof server.command === "string" ? server.command.trim() : "";
      if (!command) continue;
      out.push({
        name,
        command,
        args: Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === "string") : [],
        env: mapEntries(asRecord(server.env) as Record<string, string> | undefined),
      });
      continue;
    }

    if (transport === "http" || transport === "streamable-http") {
      const url = typeof server.url === "string" ? server.url.trim() : "";
      if (!url) continue;
      out.push({
        type: "http",
        name,
        url,
        headers: mapEntries(asRecord(server.headers) as Record<string, string> | undefined),
      });
      continue;
    }

    if (transport === "sse") {
      const url = typeof server.url === "string" ? server.url.trim() : "";
      if (!url) continue;
      out.push({
        type: "sse",
        name,
        url,
        headers: mapEntries(asRecord(server.headers) as Record<string, string> | undefined),
      });
    }
  }

  return out;
}

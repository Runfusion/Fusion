/*
FNXC:AcpMcpTransport 2026-09-25-14:51:
ACP session/new requires transport-keyed records with name/value arrays, but Fusion resolves MCP
definitions with a transport discriminator and record-valued env/headers. Normalize both the resolved
shape and the legacy ACP stdio bridge at the protocol boundary without logging server contents.
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

export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

type McpServerRecord = {
  name?: unknown;
  enabled?: unknown;
  transport?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mapEntries(value: unknown): { name: string; value: string }[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    .map(([name, value]) => ({ name, value }));
}

function mapLegacyEnv(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return mapEntries(value);
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => typeof entry.name === "string" && typeof entry.value === "string")
    .map((entry) => ({ name: entry.name as string, value: entry.value as string }));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * FNXC:AcpMcpCapabilityGate 2026-09-25-15:04:
 * ACP requires every agent to support stdio, but HTTP and SSE are optional. When the agent
 * advertised its capabilities, omit remote servers it did not claim; unknown capability data
 * from older adapters remains permissive for compatibility.
 */
export function toAcpMcpServers(
  servers: unknown,
  capabilities?: AcpMcpCapabilities,
): AcpMcpServer[] {
  if (!Array.isArray(servers)) return [];
  const output: AcpMcpServer[] = [];

  for (const raw of servers) {
    const record = asRecord(raw) as McpServerRecord | undefined;
    if (!record) continue;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || record.enabled === false) continue;

    if (
      typeof record.command === "string"
      && record.command.trim()
      && !("transport" in record)
      && !("type" in record)
      && !("url" in record)
    ) {
      output.push({
        name,
        command: record.command.trim(),
        args: stringList(record.args),
        env: mapLegacyEnv(record.env),
      });
      continue;
    }

    const transport = typeof record.transport === "string"
      ? record.transport
      : typeof record.type === "string" ? record.type : "stdio";

    if (transport === "stdio") {
      const command = typeof record.command === "string" ? record.command.trim() : "";
      if (!command) continue;
      output.push({
        name,
        command,
        args: stringList(record.args),
        env: mapEntries(record.env),
      });
      continue;
    }

    if (transport === "http" || transport === "streamable-http" || transport === "sse") {
      if (capabilities && (transport === "sse" ? capabilities.sse !== true : capabilities.http !== true)) continue;
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) continue;
      output.push({
        type: transport === "sse" ? "sse" : "http",
        name,
        url,
        headers: mapEntries(record.headers),
      });
    }
  }

  return output;
}

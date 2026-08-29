import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

let defaultNodeId: string | undefined;
let incarnationId: string | undefined;

/**
 * FNXC:Workspace 2026-08-15-08:23:
 * FUSION_NODE_ID names a deployment slot, not an authority to clear an
 * unexpired lease. Without it, hostname-pid changes after restart, so recovery
 * intentionally waits for TTL; the incarnation prevents restart inheritance.
 */
export function resolveEngineNodeId(): string {
  const configured = process.env.FUSION_NODE_ID?.trim();
  if (configured) return configured;
  return defaultNodeId ??= `${hostname()}-${process.pid}`;
}

/** Per-process identity distinguishes a restarted slot from its predecessor. */
export function resolveEngineIncarnationId(): string {
  return incarnationId ??= randomUUID();
}

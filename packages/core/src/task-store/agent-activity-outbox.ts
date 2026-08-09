import { createHash } from "node:crypto";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { and, eq } from "drizzle-orm";
import { createLogger } from "../process/logger.js";
import * as schema from "../postgres/schema/index.js";
import { AGENT_ACTIVITY_GENERATED_ID_PATTERNS, AGENT_ACTIVITY_LANE_SENTINELS, AGENT_ACTIVITY_METADATA_SCHEMA, type AgentActivityAttribution, type AgentActivityAttributionClaim, type AgentActivityEvent, type AgentActivityEventType, type AgentActivityIdCandidate } from "../types/agents/agents.js";

const agentActivityLog = createLogger("agent-activity-outbox");
/** The discriminator is a transition natural key, never a fresh timestamp or random retry value. */
export function makeAgentActivityEventId(projectId: string, type: string, agentId: string, taskId: string | undefined, discriminator: string): string {
  return `evt_${createHash("sha256").update(`${projectId}\0${type}\0${agentId}\0${taskId ?? ""}\0${discriminator}`).digest("hex").slice(0, 32)}`;
}
/** FNXC:AgentActivityStream 2026-08-09-09:09: claims are not rows; only a live roster probe permits an org-map node. */
export function resolveAgentActivityAttribution(candidates: readonly AgentActivityIdCandidate[], laneSentinel: string): AgentActivityAttributionClaim {
  const cleaned = candidates.filter((candidate) => candidate.id.trim().length > 0).map((candidate) => ({ ...candidate, effective: (AGENT_ACTIVITY_LANE_SENTINELS as readonly string[]).includes(candidate.id) ? "lane" : candidate.provenance }));
  const selected = (["roster", "lane", "actor"] as const).map((kind) => cleaned.find((candidate) => candidate.effective === kind)).find(Boolean);
  const id = selected?.id ?? laneSentinel;
  const claimedAttribution: AgentActivityAttribution = selected?.effective === "roster" ? "agent" : selected?.effective === "actor" ? "actor" : "lane";
  return { agentId: id, claimedAttribution } as AgentActivityAttributionClaim;
}
export async function agentIdExistsInRoster(layer: AsyncDataLayer, agentId: string): Promise<boolean> {
  if (!layer.projectId) return false;
  try { return Boolean((await layer.db.select({ id: schema.project.agents.id }).from(schema.project.agents).where(and(eq(schema.project.agents.projectId, layer.projectId), eq(schema.project.agents.id, agentId))).limit(1))[0]); }
  catch { return false; }
}
export async function verifyAgentActivityAttribution(layer: AsyncDataLayer, claim: AgentActivityAttributionClaim): Promise<{ agentId: string; agentAttribution: AgentActivityAttribution }> {
  if ((AGENT_ACTIVITY_LANE_SENTINELS as readonly string[]).includes(claim.agentId)) return { agentId: claim.agentId, agentAttribution: "lane" };
  if (claim.claimedAttribution !== "agent") return { agentId: claim.agentId, agentAttribution: claim.claimedAttribution };
  // No cache/exemption: a stale roster read must never manufacture an org-map node.
  return { agentId: claim.agentId, agentAttribution: await agentIdExistsInRoster(layer, claim.agentId) ? "agent" : "actor" };
}
export function formatAgentActivitySummary(event: Pick<AgentActivityEvent, "type" | "agentId" | "taskId">): string {
  const task = event.taskId ? ` ${event.taskId}` : "";
  const words: Record<AgentActivityEventType, string> = { "task:started": "started", "task:handed-off": "handed off", "task:completed": "completed", "agent:state-changed": "changed state", "workflow:gate-passed": "passed workflow gate", "workflow:gate-failed": "failed workflow gate", "approval:requested": "requested approval" };
  return `${event.agentId} ${words[event.type]}${task}`;
}
export function sanitizeAgentActivityMetadata(type: AgentActivityEventType, metadata?: Record<string, unknown>): Record<string, unknown> | null {
  if (!metadata) return null;
  const result: Record<string, unknown> = {};
  const entries = AGENT_ACTIVITY_METADATA_SCHEMA[type];
  const warnDropped = (key: string) => {
    // FNXC:AgentActivityStream 2026-08-09-12:27: report only schema coordinates so rejected prose never reaches logs.
    agentActivityLog.warn(`dropped agent activity metadata type=${type} key=${key}`);
  };
  for (const [key, value] of Object.entries(metadata)) {
    const spec = entries[key];
    if (!spec) {
      warnDropped(key);
      continue;
    }
    if (spec.kind === "enum") {
      if (typeof value !== "string") {
        warnDropped(key);
      } else if (spec.values.includes(value)) {
        result[key] = value;
      } else {
        warnDropped(key);
        result[key] = spec.fallback;
      }
    } else if (spec.kind === "generatedId") {
      if (typeof value === "string" && AGENT_ACTIVITY_GENERATED_ID_PATTERNS.some((pattern) => pattern.test(value))) result[key] = value;
      else warnDropped(key);
    } else if (spec.kind === "count") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000) result[key] = value;
      else warnDropped(key);
    } else if (spec.kind === "boolean") {
      if (typeof value === "boolean") result[key] = value;
      else warnDropped(key);
    } else if (spec.kind === "sha") {
      if (typeof value === "string" && /^[0-9a-f]{7,64}$/.test(value)) result[key] = value;
      else warnDropped(key);
    }
  }
  return Object.keys(result).length ? result : null;
}

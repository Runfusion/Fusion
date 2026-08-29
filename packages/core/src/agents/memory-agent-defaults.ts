import type { InstructionsBundleConfig } from "../types.js";
import { BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG } from "./workflow-role-agent-defaults.js";

export const BUILTIN_MEMORY_AGENT_PROVENANCE_KEY = "builtInMemoryAgent";
export const BUILTIN_MEMORY_AGENT_NAME = "Memory Keeper";
export const BUILTIN_MEMORY_AGENT_FALLBACK_NAME = "Memory Keeper (built-in)";

export interface MemoryAgentDefault {
  readonly name: string;
  readonly title: string;
  readonly roles: readonly ["custom"];
  readonly instructionsText: string;
  readonly soul: string;
  readonly bundleConfig: Readonly<InstructionsBundleConfig>;
}

/*
FNXC:MemoryAgent 2026-08-11-09:41:
FN-8932 adds a durable owner for deterministic memory upkeep, not another workflow-stage
principal. AgentCapability is a closed union, so this owner uses the existing custom role and
performs no product decisions or LLM work.
*/
export const BUILTIN_MEMORY_AGENT_DEFAULT: MemoryAgentDefault = Object.freeze({
  name: BUILTIN_MEMORY_AGENT_NAME,
  title: "Built-in memory consolidation owner",
  roles: ["custom"] as const,
  instructionsText: "You are the Memory Keeper. Perform deterministic memory upkeep only: refresh the knowledge graph, consolidate already-extracted rationale into recall, and maintain recall graph references. Make no product decisions, do not claim board work, and do not invoke an LLM.",
  soul: "Steady, conservative, and mechanical. You preserve durable project context through deterministic maintenance without inventing conclusions.",
  bundleConfig: BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG,
});

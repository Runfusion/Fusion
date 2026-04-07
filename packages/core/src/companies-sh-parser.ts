/**
 * Parser for companies.sh manifest files.
 *
 * Extracts agent definitions from shell-script-based manifests following
 * the companies.sh standard. Handles base64-encoded JSON payloads,
 * shell variable extraction, and environment variable defaults.
 *
 * @module companies-sh-parser
 */

import type {
  CompaniesShManifest,
  CompaniesShAgent,
  CompaniesShEnvVar,
  CompaniesShImportResult,
} from "./companies-sh-types.js";
import type { AgentCreateInput, AgentCapability } from "./types.js";

// ── Parsing Errors ───────────────────────────────────────────────────────

export class CompaniesShParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompaniesShParseError";
  }
}

// ── Role Mapping ─────────────────────────────────────────────────────────

const VALID_ROLES: Set<string> = new Set([
  "triage", "executor", "reviewer", "merger", "scheduler", "engineer", "custom",
]);

/**
 * Map a companies.sh role string to a kb AgentCapability.
 * Unknown roles fall back to "custom".
 */
export function mapRoleToCapability(role: string): AgentCapability {
  if (VALID_ROLES.has(role)) {
    return role as AgentCapability;
  }
  return "custom";
}

// ── Shell Variable Extraction ────────────────────────────────────────────

/**
 * Extract a shell variable value from script content.
 * Handles both `VAR="value"` and `VAR='value'` syntax.
 * Returns null if the variable is not found.
 */
function extractShellVariable(script: string, varName: string): string | null {
  // Match VAR="value" or VAR='value' — capture the value inside quotes
  const regex = new RegExp(`^${varName}=["'](.*)["']\\s*$`, "m");
  const match = script.match(regex);
  if (!match) return null;
  return match[1];
}

/**
 * Extract environment variable defaults from export statements.
 * Matches `export VAR="${VAR:-default}"` pattern.
 */
function extractEnvVars(script: string): CompaniesShEnvVar[] {
  const envVars: CompaniesShEnvVar[] = [];
  const regex = /^export\s+(\w+)="\$\{(?:\w+):-(.*?)\}"\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(script)) !== null) {
    envVars.push({
      name: match[1],
      defaultValue: match[2],
    });
  }

  return envVars;
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate a single parsed agent has required fields.
 * Throws if name or role is missing or invalid type.
 */
function validateAgent(agent: unknown, index: number): CompaniesShAgent {
  if (!agent || typeof agent !== "object") {
    throw new CompaniesShParseError(`Agent at index ${index} is not an object`);
  }

  const obj = agent as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new CompaniesShParseError(`Agent at index ${index} is missing required field: name`);
  }

  if (typeof obj.role !== "string" || obj.role.trim() === "") {
    throw new CompaniesShParseError(`Agent at index ${index} is missing required field: role`);
  }

  return {
    name: obj.name,
    role: obj.role,
    capabilities: Array.isArray(obj.capabilities)
      ? obj.capabilities.filter((c: unknown) => typeof c === "string")
      : undefined,
    config: obj.config && typeof obj.config === "object"
      ? {
          ...(typeof (obj.config as Record<string, unknown>).model === "string" && { model: (obj.config as Record<string, unknown>).model as string }),
          ...(typeof (obj.config as Record<string, unknown>).maxTokens === "number" && { maxTokens: (obj.config as Record<string, unknown>).maxTokens as number }),
          ...(typeof (obj.config as Record<string, unknown>).thinkingLevel === "string" && { thinkingLevel: (obj.config as Record<string, unknown>).thinkingLevel as CompaniesShAgent["config"] extends { thinkingLevel?: infer T } ? T : never }),
          ...(typeof (obj.config as Record<string, unknown>).maxTurns === "number" && { maxTurns: (obj.config as Record<string, unknown>).maxTurns as number }),
        }
      : undefined,
    metadata: obj.metadata && typeof obj.metadata === "object"
      ? {
          ...(typeof (obj.metadata as Record<string, unknown>).title === "string" && { title: (obj.metadata as Record<string, unknown>).title as string }),
          ...(typeof (obj.metadata as Record<string, unknown>).icon === "string" && { icon: (obj.metadata as Record<string, unknown>).icon as string }),
          ...(typeof (obj.metadata as Record<string, unknown>).description === "string" && { description: (obj.metadata as Record<string, unknown>).description as string }),
        }
      : undefined,
  };
}

// ── Main Parser ──────────────────────────────────────────────────────────

/**
 * Parse a companies.sh manifest from raw script content.
 *
 * Extracts:
 * - COMPANY_NAME shell variable
 * - AGENT_MANIFEST base64-encoded JSON array
 * - Environment variable defaults from export statements
 *
 * @throws {CompaniesShParseError} If the manifest is malformed
 */
export function parseCompaniesShManifest(scriptContent: string): CompaniesShManifest {
  if (!scriptContent || typeof scriptContent !== "string") {
    throw new CompaniesShParseError("Manifest content is empty or not a string");
  }

  // Extract company name
  const companyName = extractShellVariable(scriptContent, "COMPANY_NAME");
  if (!companyName) {
    throw new CompaniesShParseError("Missing COMPANY_NAME variable in manifest");
  }

  // Extract and decode agent manifest
  const manifestBase64 = extractShellVariable(scriptContent, "AGENT_MANIFEST");
  if (!manifestBase64) {
    throw new CompaniesShParseError("Missing AGENT_MANIFEST variable in manifest");
  }

  let manifestJson: string;
  try {
    // Validate base64 format — atob throws on invalid base64 characters
    atob(manifestBase64);
  } catch {
    throw new CompaniesShParseError("Invalid base64 encoding in AGENT_MANIFEST");
  }
  // Decode using Buffer for proper UTF-8 support
  manifestJson = Buffer.from(manifestBase64, "base64").toString("utf-8");

  let rawAgents: unknown[];
  try {
    const parsed = JSON.parse(manifestJson);
    if (!Array.isArray(parsed)) {
      throw new CompaniesShParseError("AGENT_MANIFEST must decode to a JSON array");
    }
    rawAgents = parsed;
  } catch (err) {
    if (err instanceof CompaniesShParseError) throw err;
    throw new CompaniesShParseError(`Invalid JSON in AGENT_MANIFEST: ${(err as Error).message}`);
  }

  // Validate each agent
  const agents: CompaniesShAgent[] = rawAgents.map((agent, index) =>
    validateAgent(agent, index)
  );

  // Extract environment variable defaults
  const envVars = extractEnvVars(scriptContent);

  return { companyName, agents, envVars };
}

// ── Conversion ───────────────────────────────────────────────────────────

/**
 * Convert a companies.sh agent definition to a kb AgentCreateInput.
 * Maps roles and extracts relevant configuration.
 */
export function companiesShAgentToAgentCreateInput(
  agent: CompaniesShAgent,
): AgentCreateInput {
  const input: AgentCreateInput = {
    name: agent.name,
    role: mapRoleToCapability(agent.role),
  };

  if (agent.metadata?.title) {
    input.title = agent.metadata.title;
  }

  if (agent.metadata?.icon) {
    input.icon = agent.metadata.icon;
  }

  if (agent.config) {
    input.runtimeConfig = {};
    if (agent.config.model) input.runtimeConfig.model = agent.config.model;
    if (agent.config.maxTokens) input.runtimeConfig.maxTokens = agent.config.maxTokens;
    if (agent.config.thinkingLevel) input.runtimeConfig.thinkingLevel = agent.config.thinkingLevel;
    if (agent.config.maxTurns) input.runtimeConfig.maxTurns = agent.config.maxTurns;
  }

  // Store capabilities and description in metadata
  const metadata: Record<string, unknown> = {};
  if (agent.capabilities && agent.capabilities.length > 0) {
    metadata.capabilities = agent.capabilities;
  }
  if (agent.metadata?.description) {
    metadata.description = agent.metadata.description;
  }
  if (Object.keys(metadata).length > 0) {
    input.metadata = metadata;
  }

  return input;
}

/**
 * Convert multiple companies.sh agents to AgentCreateInput array,
 * optionally skipping agents with errors.
 *
 * Returns an import result with created names, skipped names, and errors.
 */
export function convertCompaniesShAgents(
  agents: CompaniesShAgent[],
  options?: { skipExisting?: string[] },
): { inputs: AgentCreateInput[]; result: CompaniesShImportResult } {
  const existingNames = new Set(options?.skipExisting ?? []);
  const inputs: AgentCreateInput[] = [];
  const importResult: CompaniesShImportResult = {
    created: [],
    skipped: [],
    errors: [],
  };

  for (const agent of agents) {
    // Skip agents that already exist by name
    if (existingNames.has(agent.name)) {
      importResult.skipped.push(agent.name);
      continue;
    }

    try {
      const input = companiesShAgentToAgentCreateInput(agent);
      inputs.push(input);
      importResult.created.push(agent.name);
    } catch (err) {
      importResult.errors.push({
        name: agent.name,
        error: (err as Error).message,
      });
    }
  }

  return { inputs, result: importResult };
}

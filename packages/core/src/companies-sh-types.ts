/**
 * TypeScript type definitions for the companies.sh agent manifest format.
 *
 * The companies.sh standard defines a shell-script manifest that contains
 * base64-encoded agent definitions, enabling portability of agent configurations
 * across different agent systems.
 *
 * @module companies-sh-types
 */

// ── Agent Config ─────────────────────────────────────────────────────────

/** Configuration options for a companies.sh agent */
export interface CompaniesShConfig {
  /** AI model identifier (e.g., "provider/model-id") */
  model?: string;
  /** Maximum tokens for the agent's responses */
  maxTokens?: number;
  /** Thinking effort level */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** Maximum number of conversation turns */
  maxTurns?: number;
}

// ── Agent Metadata ───────────────────────────────────────────────────────

/** Display metadata for a companies.sh agent */
export interface CompaniesShMetadata {
  /** Human-readable job title */
  title?: string;
  /** Emoji icon identifier */
  icon?: string;
  /** Agent description */
  description?: string;
}

// ── Agent Definition ─────────────────────────────────────────────────────

/** Role types in the companies.sh manifest format */
export type CompaniesShRole =
  | "triage"
  | "executor"
  | "reviewer"
  | "merger"
  | "scheduler"
  | "engineer"
  | "custom";

/**
 * A single agent definition in the companies.sh manifest.
 * Each agent has a required name and role, plus optional configuration.
 */
export interface CompaniesShAgent {
  /** Display name (required) */
  name: string;
  /** Agent role (required) — maps to kb AgentCapability */
  role: CompaniesShRole | string;
  /** List of capability identifiers */
  capabilities?: string[];
  /** Agent runtime configuration */
  config?: CompaniesShConfig;
  /** Display metadata */
  metadata?: CompaniesShMetadata;
}

// ── Environment Variable ─────────────────────────────────────────────────

/** An environment variable with its default value extracted from the manifest */
export interface CompaniesShEnvVar {
  /** Variable name */
  name: string;
  /** Default value (from ${VAR:-default} syntax) */
  defaultValue: string;
}

// ── Manifest ─────────────────────────────────────────────────────────────

/**
 * Parsed companies.sh manifest representing a full shell-script agent company.
 * Contains the company name, decoded agent definitions, and environment variables.
 */
export interface CompaniesShManifest {
  /** Company name extracted from COMPANY_NAME variable */
  companyName: string;
  /** Decoded and parsed agent definitions */
  agents: CompaniesShAgent[];
  /** Environment variables with defaults extracted from export statements */
  envVars: CompaniesShEnvVar[];
}

// ── Import Result ────────────────────────────────────────────────────────

/** Result of importing agents from a companies.sh manifest */
export interface CompaniesShImportResult {
  /** Agents successfully created */
  created: string[];
  /** Agent names that were skipped (already exist or invalid) */
  skipped: string[];
  /** Errors encountered during import */
  errors: Array<{ name: string; error: string }>;
}

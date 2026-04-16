/**
 * Type definitions for Agent Companies package manifests.
 *
 * @module agent-companies-types
 */

export type AgentCompaniesSchema = "agentcompanies/v1";

export type AgentCompaniesKind =
  | "company"
  | "team"
  | "agent"
  | "project"
  | "task"
  | "skill";

export interface SourceReference {
  kind: string;
  repo?: string;
  path?: string;
  commit?: string;
  hash?: string;
  url?: string;
  trackingRef?: string;
}

export interface AgentCompaniesFrontmatter {
  name: string;
  description?: string;
  slug?: string;
  schema?: AgentCompaniesSchema;
  kind?: AgentCompaniesKind;
  version?: string;
  license?: string;
  authors?: string[];
  tags?: string[];
  metadata?: {
    sources?: SourceReference[];
    [key: string]: unknown;
  };
}

export interface CompanyManifest extends AgentCompaniesFrontmatter {
  goals?: string[];
  requirements?: string[];
}

export interface TeamManifest extends AgentCompaniesFrontmatter {
  manager?: string;
  includes?: string[];
}

export interface AgentManifest extends AgentCompaniesFrontmatter {
  title?: string;
  icon?: string;
  role?: string;
  reportsTo?: string | null;
  skills?: string[];
  instructionBody?: string;
}

export interface ProjectManifest extends AgentCompaniesFrontmatter {}

export interface TaskManifest extends AgentCompaniesFrontmatter {
  assignee?: string;
  project?: string;
  schedule?: {
    timezone?: string;
    startsAt?: string;
  };
}

export interface SkillManifest extends AgentCompaniesFrontmatter {
  instructionBody?: string;
}

export interface AgentCompaniesPackage {
  company?: CompanyManifest;
  agents: AgentManifest[];
  teams: TeamManifest[];
  projects: ProjectManifest[];
  tasks: TaskManifest[];
  skills?: SkillManifest[];
}

export interface AgentCompaniesImportResult {
  created: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

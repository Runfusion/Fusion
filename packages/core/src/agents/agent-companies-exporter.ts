import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import type { Agent } from "../types.js";
import type { AgentManifest } from "./agent-companies-types.js";

export interface ExportOptions {
  companyName?: string;
  companyDescription?: string;
  companySlug?: string;
  includeSkills?: boolean;
}

export interface ExportResult {
  outputDir: string;
  agentsExported: number;
  skillsExported: number;
  filesWritten: string[];
  errors: Array<{ agentId: string; error: string }>;
}

interface AgentManifestOverrides {
  reportsTo?: string | null;
  skills?: string[];
}

interface SkillInfo {
  name: string;
  slug: string;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function slugify(value: string, fallback = "item"): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
}

function ensureUniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let counter = 2;
  let candidate = `${base}-${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }

  used.add(candidate);
  return candidate;
}

function toFrontmatterMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

function extractSkills(agent: Agent): string[] {
  const rawSkills = (agent.metadata as Record<string, unknown> | undefined)?.skills;
  if (!Array.isArray(rawSkills)) {
    return [];
  }

  const names = rawSkills
    .map((entry) => {
      if (typeof entry === "string") {
        return trimToUndefined(entry);
      }
      if (entry && typeof entry === "object") {
        const namedEntry = (entry as Record<string, unknown>).name;
        return trimToUndefined(namedEntry);
      }
      return undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");

  return [...new Set(names)];
}

export function agentToCompaniesManifest(
  agent: Agent,
  overrides?: AgentManifestOverrides,
): AgentManifest {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const description = trimToUndefined(metadata.description);

  return {
    name: agent.name,
    title: trimToUndefined(agent.title),
    icon: trimToUndefined(agent.icon),
    role: agent.role,
    reportsTo:
      overrides?.reportsTo !== undefined
        ? overrides.reportsTo
        : agent.reportsTo
          ? agent.reportsTo
          : null,
    skills: overrides?.skills ?? extractSkills(agent),
    description,
    schema: "agentcompanies/v1",
    instructionBody: trimToUndefined(agent.instructionsText) ?? "",
    memory: trimToUndefined(agent.memory),
  };
}

export function generateCompanyMd(
  agents: Agent[],
  options?: { name?: string; description?: string; slug?: string },
): string {
  const topLevelAgent = agents.find((agent) => !trimToUndefined(agent.reportsTo)) ?? agents[0];
  const topLevelMetadata = (topLevelAgent?.metadata ?? {}) as Record<string, unknown>;

  const name =
    trimToUndefined(options?.name)
    ?? trimToUndefined(topLevelMetadata.companyName)
    ?? trimToUndefined(topLevelAgent?.name)
    ?? "Fusion Agent Company";

  const description =
    trimToUndefined(options?.description)
    ?? trimToUndefined(topLevelMetadata.companyDescription)
    ?? "Exported from Fusion";

  const slug = trimToUndefined(options?.slug) ?? slugify(name, "company");

  const frontmatter = {
    name,
    description,
    slug,
    schema: "agentcompanies/v1",
  };

  return toFrontmatterMarkdown(frontmatter, description);
}

export function generateAgentMd(agent: Agent): string {
  const manifest = agentToCompaniesManifest(agent);
  const frontmatter: Record<string, unknown> = {
    name: manifest.name,
    title: manifest.title,
    icon: manifest.icon,
    role: manifest.role,
    reportsTo: manifest.reportsTo,
    skills: manifest.skills,
    description: manifest.description,
    schema: manifest.schema,
    memory: manifest.memory,
  };

  return toFrontmatterMarkdown(frontmatter, manifest.instructionBody ?? "");
}

function generateSkillMd(skillName: string): string {
  return toFrontmatterMarkdown(
    {
      name: skillName,
      schema: "agentcompanies/v1",
      kind: "skill",
    },
    `# ${skillName}\n\n<!-- Add skill instructions here. -->`,
  );
}

export async function exportAgentsToDirectory(
  agents: Agent[],
  outputDir: string,
  options?: ExportOptions,
): Promise<ExportResult> {
  const resolvedOutputDir = resolve(outputDir);
  const includeSkills = options?.includeSkills ?? true;

  const result: ExportResult = {
    outputDir: resolvedOutputDir,
    agentsExported: 0,
    skillsExported: 0,
    filesWritten: [],
    errors: [],
  };

  await mkdir(resolvedOutputDir, { recursive: true });
  await mkdir(join(resolvedOutputDir, "agents"), { recursive: true });

  const companyMdPath = join(resolvedOutputDir, "COMPANY.md");
  const companyMd = generateCompanyMd(agents, {
    name: options?.companyName,
    description: options?.companyDescription,
    slug: options?.companySlug,
  });
  await writeFile(companyMdPath, companyMd, "utf-8");
  result.filesWritten.push(companyMdPath);

  const validAgents = agents.filter((agent) => {
    if (!trimToUndefined(agent.name)) {
      result.errors.push({
        agentId: agent.id || "unknown",
        error: "Agent name is required for export",
      });
      return false;
    }

    return true;
  });

  const usedAgentSlugs = new Set<string>();
  const agentSlugById = new Map<string, string>();
  for (const agent of validAgents) {
    const baseSlug = slugify(agent.name, "agent");
    const uniqueSlug = ensureUniqueSlug(baseSlug, usedAgentSlugs);
    agentSlugById.set(agent.id, uniqueSlug);
  }

  const skillByName = new Map<string, SkillInfo>();
  const usedSkillSlugs = new Set<string>();

  for (const agent of validAgents) {
    const agentSlug = agentSlugById.get(agent.id) ?? slugify(agent.name, "agent");

    const skillNames = extractSkills(agent);
    const skillRefs: string[] = [];
    for (const skillName of skillNames) {
      const existing = skillByName.get(skillName);
      if (existing) {
        skillRefs.push(existing.slug);
        continue;
      }

      const skillSlug = ensureUniqueSlug(slugify(skillName, "skill"), usedSkillSlugs);
      skillByName.set(skillName, { name: skillName, slug: skillSlug });
      skillRefs.push(skillSlug);
    }

    let reportsTo: string | null = null;
    const parentId = trimToUndefined(agent.reportsTo);
    if (parentId) {
      const parentSlug = agentSlugById.get(parentId);
      reportsTo = parentSlug ? `../${parentSlug}/AGENTS.md` : parentId;
    }

    const manifest = agentToCompaniesManifest(agent, {
      reportsTo,
      skills: skillRefs,
    });

    try {
      const agentDir = join(resolvedOutputDir, "agents", agentSlug);
      const agentMdPath = join(agentDir, "AGENTS.md");

      await mkdir(agentDir, { recursive: true });

      const frontmatter: Record<string, unknown> = {
        name: manifest.name,
        title: manifest.title,
        icon: manifest.icon,
        role: manifest.role,
        reportsTo: manifest.reportsTo,
        skills: manifest.skills,
        description: manifest.description,
        schema: manifest.schema,
        memory: manifest.memory,
      };
      const content = toFrontmatterMarkdown(frontmatter, manifest.instructionBody ?? "");

      await writeFile(agentMdPath, content, "utf-8");
      result.agentsExported += 1;
      result.filesWritten.push(agentMdPath);
    } catch (error) {
      result.errors.push({
        agentId: agent.id,
        error: (error as Error).message,
      });
    }
  }

  if (includeSkills && skillByName.size > 0) {
    const skillsDir = join(resolvedOutputDir, "skills");
    await mkdir(skillsDir, { recursive: true });

    for (const skill of skillByName.values()) {
      const skillDir = join(skillsDir, skill.slug);
      const skillPath = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, generateSkillMd(skill.name), "utf-8");
      result.skillsExported += 1;
      result.filesWritten.push(skillPath);
    }
  }

  return result;
}

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, "../..");
const skillDir = resolve(cliRoot, "skill/fusion");
const extensionPath = resolve(cliRoot, "src/extension.ts");

/**
 * Extract all tool names registered via pi.registerTool({ name: "..." })
 * from the extension source code.
 */
function getExtensionToolNames(): string[] {
  const src = readFileSync(extensionPath, "utf-8");
  const matches = [...src.matchAll(/name:\s*"(fn_[a-z_]+)"/g)];
  return matches.map((m) => m[1]).sort();
}

/**
 * Extract tool names documented in extension-tools.md (### fn_* headings).
 */
function getDocumentedToolNames(): string[] {
  const doc = readFileSync(
    resolve(skillDir, "references/extension-tools.md"),
    "utf-8",
  );
  const matches = [...doc.matchAll(/^### (fn_[a-z_]+)/gm)];
  return matches.map((m) => m[1]).sort();
}

/**
 * Extract tool names listed in SKILL.md under the tool categories.
 */
function getSkillMdToolNames(): string[] {
  const doc = readFileSync(resolve(skillDir, "SKILL.md"), "utf-8");
  const matches = [...doc.matchAll(/`(fn_[a-z_]+)`/g)];
  // Deduplicate
  return [...new Set(matches.map((m) => m[1]))].sort();
}

/**
 * Extract tool names from the capabilities catalog table.
 */
function getCapabilitiesToolNames(): string[] {
  const doc = readFileSync(
    resolve(skillDir, "references/fusion-capabilities.md"),
    "utf-8",
  );
  const matches = [...doc.matchAll(/\| `(fn_[a-z_]+)` \|/g)];
  return matches.map((m) => m[1]).sort();
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Skill-Extension Sync", () => {
  it("skill directory structure exists", () => {
    expect(existsSync(resolve(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(resolve(skillDir, "references"))).toBe(true);
    expect(existsSync(resolve(skillDir, "workflows"))).toBe(true);
    expect(
      existsSync(resolve(skillDir, "references/extension-tools.md")),
    ).toBe(true);
  });

  it("SKILL.md has valid frontmatter with name and description", () => {
    const content = readFileSync(resolve(skillDir, "SKILL.md"), "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\nname:\s*fusion\n/);
    expect(content).toMatch(/\ndescription:\s*.+\n/);
  });

  it("extension-tools.md documents exactly the same tools as extension.ts", () => {
    const extensionTools = getExtensionToolNames();
    const documentedTools = getDocumentedToolNames();

    const missingFromDocs = extensionTools.filter(
      (t) => !documentedTools.includes(t),
    );
    const extraInDocs = documentedTools.filter(
      (t) => !extensionTools.includes(t),
    );

    expect(missingFromDocs).toEqual([]);
    expect(extraInDocs).toEqual([]);
    expect(documentedTools).toEqual(extensionTools);
  });

  it("SKILL.md tool listing includes all registered tools", () => {
    const extensionTools = getExtensionToolNames();
    const skillTools = getSkillMdToolNames();

    const missingFromSkill = extensionTools.filter(
      (t) => !skillTools.includes(t),
    );
    expect(missingFromSkill).toEqual([]);
  });

  it("fusion-capabilities.md tool table includes all registered tools", () => {
    const extensionTools = getExtensionToolNames();
    const capTools = getCapabilitiesToolNames();

    const missingFromCaps = extensionTools.filter(
      (t) => !capTools.includes(t),
    );
    expect(missingFromCaps).toEqual([]);
  });

  it("covers the full Fusion skill markdown surface", () => {
    const markdownFiles = collectMarkdownFiles(skillDir).map((filePath) =>
      relative(skillDir, filePath),
    );

    expect(markdownFiles).toEqual([
      "SKILL.md",
      "references/best-practices.md",
      "references/cli-commands.md",
      "references/extension-tools.md",
      "references/fusion-capabilities.md",
      "references/skill-patterns.md",
      "references/task-structure.md",
      "workflows/dashboard-cli.md",
      "workflows/specifications.md",
      "workflows/task-lifecycle.md",
      "workflows/task-management.md",
    ]);
  });

  it("enforces fn_* naming across extension + all skill markdown for public tools", () => {
    const extensionTools = getExtensionToolNames();
    const publicSuffixes = extensionTools.map((toolName) =>
      toolName.replace(/^fn_/, ""),
    );

    // These names are intentionally unprefixed engine/runtime tools and are allowed
    // to appear in docs that explain capability boundaries.
    const allowedUnprefixedInternalTools = new Set([
      "task_create",
      "task_update",
      "task_log",
      "task_done",
      "review_step",
      "spawn_agent",
    ]);

    const forbiddenSuffixes = publicSuffixes.filter(
      (suffix) => !allowedUnprefixedInternalTools.has(suffix),
    );

    const filesToScan = [extensionPath, ...collectMarkdownFiles(skillDir)];
    const violations: string[] = [];

    for (const filePath of filesToScan) {
      const content = readFileSync(filePath, "utf-8");
      const relativePath = relative(cliRoot, filePath);

      for (const suffix of forbiddenSuffixes) {
        const regex = new RegExp(`(?<!fn_)\\b${escapeRegex(suffix)}\\b`, "g");
        if (regex.test(content)) {
          violations.push(`${relativePath}: ${suffix}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("/fn command is documented in the skill", () => {
    const skillMd = readFileSync(resolve(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("/fn");

    const dashboardCli = readFileSync(
      resolve(skillDir, "workflows/dashboard-cli.md"),
      "utf-8",
    );
    expect(dashboardCli).toContain("/fn");
  });

  it("package.json includes skills in pi config and files array", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(cliRoot, "package.json"), "utf-8"),
    );
    expect(pkg.pi.skills).toContain("./skill");
    expect(pkg.files).toContain("skill/**");
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS, type WorkflowIrNode } from "@fusion/core";
import { installBundledCeSkills, resolveBundledSkillsRoot } from "../skill-installation.js";

/*
FNXC:CompoundEngineering 2026-06-28-08:58:
FN-7145 requires workflow-named Compound Engineering skills to load as real resources, not only appear in prompt text. This regression test ties every `builtin:compound-engineering` skill node, including optional-group children, to a bundled and installable `SKILL.md` so ce-plan, ce-work, ce-code-review, and follow-on CE skills remain discoverable by the step session.
*/

type CeWorkflowSkillNode = {
  nodePath: string;
  skillName: string;
  bareSkillId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bareSkillId(skillName: string): string {
  return skillName.includes(":") ? skillName.slice(skillName.lastIndexOf(":") + 1) : skillName;
}

function templateNodes(node: WorkflowIrNode): WorkflowIrNode[] {
  const template = isRecord(node.config?.template) ? node.config.template : undefined;
  const nodes = isRecord(template) ? template.nodes : undefined;
  return Array.isArray(nodes) ? nodes.filter((candidate): candidate is WorkflowIrNode => isRecord(candidate) && typeof candidate.id === "string" && typeof candidate.kind === "string") : [];
}

function collectSkillNodes(nodes: readonly WorkflowIrNode[], parentPath: readonly string[] = []): CeWorkflowSkillNode[] {
  return nodes.flatMap((node) => {
    const nodePathParts = [...parentPath, node.id];
    const skillName = typeof node.config?.skillName === "string" ? node.config.skillName.trim() : "";
    const direct = skillName
      ? [
          {
            nodePath: nodePathParts.join(" > "),
            skillName,
            bareSkillId: bareSkillId(skillName),
          },
        ]
      : [];
    return [...direct, ...collectSkillNodes(templateNodes(node), nodePathParts)];
  });
}

function compoundEngineeringWorkflowSkillNodes(): CeWorkflowSkillNode[] {
  const workflow = BUILTIN_WORKFLOWS.find((candidate) => candidate.id === "builtin:compound-engineering");
  if (!workflow) throw new Error("builtin:compound-engineering workflow not found");
  return collectSkillNodes(workflow.ir.nodes);
}

function frontmatterName(content: string): string | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? "";
  const rawName = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1];
  return rawName?.replace(/^['\"]|['\"]$/g, "");
}

const workflowSkillNodes = compoundEngineeringWorkflowSkillNodes();
const workflowBareSkillIds = workflowSkillNodes.map((node) => node.bareSkillId);

describe("built-in Compound Engineering workflow skill alignment", () => {
  const tmpTargets: string[] = [];

  afterEach(() => {
    for (const target of tmpTargets) rmSync(target, { recursive: true, force: true });
    tmpTargets.length = 0;
  });

  it("derives every skill-bearing node, including optional-group template children", () => {
    expect(workflowSkillNodes.map((node) => [node.nodePath, node.skillName])).toEqual([
      ["plan", "compound-engineering:ce-plan"],
      ["ce-doc-review > ce-doc-review-step", "compound-engineering:ce-doc-review"],
      ["execute", "compound-engineering:ce-work"],
      ["code-review > code-review-step", "compound-engineering:ce-code-review"],
      ["manual-pr-review > commit", "compound-engineering:ce-commit"],
      ["document", "compound-engineering:ce-compound"],
    ]);
    expect(workflowBareSkillIds).toEqual(expect.arrayContaining(["ce-plan", "ce-work", "ce-code-review"]));
  });

  it.each(workflowSkillNodes)("$nodePath resolves $bareSkillId to a bundled SKILL.md source", ({ bareSkillId }) => {
    const skillMd = join(resolveBundledSkillsRoot(), bareSkillId, "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(frontmatterName(readFileSync(skillMd, "utf-8"))).toBe(bareSkillId);
  });

  it("installs every workflow-named skill onto the discovery root scanned by CE sessions", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ce-workflow-skill-alignment-"));
    tmpTargets.push(targetRoot);

    const { results } = installBundledCeSkills({ targetRoot });

    for (const { bareSkillId } of workflowSkillNodes) {
      const result = results.find((candidate) => candidate.skillId === bareSkillId);
      expect(result).toMatchObject({ skillId: bareSkillId, outcome: "installed" });
      const installedSkillMd = join(targetRoot, bareSkillId, "SKILL.md");
      expect(existsSync(installedSkillMd)).toBe(true);
      expect(frontmatterName(readFileSync(installedSkillMd, "utf-8"))).toBe(bareSkillId);
    }
  });
});

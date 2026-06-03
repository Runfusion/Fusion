import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_AGENT_PROMPTS,
  resolveAgentPrompt,
  getAvailableTemplates,
  getTemplatesForRole,
} from "../agent-prompts.js";
import type { AgentPromptsConfig, AgentPromptTemplate } from "../types.js";

// ---------------------------------------------------------------------------
// resolveAgentPrompt
// ---------------------------------------------------------------------------

describe("resolveAgentPrompt", () => {
  it("returns the correct built-in prompt for executor when no config provided", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toBeTruthy();
    expect(result).toContain("task execution agent");
  });

  it("returns the correct built-in prompt for triage when no config provided", () => {
    const result = resolveAgentPrompt("triage");
    expect(result).toBeTruthy();
    expect(result).toContain("task specification agent");
  });

  it("returns the correct built-in prompt for reviewer when no config provided", () => {
    const result = resolveAgentPrompt("reviewer");
    expect(result).toBeTruthy();
    expect(result).toContain("independent code and plan reviewer");
  });

  it("returns the correct built-in prompt for merger when no config provided", () => {
    const result = resolveAgentPrompt("merger");
    expect(result).toBeTruthy();
    expect(result).toContain("merge agent");
  });

  it("returns empty string for role with no built-in default", () => {
    const result = resolveAgentPrompt("scheduler");
    expect(result).toBe("");
  });

  it("returns custom template when roleAssignments maps to a custom template ID", () => {
    const config: AgentPromptsConfig = {
      templates: [
        {
          id: "my-custom-executor",
          name: "My Custom Executor",
          description: "A custom executor",
          role: "executor",
          prompt: "You are a custom executor agent.",
        },
      ],
      roleAssignments: {
        executor: "my-custom-executor",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toBe("You are a custom executor agent.");
  });

  it("returns built-in template when roleAssignments maps to a built-in template ID", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toBeTruthy();
    expect(result).toContain("senior engineering agent");
  });

  it("throws descriptive error when assigned template ID does not exist", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "nonexistent-template",
      },
    };

    expect(() => resolveAgentPrompt("executor", config)).toThrow(
      /Agent prompt template "nonexistent-template" not found/,
    );
  });

  it("prioritizes custom templates over built-in when IDs collide", () => {
    const config: AgentPromptsConfig = {
      templates: [
        {
          id: "default-executor",
          name: "Overridden Executor",
          description: "Custom template that overrides the built-in",
          role: "executor",
          prompt: "This is the overridden executor prompt.",
        },
      ],
      roleAssignments: {
        executor: "default-executor",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toBe("This is the overridden executor prompt.");
  });

  it("returns empty string when config has no roleAssignment for the role", () => {
    const config: AgentPromptsConfig = {
      templates: [],
    };

    // scheduler has no built-in default, and no assignment
    const result = resolveAgentPrompt("scheduler", config);
    expect(result).toBe("");
  });

  it("returns built-in default when config has empty roleAssignments", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {},
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("task execution agent");
  });

  it("built-in executor prompt requires resolving ALL lint and test failures including unrelated", () => {
    const result = resolveAgentPrompt("executor");
    // The stricter language must be present to prevent "unrelated failure" deferrals
    expect(result).toContain("Resolve ALL lint failures and test failures");
    expect(result).toContain("even if they appear unrelated or pre-existing");
    expect(result).toContain("do not defer them to a separate task");
  });

  it("senior-engineer prompt requires resolving ALL lint and test failures including unrelated", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("Resolve ALL lint failures and test failures");
    expect(result).toContain("even if they appear unrelated or pre-existing");
    expect(result).toContain("do not defer them to a separate task");
  });

  it("built-in executor prompt includes worktree boundary guidance", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain("## Worktree Boundaries");
    expect(result).toContain("isolated git worktree");
    expect(result).toContain("inside the current worktree directory");
  });

  it("built-in executor prompt mentions memory exception", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain(".fusion/memory/");
  });

  it("built-in executor prompt mentions attachments exception", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain("attachments");
  });

  it("senior-engineer prompt includes worktree boundary guidance", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("## Worktree Boundaries");
    expect(result).toContain("isolated git worktree");
    expect(result).toContain("inside the current worktree directory");
  });

  it("senior-engineer prompt mentions memory exception", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain(".fusion/memory/");
  });

  it("senior-engineer prompt mentions attachments exception", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("attachments");
  });

  // ── Task Document Tool Guidance ─────────────────────────────────────────

  it("built-in executor prompt includes task_document_write guidance", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain("task_document_write");
    expect(result).toContain("Task Documents");
    expect(result).toContain("Documents tab");
  });

  it("built-in executor prompt includes task_document_read guidance", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain("task_document_read");
    expect(result).toContain("task documents visible in the dashboard");
  });

  it("senior-engineer prompt includes task_document_write guidance", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("task_document_write");
    expect(result).toContain("Task Documents");
  });

  it("senior-engineer prompt includes task_document_read guidance", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("task_document_read");
  });

  it("built-in triage prompt includes task_document_write guidance for planning output", () => {
    const result = resolveAgentPrompt("triage");
    expect(result).toContain("task_document_write");
    expect(result).toContain("planning");
  });

  it("concise-triage prompt includes task_document_write guidance", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        triage: "concise-triage",
      },
    };

    const result = resolveAgentPrompt("triage", config);
    expect(result).toContain("task_document_write");
  });

  it("triage prompt broad-scope decomposition block is present and identical in core and engine templates", () => {
    const corePrompt = resolveAgentPrompt("triage");
    const triageSource = readFileSync(
      resolve(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "engine", "src", "triage.ts"),
      "utf8",
    );
    const enginePromptMatch = triageSource.match(/export const TRIAGE_SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(enginePromptMatch?.[1]).toBeTruthy();
    const enginePrompt = enginePromptMatch![1].replaceAll("\\`", "`");

    for (const prompt of [corePrompt, enginePrompt]) {
      expect(prompt).toContain("**Broad-scope decomposition signals:**");
      expect(prompt).toContain("step count would reach 9 or more");
      expect(prompt).toContain("would reach 12 or more");
      expect(prompt).toContain("20 or more entries");
      expect(prompt).toContain("at or above 30 items");
    }

    const marker = "**Broad-scope decomposition signals:**";
    const blockRegex = /\*\*Broad-scope decomposition signals:\*\*[\s\S]*?(?=\n\n(?:##|\*\*))/;
    const coreStart = corePrompt.indexOf(marker);
    const engineStart = enginePrompt.indexOf(marker);
    expect(coreStart).toBeGreaterThanOrEqual(0);
    expect(engineStart).toBeGreaterThanOrEqual(0);

    const coreBlock = corePrompt.slice(coreStart).match(blockRegex)?.[0];
    const engineBlock = enginePrompt.slice(engineStart).match(blockRegex)?.[0];
    expect(coreBlock).toBeTruthy();
    expect(engineBlock).toBeTruthy();
    expect(coreBlock).toBe(engineBlock);
  });

  it("built-in triage prompt requires surface enumeration for bug-fix specs", () => {
    const triagePrompt = resolveAgentPrompt("triage");
    expect(triagePrompt).toContain("## Surface Enumeration");
    expect(triagePrompt).toContain("spec MUST include a `## Surface Enumeration` section");
    expect(triagePrompt).toContain("blocking REVISE");
  });

  it("built-in reviewer prompts reject missing surface enumeration and repro-only bug-fix tests", () => {
    const defaultReviewer = resolveAgentPrompt("reviewer");
    const strictReviewer = resolveAgentPrompt("reviewer", {
      roleAssignments: { reviewer: "strict-reviewer" },
    });

    for (const prompt of [defaultReviewer, strictReviewer]) {
      expect(prompt).toContain("**Surface enumeration:**");
      expect(prompt).toContain("Missing or incomplete coverage is a blocking REVISE");
      expect(prompt).toContain("repro-only regression test");
      expect(prompt).toContain("spanning the `## Surface Enumeration` checklist");
      expect(prompt).toContain("FN-5797/FN-5875/FN-5919");
    }
  });

  it("default role prompts include explicit heartbeat run guidance", () => {
    expect(resolveAgentPrompt("executor")).toContain("## Heartbeat Run Behavior");
    expect(resolveAgentPrompt("triage")).toContain("## Heartbeat Run Behavior");
    expect(resolveAgentPrompt("reviewer")).toContain("## Heartbeat Run Behavior");
    expect(resolveAgentPrompt("merger")).toContain("## Heartbeat Run Behavior");
  });

  it("executor heartbeat guidance covers no-task engineering work", () => {
    const result = resolveAgentPrompt("executor");
    expect(result).toContain("execute your standing instructions");
    expect(result).toContain("blocked or failing engineering work");
  });

  it("reviewer heartbeat guidance is findings-focused and customized per variant", () => {
    const defaultReviewer = resolveAgentPrompt("reviewer");
    expect(defaultReviewer).toContain("Look for work waiting on review");

    const strictConfig: AgentPromptsConfig = {
      roleAssignments: {
        reviewer: "strict-reviewer",
      },
    };
    const strictReviewer = resolveAgentPrompt("reviewer", strictConfig);
    expect(strictReviewer).toContain("worst-case failure modes first");
    expect(strictReviewer).toContain("under-reviewed");
  });

  it("triage heartbeat guidance is customized for standard and concise templates", () => {
    const defaultTriage = resolveAgentPrompt("triage");
    expect(defaultTriage).toContain("Patrol for vague requests");

    const conciseConfig: AgentPromptsConfig = {
      roleAssignments: {
        triage: "concise-triage",
      },
    };
    const conciseTriage = resolveAgentPrompt("triage", conciseConfig);
    expect(conciseTriage).toContain("Keep heartbeat output lean and useful");
    expect(conciseTriage).toContain("minimum complete PROMPT.md");
  });

  it("merger and senior-engineer heartbeat guidance is role-specific", () => {
    const merger = resolveAgentPrompt("merger");
    expect(merger).toContain("keep merge-ready work from stalling");
    expect(merger).toContain("in-review and merge-ready queue");

    const seniorConfig: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };
    const senior = resolveAgentPrompt("executor", seniorConfig);
    expect(senior).toContain("autonomous senior-engineering pass");
    expect(senior).toContain("architectural drift");
  });
});

// ---------------------------------------------------------------------------
// getAvailableTemplates
// ---------------------------------------------------------------------------

describe("getAvailableTemplates", () => {
  it("returns only built-in templates when no config provided", () => {
    const templates = getAvailableTemplates();
    expect(templates.length).toBe(BUILTIN_AGENT_PROMPTS.length);
    // All should be built-in
    expect(templates.every((t) => t.builtIn === true)).toBe(true);
  });

  it("returns only built-in templates when config has no templates", () => {
    const templates = getAvailableTemplates({});
    expect(templates.length).toBe(BUILTIN_AGENT_PROMPTS.length);
  });

  it("merges custom templates with built-in", () => {
    const customTemplate: AgentPromptTemplate = {
      id: "my-custom",
      name: "My Custom",
      description: "A custom template",
      role: "executor",
      prompt: "Custom prompt",
    };

    const templates = getAvailableTemplates({ templates: [customTemplate] });
    expect(templates.length).toBe(BUILTIN_AGENT_PROMPTS.length + 1);
    expect(templates.find((t) => t.id === "my-custom")).toEqual(customTemplate);
  });

  it("custom template overrides built-in by ID", () => {
    const overrideTemplate: AgentPromptTemplate = {
      id: "default-executor",
      name: "Overridden",
      description: "Overrides the built-in executor",
      role: "executor",
      prompt: "Overridden prompt",
    };

    const templates = getAvailableTemplates({ templates: [overrideTemplate] });
    const executorTemplate = templates.find((t) => t.id === "default-executor");
    expect(executorTemplate?.prompt).toBe("Overridden prompt");
    // Should still have the same total count (replaced, not added)
    expect(templates.length).toBe(BUILTIN_AGENT_PROMPTS.length);
  });
});

// ---------------------------------------------------------------------------
// getTemplatesForRole
// ---------------------------------------------------------------------------

describe("getTemplatesForRole", () => {
  it("returns executor templates", () => {
    const templates = getTemplatesForRole("executor");
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.every((t) => t.role === "executor")).toBe(true);
  });

  it("returns triage templates", () => {
    const templates = getTemplatesForRole("triage");
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.every((t) => t.role === "triage")).toBe(true);
  });

  it("returns reviewer templates", () => {
    const templates = getTemplatesForRole("reviewer");
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.every((t) => t.role === "reviewer")).toBe(true);
  });

  it("returns merger templates", () => {
    const templates = getTemplatesForRole("merger");
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.every((t) => t.role === "merger")).toBe(true);
  });

  it("includes custom templates for the role", () => {
    const customTemplate: AgentPromptTemplate = {
      id: "my-reviewer",
      name: "My Reviewer",
      description: "A custom reviewer",
      role: "reviewer",
      prompt: "Custom reviewer prompt",
    };

    const templates = getTemplatesForRole("reviewer", { templates: [customTemplate] });
    const found = templates.find((t) => t.id === "my-reviewer");
    expect(found).toBeDefined();
    expect(found?.prompt).toBe("Custom reviewer prompt");
  });
});

// ---------------------------------------------------------------------------
// Built-in template validation
// ---------------------------------------------------------------------------

describe("BUILTIN_AGENT_PROMPTS", () => {
  it("covers all 4 core roles (executor, triage, reviewer, merger)", () => {
    const roles = new Set(BUILTIN_AGENT_PROMPTS.map((t) => t.role));
    expect(roles.has("executor")).toBe(true);
    expect(roles.has("triage")).toBe(true);
    expect(roles.has("reviewer")).toBe(true);
    expect(roles.has("merger")).toBe(true);
  });

  it("has a default template for each core role", () => {
    const coreRoles: Array<"executor" | "triage" | "reviewer" | "merger"> = [
      "executor",
      "triage",
      "reviewer",
      "merger",
    ];

    for (const role of coreRoles) {
      const defaultTemplate = BUILTIN_AGENT_PROMPTS.find(
        (t) => t.id === `default-${role}`,
      );
      expect(defaultTemplate).toBeDefined();
      expect(defaultTemplate?.role).toBe(role);
    }
  });

  it("has additional role variants (senior-engineer, strict-reviewer, concise-triage)", () => {
    const ids = new Set(BUILTIN_AGENT_PROMPTS.map((t) => t.id));
    expect(ids.has("senior-engineer")).toBe(true);
    expect(ids.has("strict-reviewer")).toBe(true);
    expect(ids.has("concise-triage")).toBe(true);
  });

  it("all built-in templates have valid required fields", () => {
    for (const template of BUILTIN_AGENT_PROMPTS) {
      expect(template.id).toBeTruthy();
      expect(typeof template.id).toBe("string");
      expect(template.name).toBeTruthy();
      expect(typeof template.name).toBe("string");
      expect(template.description).toBeTruthy();
      expect(typeof template.description).toBe("string");
      expect(template.role).toBeTruthy();
      expect(typeof template.role).toBe("string");
      expect(template.prompt).toBeTruthy();
      expect(typeof template.prompt).toBe("string");
      expect(template.builtIn).toBe(true);
    }
  });

  it("all template IDs are unique", () => {
    const ids = BUILTIN_AGENT_PROMPTS.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

import { describe, it, expect } from "vitest";
import {
  BUILTIN_AGENT_PROMPTS,
  resolveAgentPrompt,
  getAvailableTemplates,
  getTemplatesForRole,
} from "./agent-prompts.js";
import type { AgentPromptsConfig, AgentPromptTemplate } from "./types.js";

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

  it("built-in executor prompt requires resolving ALL test failures including unrelated", () => {
    const result = resolveAgentPrompt("executor");
    // The stricter language must be present to prevent "unrelated failure" deferrals
    expect(result).toContain("Resolve ALL test failures");
    expect(result).toContain("even if they appear unrelated or pre-existing");
    expect(result).toContain("do not defer them to a separate task");
  });

  it("senior-engineer prompt requires resolving ALL test failures including unrelated", () => {
    const config: AgentPromptsConfig = {
      roleAssignments: {
        executor: "senior-engineer",
      },
    };

    const result = resolveAgentPrompt("executor", config);
    expect(result).toContain("Resolve ALL test failures");
    expect(result).toContain("even if they appear unrelated or pre-existing");
    expect(result).toContain("do not defer them to a separate task");
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

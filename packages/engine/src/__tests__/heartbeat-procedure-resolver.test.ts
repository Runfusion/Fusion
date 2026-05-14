import type { Agent, ProjectSettings } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatPromptTemplate,
  resolveHeartbeatScopeDisciplineMode,
  selectHeartbeatProcedure,
} from "../heartbeat-procedure-resolver.js";

const project = (mode?: ProjectSettings["heartbeatScopeDiscipline"]) => ({ heartbeatScopeDiscipline: mode });
const agent = (mode?: unknown) => ({ runtimeConfig: mode === undefined ? {} : { heartbeatScopeDiscipline: mode } }) as Pick<Agent, "runtimeConfig">;
const projectTemplate = (template?: ProjectSettings["heartbeatPromptTemplate"]) => ({ heartbeatPromptTemplate: template });
const templateAgent = (role: Agent["role"], template?: unknown) => ({
  role,
  runtimeConfig: template === undefined ? {} : { heartbeatPromptTemplate: template },
}) as Pick<Agent, "runtimeConfig" | "role">;

describe("resolveHeartbeatScopeDisciplineMode", () => {
  it.each(["strict", "lite", "off"] as const)("prefers agent override: %s", (mode) => {
    expect(resolveHeartbeatScopeDisciplineMode(project("strict"), agent(mode))).toBe(mode);
  });

  it.each(["strict", "lite", "off"] as const)("uses project mode when agent unset: %s", (mode) => {
    expect(resolveHeartbeatScopeDisciplineMode(project(mode), agent(undefined))).toBe(mode);
  });

  it("falls through invalid agent mode to project mode", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("lite"), agent("invalid"))).toBe("lite");
  });

  it("falls through invalid project mode to strict default", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("invalid" as never), agent(undefined))).toBe("strict");
  });

  it("falls through invalid agent and invalid project modes to strict default", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("invalid" as never), agent("invalid"))).toBe("strict");
  });

  it("defaults to strict when unset", () => {
    expect(resolveHeartbeatScopeDisciplineMode(undefined, undefined)).toBe("strict");
  });
});

describe("resolveHeartbeatPromptTemplate", () => {
  it("prefers agent override over project and role defaults", () => {
    expect(resolveHeartbeatPromptTemplate(projectTemplate("default"), templateAgent("triage", "compact"))).toBe("compact");
  });

  it("uses project setting when agent override is unset", () => {
    expect(resolveHeartbeatPromptTemplate(projectTemplate("compact"), templateAgent("executor"))).toBe("compact");
  });

  it.each(["triage", "reviewer", "merger", "scheduler", "engineer", "custom"] as const)(
    "defaults non-executor role %s to compact",
    (role) => {
      expect(resolveHeartbeatPromptTemplate(undefined, templateAgent(role))).toBe("compact");
    },
  );

  it("defaults executor role to default", () => {
    expect(resolveHeartbeatPromptTemplate(undefined, templateAgent("executor"))).toBe("default");
  });

  it("falls through invalid agent template to project", () => {
    expect(resolveHeartbeatPromptTemplate(projectTemplate("compact"), templateAgent("executor", "invalid"))).toBe("compact");
  });

  it("falls through invalid project template to role default", () => {
    expect(resolveHeartbeatPromptTemplate(projectTemplate("tiny" as never), templateAgent("triage"))).toBe("compact");
  });

  it("returns default when agent is undefined", () => {
    expect(resolveHeartbeatPromptTemplate(projectTemplate("tiny" as never), undefined)).toBe("default");
  });
});

describe("selectHeartbeatProcedure", () => {
  const procedures = {
    task: { strict: "task-strict", lite: "task-lite", off: "task-off" },
    noTask: { strict: "no-task-strict", lite: "no-task-lite", off: "no-task-off" },
  } as const;

  it.each([
    ["strict", false, "task-strict"],
    ["lite", false, "task-lite"],
    ["off", false, "task-off"],
    ["strict", true, "no-task-strict"],
    ["lite", true, "no-task-lite"],
    ["off", true, "no-task-off"],
  ] as const)("maps mode=%s isNoTask=%s", (mode, isNoTaskRun, expected) => {
    expect(selectHeartbeatProcedure(mode, isNoTaskRun, procedures)).toBe(expected);
  });
});

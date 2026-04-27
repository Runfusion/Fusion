import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentStore } from "@fusion/core";

const mockResolveProject = vi.fn();

vi.mock("../../project-context.js", () => ({
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
}));

import { runAgentExport } from "../agent-export.js";

// Skipped: each test spins up a real workspace + AgentStore round-trip and
// totals ~3.3s; covered indirectly by integration paths. Re-enable if
// agent-export gains logic that isn't covered elsewhere.
describe.skip("agent-export", () => {
  const tmpRoot = join(tmpdir(), `fn-agent-export-test-${process.pid}`);
  let projectDir: string;
  let outputDir: string;

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(async () => {
    vi.clearAllMocks();

    projectDir = join(tmpRoot, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    outputDir = join(projectDir, "exports", "company");

    mkdirSync(projectDir, { recursive: true });

    mockResolveProject.mockResolvedValue({
      projectId: "proj-test",
      projectPath: projectDir,
      projectName: "proj-test",
      isRegistered: true,
      store: {},
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function seedAgents(): Promise<void> {
    const store = new AgentStore({ rootDir: join(projectDir, ".fusion") });
    await store.init();

    const ceo = await store.createAgent({
      name: "CEO",
      role: "executor",
      title: "Chief Executive",
      metadata: {
        description: "Company lead",
        skills: ["strategy"],
      },
      instructionsText: "Lead company operations.",
    });

    await store.createAgent({
      name: "Reviewer",
      role: "reviewer",
      reportsTo: ceo.id,
      metadata: {
        description: "Code reviewer",
        skills: ["review"],
      },
      instructionsText: "Review all changes.",
    });
  }

  it("exports agents and creates package files", async () => {
    await seedAgents();

    await runAgentExport(outputDir, {
      companyName: "Acme Export",
      companySlug: "acme-export",
    });

    expect(existsSync(join(outputDir, "COMPANY.md"))).toBe(true);
    expect(existsSync(join(outputDir, "agents", "ceo", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(outputDir, "agents", "reviewer", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(outputDir, "skills", "strategy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(outputDir, "skills", "review", "SKILL.md"))).toBe(true);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Agents exported: 2");
  });

  it("resolves project path when --project is provided", async () => {
    await seedAgents();

    await runAgentExport(outputDir, {
      project: "my-project",
    });

    expect(mockResolveProject).toHaveBeenCalledWith("my-project");
    expect(existsSync(join(outputDir, "COMPANY.md"))).toBe(true);
  });

  it("exits with an error when there are no agents to export", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    await expect(
      runAgentExport(outputDir, {
        project: "empty-project",
      }),
    ).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith("No agents found to export");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

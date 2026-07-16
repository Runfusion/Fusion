import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentStore } from "@fusion/core";

const mockResolveProject = vi.fn();
const mockResolveAgentStoreBase = vi.fn();
let activeProjectDir = "";
let activeAsyncLayer: () => unknown = () => undefined;

vi.mock("../../project-context.js", () => ({
  // FNXC:PostgresCutover 2026-07-16-08:50: Agent export must use the real PG async layer, not an empty stub that would bypass persistence behavior.
  resolveAgentStoreBase: (project?: string) => mockResolveAgentStoreBase(project),
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
}));

import { runAgentExport } from "../agent-export.js";

// Slow lane only: each test spins up a real workspace + AgentStore round-trip
// and totals ~3.3s. Keep default `pnpm test` lean/reliable; run this suite in
// the explicit slow lane (`pnpm --filter @runfusion/fusion test:slow-cli`).
const SHOULD_RUN_SLOW_CLI =
  process.env.FUSION_TEST_SLOW_CLI === "1" || process.env.FUSION_TEST_SLOW_CLI === "true";

/*
FNXC:PostgresCutover 2026-07-16-08:50:
The opt-in export suite still exercises real AgentStore persistence, now through a
shared PG harness. `pgDescribe` registers a clean skip when the external server is unavailable.
*/
const h = createSharedPgTaskStoreTestHarness({ prefix: "agent-export" });

describe.skipIf(!SHOULD_RUN_SLOW_CLI)("agent-export", () => {
  pgDescribe("postgres-backed export", () => {
  const tmpRoot = join(tmpdir(), `fn-agent-export-test-${process.pid}`);
  let projectDir: string;
  let outputDir: string;

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    vi.clearAllMocks();

    projectDir = join(tmpRoot, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    activeProjectDir = projectDir;
    activeAsyncLayer = () => h.store().getAsyncLayer()!;
    mockResolveAgentStoreBase.mockImplementation(async () => ({
      rootDir: activeProjectDir,
      asyncLayer: activeAsyncLayer(),
      cleanup: vi.fn(async () => undefined),
    }));
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

  afterEach(async () => {
    rmSync(projectDir, { recursive: true, force: true });
    await h.afterEach();
  });

  afterAll(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await h.afterAll();
  });

  async function seedAgents(): Promise<void> {
    const store = new AgentStore({
      rootDir: join(projectDir, ".fusion"),
      asyncLayer: h.store().getAsyncLayer()!,
    });
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

    expect(mockResolveAgentStoreBase).toHaveBeenCalledWith("my-project");
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "@fusion/core";
import { runAgentImport } from "./agent-import.js";
import type { CompaniesShAgent } from "@fusion/core";

// ── Helpers ──────────────────────────────────────────────────────────────

function encodeManifest(agents: unknown[]): string {
  return Buffer.from(JSON.stringify(agents)).toString("base64");
}

function makeScript(companyName: string, agents: unknown[], envLines?: string[]): string {
  const manifest = encodeManifest(agents);
  let script = `#!/bin/bash\n# Agent Company Manifest\nCOMPANY_NAME="${companyName}"\nAGENT_MANIFEST="${manifest}"`;
  if (envLines && envLines.length > 0) {
    script += "\n\n" + envLines.join("\n");
  }
  return script;
}

function makeAgentManifest(options: {
  name: string;
  title?: string;
  skills?: string[];
  body?: string;
}): string {
  const lines = ["---", `name: ${options.name}`];
  if (options.title) {
    lines.push(`title: ${options.title}`);
  }
  if (options.skills && options.skills.length > 0) {
    lines.push("skills:");
    for (const skill of options.skills) {
      lines.push(`  - ${skill}`);
    }
  }
  lines.push("---", options.body ?? `${options.name} instructions`);
  return lines.join("\n");
}

function createCompanyDirectory(basePath: string, agentName = "CEO"): string {
  mkdirSync(basePath, { recursive: true });
  writeFileSync(
    join(basePath, "COMPANY.md"),
    "---\nname: Example Company\n---\nCompany description",
  );

  const agentDir = join(basePath, "agents", "ceo");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "AGENTS.md"),
    makeAgentManifest({
      name: agentName,
      title: "Chief Executive",
      skills: ["executor"],
      body: "Lead the company",
    }),
  );

  return basePath;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("agent-import", () => {
  const tmpDir = join(tmpdir(), "kb-agent-import-test-" + process.pid);
  let createAgentMock: ReturnType<typeof vi.fn>;
  let listAgentsMock: ReturnType<typeof vi.fn>;
  let initMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    createAgentMock = vi.fn();
    listAgentsMock = vi.fn().mockResolvedValue([]);
    initMock = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(AgentStore.prototype, "init").mockImplementation(initMock);
    vi.spyOn(AgentStore.prototype, "listAgents").mockImplementation(listAgentsMock);
    vi.spyOn(AgentStore.prototype, "createAgent").mockImplementation(createAgentMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("reports error on invalid file path", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runAgentImport(join(tmpDir, "nonexistent.sh")),
    ).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("File not found"),
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reports parse error on invalid manifest", async () => {
    const badFile = join(tmpDir, "bad.sh");
    writeFileSync(badFile, "#!/bin/bash\nCOMPANY_NAME=\"test\"\nAGENT_MANIFEST=\"not-valid!!!\"");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runAgentImport(badFile),
    ).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Parse error"),
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("handles empty manifest gracefully", async () => {
    const emptyFile = join(tmpDir, "empty.sh");
    writeFileSync(emptyFile, makeScript("empty-co", []));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(emptyFile);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No agents found"),
    );

    logSpy.mockRestore();
  });

  it("shows dry-run preview without creating agents", async () => {
    const agents: CompaniesShAgent[] = [
      { name: "Preview Agent 1", role: "executor" },
      { name: "Preview Agent 2", role: "reviewer" },
    ];
    const manifestFile = join(tmpDir, "preview.sh");
    writeFileSync(manifestFile, makeScript("preview-co", agents));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(manifestFile, { dryRun: true });

    // Should show DRY RUN prefix
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("[DRY RUN]");
    expect(output).toContain("Preview Agent 1");
    expect(output).toContain("Preview Agent 2");

    logSpy.mockRestore();
  });

  it("creates agents from valid manifest", async () => {
    const agents: CompaniesShAgent[] = [
      { name: "New Agent", role: "executor", metadata: { title: "Test Executor" } },
      { name: "Another Agent", role: "reviewer" },
    ];
    const manifestFile = join(tmpDir, "create.sh");
    writeFileSync(manifestFile, makeScript("test-co", agents));

    const createdAgents: Array<Record<string, unknown>> = [];
    createAgentMock.mockImplementation(async (input: any) => {
      createdAgents.push(input);
      return { id: `agent-${createdAgents.length}`, ...input };
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(manifestFile);

    expect(createAgentMock).toHaveBeenCalledTimes(2);
    expect(createdAgents[0]).toEqual(
      expect.objectContaining({ name: "New Agent", role: "executor", title: "Test Executor" }),
    );
    expect(createdAgents[1]).toEqual(
      expect.objectContaining({ name: "Another Agent", role: "reviewer" }),
    );

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Created: 2");
    expect(output).toContain("New Agent");
    expect(output).toContain("Another Agent");

    logSpy.mockRestore();
  });

  it("skips existing agents with --skip-existing", async () => {
    const agents: CompaniesShAgent[] = [
      { name: "Existing Agent", role: "executor" },
      { name: "New Agent", role: "reviewer" },
    ];
    const manifestFile = join(tmpDir, "skip.sh");
    writeFileSync(manifestFile, makeScript("skip-co", agents));

    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Existing Agent", role: "executor" },
    ]);

    const createdAgents: Array<Record<string, unknown>> = [];
    createAgentMock.mockImplementation(async (input: any) => {
      createdAgents.push(input);
      return { id: `agent-${createdAgents.length}`, ...input };
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(manifestFile, { skipExisting: true });

    // Only the new agent should be created
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createdAgents).toEqual([
      expect.objectContaining({ name: "New Agent", role: "reviewer" }),
    ]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Skipped: 1");

    logSpy.mockRestore();
  });

  it("reports creation errors in summary", async () => {
    const agents: CompaniesShAgent[] = [
      { name: "Good Agent", role: "executor" },
      { name: "Bad Agent", role: "reviewer" },
    ];
    const manifestFile = join(tmpDir, "mixed.sh");
    writeFileSync(manifestFile, makeScript("mixed-co", agents));

    createAgentMock
      .mockResolvedValueOnce({ id: "agent-1", name: "Good Agent" })
      .mockRejectedValueOnce(new Error("Database error"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(manifestFile);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Created: 1");
    expect(output).toContain("Errors: 1");
    expect(output).toContain("Bad Agent");
    expect(output).toContain("Database error");

    logSpy.mockRestore();
  });

  it("imports agents from an Agent Companies directory", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-dir"));

    await runAgentImport(companyDir);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "CEO", role: "executor", title: "Chief Executive" }),
    );
  });

  it("imports agents from a single .md AGENTS manifest", async () => {
    const manifestPath = join(tmpDir, "AGENTS.md");
    writeFileSync(
      manifestPath,
      makeAgentManifest({
        name: "Solo Agent",
        title: "Single File Agent",
        skills: ["reviewer"],
      }),
    );

    await runAgentImport(manifestPath);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Solo Agent", role: "reviewer" }),
    );
  });

  it("imports agents from a .tar.gz archive", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-archive-src"), "Archive CEO");
    const archivePath = join(tmpDir, "company.tar.gz");

    execSync(`tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(companyDir)} .`);

    await runAgentImport(archivePath);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Archive CEO", role: "executor" }),
    );
  });

  it("supports dry-run for directory imports", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-dry-run"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(companyDir, { dryRun: true });

    expect(createAgentMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("[DRY RUN]");
    expect(output).toContain("CEO");

    logSpy.mockRestore();
  });

  it("supports skip-existing for directory imports", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-skip"));
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "CEO", role: "executor" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(companyDir, { skipExisting: true });

    expect(createAgentMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Skipped: 1");
    logSpy.mockRestore();
  });

  it("reports unsupported file formats", async () => {
    const unsupportedPath = join(tmpDir, "manifest.json");
    writeFileSync(unsupportedPath, JSON.stringify({ name: "Not a manifest" }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runAgentImport(unsupportedPath)).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported format"),
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

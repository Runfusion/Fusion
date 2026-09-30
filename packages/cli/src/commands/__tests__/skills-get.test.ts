import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSkillsGet } from "../skills-get.js";
import { COMPUTER_USE_GUIDE_HEADINGS } from "../computer/guide.js";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const builtCli = join(cliRoot, "bin.mjs");

type BuiltCliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runBuiltCli(args: string[], cwd = cliRoot): Promise<BuiltCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtCli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe("fn skills get", () => {
  it("prints the in-process computer-use guide", async () => {
    let output = "";
    await expect(runSkillsGet(["computer-use"], { stdout: (x) => { output += x; } })).resolves.toBe(0);
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(output).toContain(heading);
  });

  it("rejects unknown and missing names with known skills", async () => {
    let errors = "";
    await expect(runSkillsGet(["nope"], { stderr: (x) => { errors += x; } })).resolves.toBe(1);
    expect(errors).toContain("computer-use");
    await expect(runSkillsGet([], { stderr: () => undefined })).resolves.toBe(1);
  });

  it("renders without a guide file or PATH lookup", async () => {
    /*
     * FNXC:ComputerUseSkill 2026-08-11-07:43:
     * Rendering in this process, with no guide markdown in cwd and no PATH, makes this guide belong
     * to the exact binary that will execute computer commands instead of a stale file or other fn.
     */
    const cwd = mkdtempSync(join(tmpdir(), "fn-skills-get-empty-"));
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    let output = "";
    try {
      process.chdir(cwd);
      process.env.PATH = "";
      await expect(runSkillsGet(["computer-use"], { stdout: (text) => { output += text; } })).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(cwd, { recursive: true, force: true });
    }
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(output).toContain(heading);
  });

  it("keeps the get branch free of markdown, network, and child-process sources", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(join(cliRoot, "src", "commands", "skills-get.ts"), "utf8"));
    const branch = source.slice(source.indexOf("export async function runSkillsGet"));
    expect(branch).not.toMatch(/\b(?:readFile|readFileSync|fetch|spawn|exec)\s*\(/);
  });

  it("prints a guide and version from the same built CLI entry point", async () => {
    const guide = await runBuiltCli(["skills", "get", "computer-use"]);
    const version = await runBuiltCli(["--version"]);
    expect(guide).toMatchObject({ code: 0, signal: null });
    expect(version).toMatchObject({ code: 0, signal: null });
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(guide.stdout).toContain(heading);
    expect(guide.stdout).toContain(`# Fusion computer-use guide (v${version.stdout.trim()})`);

    const unknown = await runBuiltCli(["skills", "get", "definitely-not-a-skill"]);
    const missing = await runBuiltCli(["skills", "get"]);
    expect(unknown).toMatchObject({ code: 1, signal: null, stderr: expect.stringContaining("computer-use") });
    expect(missing).toMatchObject({ code: 1, signal: null, stderr: expect.stringContaining("computer-use") });
  });

  it("preserves global flag precedence and validation for built guide requests", async () => {
    const version = await runBuiltCli(["skills", "get", "computer-use", "--version"]);
    expect(version).toMatchObject({ code: 0, signal: null });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = await runBuiltCli(["skills", "get", "computer-use", "--help"]);
    expect(help).toMatchObject({ code: 0, signal: null });
    expect(help.stdout).toContain("fn — AI-orchestrated task board");

    const duplicateProject = await runBuiltCli([
      "skills", "get", "computer-use", "--project", "one", "-P", "two",
    ]);
    expect(duplicateProject).toMatchObject({
      code: 1,
      signal: null,
      stderr: expect.stringContaining("Duplicate --project flag"),
    });
  });

  it("finishes the built guide before cwd bootstrap configuration", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fn-skills-get-bootstrap-"));
    writeFileSync(join(cwd, ".env"), "FUSION_QUIET=1\n");
    try {
      const guide = await runBuiltCli(["skills", "get", "computer-use"], cwd);
      expect(guide).toMatchObject({ code: 0, signal: null });
      expect(guide.stdout).toContain(COMPUTER_USE_GUIDE_HEADINGS[0]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

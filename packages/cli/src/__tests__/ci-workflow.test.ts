import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workspaceRoot = join(import.meta.dirname!, "..", "..", "..", "..");

function loadWorkflow(name: string): any {
  const path = join(workspaceRoot, ".github", "workflows", name);
  const content = readFileSync(path, "utf-8");
  return { content, parsed: parse(content) };
}

describe("CI workflow (.github/workflows/ci.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("ci.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("has push trigger on main", () => {
    expect(workflow.on.push.branches).toContain("main");
  });

  it("has pull_request trigger on main", () => {
    expect(workflow.on.pull_request.branches).toContain("main");
  });

  it("includes pnpm install step", () => {
    expect(content).toContain("pnpm install");
  });

  it("includes pnpm build step", () => {
    expect(content).toContain("pnpm build");
  });

  it("does not include binary build step", () => {
    expect(content).not.toContain("pnpm build:exe");
  });

  it("does not include Bun setup", () => {
    expect(content).not.toContain("oven-sh/setup-bun");
  });

  it("includes pnpm test step", () => {
    expect(content).toContain("pnpm test");
  });
});

describe("Version & Release workflow (.github/workflows/version.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("version.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("has push trigger on main", () => {
    expect(workflow.on.push.branches).toContain("main");
  });

  it("includes pnpm install step", () => {
    expect(content).toContain("pnpm install");
  });

  it("includes pnpm build step", () => {
    expect(content).toContain("pnpm build");
  });

  it("uses changesets/action", () => {
    expect(content).toContain("changesets/action");
  });

  it("has publish command for npm", () => {
    expect(content).toContain("pnpm -r publish");
  });

  it("references NPM_TOKEN secret", () => {
    expect(content).toContain("secrets.NPM_TOKEN");
  });

  it("has required permissions", () => {
    expect(workflow.permissions.contents).toBe("write");
    expect(workflow.permissions["pull-requests"]).toBe("write");
  });

  it("configures npm registry-url", () => {
    const steps = workflow.jobs.release.steps;
    const nodeStep = steps.find((s: any) => s.uses?.includes("actions/setup-node"));
    expect(nodeStep?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
  });
});

describe("Deleted binary workflows", () => {
  it("release.yml no longer exists", () => {
    const path = join(workspaceRoot, ".github", "workflows", "release.yml");
    expect(existsSync(path)).toBe(false);
  });

  it("test-release.yml no longer exists", () => {
    const path = join(workspaceRoot, ".github", "workflows", "test-release.yml");
    expect(existsSync(path)).toBe(false);
  });
});

describe("Code signing — Scripts", () => {
  const scriptsDir = join(workspaceRoot, "scripts");

  it("sign-macos.sh exists and is executable", () => {
    const scriptPath = join(scriptsDir, "sign-macos.sh");
    expect(() => accessSync(scriptPath, constants.F_OK)).not.toThrow();
    expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
  });

  it("sign-windows.ps1 exists", () => {
    const scriptPath = join(scriptsDir, "sign-windows.ps1");
    expect(() => accessSync(scriptPath, constants.F_OK)).not.toThrow();
  });

  it("sign-macos.sh references codesign, notarytool, and security import", () => {
    const script = readFileSync(join(scriptsDir, "sign-macos.sh"), "utf-8");
    expect(script).toContain("codesign");
    expect(script).toContain("notarytool");
    expect(script).toContain("security import");
  });

  it("sign-windows.ps1 references signtool", () => {
    const script = readFileSync(join(scriptsDir, "sign-windows.ps1"), "utf-8");
    expect(script).toContain("signtool");
  });
});

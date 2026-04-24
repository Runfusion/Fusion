import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workspaceRoot = join(import.meta.dirname!, "..", "..", "..", "..");

function loadWorkflow(name: string): any {
  const path = join(workspaceRoot, ".github", "workflows", name);
  const content = readFileSync(path, "utf-8");
  const parsed = parse(content) as Record<string, unknown>;

  // Some YAML parsers treat the unquoted `on:` key as boolean `true`.
  // Normalize it so tests can consistently read `workflow.on`.
  if (parsed && parsed.on === undefined) {
    (parsed as any).on = (parsed as any)["on"] ?? (parsed as any).true ?? (parsed as any)["true"];
  }

  return { content, parsed };
}

describe("CI workflow (.github/workflows/ci.yml)", () => {
  let workflow: any;
  let content: string;
  let ciSteps: any[];
  let contributingContent: string;

  beforeAll(() => {
    const result = loadWorkflow("ci.yml");
    workflow = result.parsed;
    content = result.content;
    ciSteps = workflow.jobs?.ci?.steps ?? [];
    contributingContent = readFileSync(join(workspaceRoot, "docs", "contributing.md"), "utf-8");
  });

  const findStepByRun = (runSnippet: string) => ciSteps.find((step) => typeof step.run === "string" && step.run.includes(runSnippet));

  const findStepIndexByRun = (runSnippet: string) =>
    ciSteps.findIndex((step) => typeof step.run === "string" && step.run.includes(runSnippet));

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("uses workflow_dispatch trigger (auto CI disabled)", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("does not auto-trigger on push/pull_request", () => {
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.pull_request).toBeUndefined();
  });

  it("pins dependency bootstrap to frozen lockfile", () => {
    expect(content).toContain("run: pnpm install --frozen-lockfile");
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
  });

  it("uses verify:workspace as the single lint/test/build contract", () => {
    const verifyStep = findStepByRun("pnpm verify:workspace");
    expect(verifyStep).toBeDefined();
    expect(verifyStep.name).toContain("bootstrap contract");

    const directLintStep = findStepByRun("pnpm lint");
    const directTestStep = findStepByRun("pnpm test");
    const directBuildStep = findStepByRun("pnpm build");
    expect(directLintStep).toBeUndefined();
    expect(directTestStep).toBeUndefined();
    expect(directBuildStep).toBeUndefined();
  });

  it("runs workspace verification before binary packaging", () => {
    const verifyIdx = findStepIndexByRun("pnpm verify:workspace");
    const buildExeIdx = findStepIndexByRun("build:exe");
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(buildExeIdx).toBeGreaterThan(verifyIdx);
  });

  it("keeps contributing docs aligned with the clean-worktree verification contract", () => {
    expect(contributingContent).toContain("pnpm test` must be runnable in a clean worktree without requiring a prior `pnpm build`.");
    expect(contributingContent).toContain("`pnpm verify:workspace` is the canonical pre-merge gate");
    expect(contributingContent).toContain("1. `pnpm lint`");
    expect(contributingContent).toContain("2. `pnpm test`");
    expect(contributingContent).toContain("3. `pnpm build`");
  });

  it("includes binary build step", () => {
    expect(content).toContain("build:exe");
  });

  it("includes Bun setup", () => {
    expect(content).toContain("oven-sh/setup-bun");
  });

  it("verifies binary exists after build", () => {
    expect(content).toContain("test -f packages/cli/dist/fn");
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

  it("uses workflow_dispatch trigger (auto release disabled)", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("does not auto-trigger on push", () => {
    expect(workflow.on.push).toBeUndefined();
  });

  it("pins release bootstrap to frozen lockfile", () => {
    expect(content).toContain("run: pnpm install --frozen-lockfile");
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
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

  it("uses OIDC publishing (no NPM_TOKEN secret)", () => {
    expect(content).not.toContain("secrets.NPM_TOKEN");
    expect(workflow.permissions["id-token"]).toBe("write");
  });

  it("has required permissions", () => {
    expect(workflow.permissions.contents).toBe("write");
    expect(workflow.permissions["pull-requests"]).toBe("write");
  });

  it("has id-token write permission for npm provenance", () => {
    expect(workflow.permissions["id-token"]).toBe("write");
  });

  it("publishes with --provenance flag", () => {
    expect(content).toContain("--provenance");
  });

  it("configures npm registry-url", () => {
    const steps = workflow.jobs.release.steps;
    const nodeStep = steps.find((s: any) => s.uses?.includes("actions/setup-node"));
    expect(nodeStep?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
  });
});

describe("Binary release workflow (.github/workflows/release.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("release.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("uses workflow_dispatch trigger (auto binary release disabled)", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("does not auto-trigger on version tags", () => {
    expect(workflow.on.push).toBeUndefined();
  });

  it("has build-binaries job with 4-target matrix", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    expect(matrix).toHaveLength(4);
    const targets = matrix.map((m: any) => m.target);
    expect(targets).toContain("bun-linux-x64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-darwin-x64");
    expect(targets).toContain("bun-windows-x64");
  });

  it("has correct OS runners for each target", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const osMap: Record<string, string> = {};
    matrix.forEach((m: any) => { osMap[m.target] = m.os; });
    expect(osMap["bun-linux-x64"]).toBe("ubuntu-latest");
    expect(osMap["bun-darwin-arm64"]).toBe("macos-latest");
    expect(osMap["bun-darwin-x64"]).toBe("macos-13");
    expect(osMap["bun-windows-x64"]).toBe("windows-latest");
  });

  it("uses softprops/action-gh-release", () => {
    expect(content).toContain("softprops/action-gh-release");
  });

  it("references signing scripts", () => {
    expect(content).toContain("scripts/sign-macos.sh");
    expect(content).toContain("scripts/sign-windows.ps1");
  });

  it("generates checksums on all platforms", () => {
    expect(content).toContain("sha256sum");
    expect(content).toContain("shasum -a 256");
    expect(content).toContain("Get-FileHash");
  });

  it("has contents: write permission", () => {
    expect(workflow.permissions.contents).toBe("write");
  });

  it("has github-release job that depends on build-binaries", () => {
    expect(workflow.jobs["github-release"].needs).toContain("build-binaries");
  });
});

describe("Test-release workflow (.github/workflows/test-release.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("test-release.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("has workflow_dispatch trigger", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("has 4-target build matrix", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    expect(matrix).toHaveLength(4);
    const targets = matrix.map((m: any) => m.target);
    expect(targets).toContain("bun-linux-x64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-darwin-x64");
    expect(targets).toContain("bun-windows-x64");
  });

  it("includes smoke tests with --help", () => {
    expect(content).toContain("--help");
  });

  it("has signing steps with secret-availability guards", () => {
    expect(content).toContain("APPLE_CERTIFICATE_BASE64 != ''");
    expect(content).toContain("WINDOWS_CERTIFICATE_BASE64 != ''");
  });

  it("uses frozen-lockfile install in every matrix job", () => {
    const matches = content.match(/run:\s*pnpm install --frozen-lockfile/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
  });

  it("uploads artifacts", () => {
    expect(content).toContain("actions/upload-artifact");
  });

  it("has a collect job that combines artifacts", () => {
    expect(workflow.jobs.collect).toBeDefined();
    expect(workflow.jobs.collect.needs).toContain("build-binaries");
    expect(content).toContain("all-binaries");
  });
});

describe("Code signing — Release workflow secrets", () => {
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("release.yml");
    content = result.content;
  });

  it("references macOS signing secrets", () => {
    expect(content).toContain("secrets.APPLE_CERTIFICATE_BASE64");
    expect(content).toContain("secrets.APPLE_CERTIFICATE_PASSWORD");
    expect(content).toContain("secrets.APPLE_IDENTITY");
    expect(content).toContain("secrets.APPLE_ID");
    expect(content).toContain("secrets.APPLE_TEAM_ID");
    expect(content).toContain("secrets.APPLE_APP_PASSWORD");
  });

  it("references Windows signing secrets", () => {
    expect(content).toContain("secrets.WINDOWS_CERTIFICATE_BASE64");
    expect(content).toContain("secrets.WINDOWS_CERTIFICATE_PASSWORD");
  });

  it("generates checksums after signing", () => {
    const signMacIdx = content.indexOf("Sign macOS binary");
    const signWinIdx = content.indexOf("Sign Windows binary");
    const checksumLinuxIdx = content.indexOf("Generate checksum (Linux)");
    const checksumMacIdx = content.indexOf("Generate checksum (macOS)");
    const checksumWinIdx = content.indexOf("Generate checksum (Windows)");

    // All checksum steps come after all signing steps
    expect(checksumLinuxIdx).toBeGreaterThan(signMacIdx);
    expect(checksumLinuxIdx).toBeGreaterThan(signWinIdx);
    expect(checksumMacIdx).toBeGreaterThan(signMacIdx);
    expect(checksumWinIdx).toBeGreaterThan(signWinIdx);
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

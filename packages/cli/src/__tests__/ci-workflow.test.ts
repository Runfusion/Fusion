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
  let buildSteps: any[];
  let testShardJob: any;
  let contributingContent: string;
  let readmeContent: string;
  let cliPackageJsonContent: string;
  let extensionSuiteContent: string;
  let agentExportSuiteContent: string;
  let buildExeSuiteContent: string;

  beforeAll(() => {
    const result = loadWorkflow("ci.yml");
    workflow = result.parsed;
    content = result.content;
    buildSteps = workflow.jobs?.build?.steps ?? [];
    testShardJob = workflow.jobs?.["test-shards"];
    contributingContent = readFileSync(join(workspaceRoot, "docs", "contributing.md"), "utf-8");
    readmeContent = readFileSync(join(workspaceRoot, "README.md"), "utf-8");
    cliPackageJsonContent = readFileSync(join(workspaceRoot, "packages", "cli", "package.json"), "utf-8");
    extensionSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "__tests__", "extension-integration.test.ts"),
      "utf-8",
    );
    agentExportSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "commands", "__tests__", "agent-export.test.ts"),
      "utf-8",
    );
    buildExeSuiteContent = readFileSync(
      join(workspaceRoot, "packages", "cli", "src", "__tests__", "build-exe-cross.test.ts"),
      "utf-8",
    );
  });

  const findBuildStepByRun = (runSnippet: string) =>
    buildSteps.find((step) => typeof step.run === "string" && step.run.includes(runSnippet));

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

  it("uses deterministic test sharding and keeps lint/build as explicit jobs", () => {
    expect(workflow.jobs?.lint).toBeDefined();
    expect(testShardJob).toBeDefined();
    expect(workflow.jobs?.build).toBeDefined();

    expect(testShardJob.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    expect(content).toContain("pnpm test:ci:shard --shard ${{ matrix.shard }} --total 3");
    expect(content).not.toContain("pnpm verify:workspace");
  });

  it("runs build job after lint and sharded tests, then executes slow lane and binary packaging", () => {
    expect(workflow.jobs?.build?.needs).toEqual(["lint", "test-shards"]);
    expect(findBuildStepByRun("pnpm build")).toBeDefined();
    expect(findBuildStepByRun("pnpm test:slow-cli")).toBeDefined();
    expect(findBuildStepByRun("build:exe")).toBeDefined();
  });

  it("keeps contributing docs aligned with verification and slow-lane contracts", () => {
    expect(contributingContent).toContain("pnpm test:full` must be runnable in a clean worktree without requiring a prior `pnpm build`.");
    expect(contributingContent).toContain("`pnpm verify:workspace` is the canonical pre-merge gate");
    expect(contributingContent).toContain("1. `pnpm lint`");
    expect(contributingContent).toContain("2. `pnpm test:full`");
    expect(contributingContent).toContain("3. `pnpm build`");
    expect(contributingContent).toContain("`pnpm test` now uses a changed-only entrypoint");

    expect(contributingContent).toContain("pnpm test:slow-cli");
    expect(contributingContent).toContain("test:pre-release");
    expect(contributingContent).toContain("test:extension-integration");
  });

  it("keeps docs aligned with default and explicit build commands", () => {
    expect(readmeContent).toContain("pnpm build                    # Build default workspace packages (excludes desktop/mobile)");
    expect(readmeContent).toContain("pnpm build:all                # Build all packages (including desktop/mobile)");

    expect(contributingContent).toContain("pnpm build      # default build (excludes desktop/mobile)");
    expect(contributingContent).toContain("pnpm build:all  # full recursive build including desktop/mobile");
  });

  it("includes binary build step", () => {
    expect(content).toContain("build:exe");
  });

  it("keeps explicit gating for audited CLI integration suites", () => {
    expect(cliPackageJsonContent).toContain('"test:slow-cli"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_SLOW_CLI=1");
    expect(cliPackageJsonContent).toContain('"test:extension-integration"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_EXTENSION_INTEGRATION=1");
    expect(cliPackageJsonContent).toContain("extension-integration.test.ts");
    expect(cliPackageJsonContent).toContain('"test:build-exe"');
    expect(cliPackageJsonContent).toContain("FUSION_TEST_BUILD_EXE=1");

    expect(extensionSuiteContent).toContain("describe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)");
    expect(extensionSuiteContent).toContain("FUSION_TEST_EXTENSION_INTEGRATION");
    expect(extensionSuiteContent).toContain("dist/extension.js");

    expect(agentExportSuiteContent).toContain("describe.skipIf(!SHOULD_RUN_SLOW_CLI)");
    expect(agentExportSuiteContent).toContain("FUSION_TEST_SLOW_CLI");

    expect(buildExeSuiteContent).toContain('process.env.FUSION_TEST_BUILD_EXE === "1"');
    expect(buildExeSuiteContent).toContain('process.env.FUSION_TEST_BUILD_EXE === "true"');
    expect(buildExeSuiteContent).not.toContain("Boolean(process.env.FUSION_TEST_BUILD_EXE)");
  });

  it("includes Bun setup", () => {
    expect(content).toContain("oven-sh/setup-bun");
  });

  it("verifies binary exists after build", () => {
    expect(content).toContain("test -f packages/cli/dist/fn");
  });
});

describe("PR checks workflow (.github/workflows/pr-checks.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("pr-checks.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("runs on pull requests targeting main", () => {
    expect(workflow.on?.pull_request?.branches).toContain("main");
  });

  it("uses the same deterministic test sharding command as manual CI", () => {
    expect(workflow.jobs?.lint).toBeDefined();
    expect(workflow.jobs?.typecheck).toBeDefined();
    expect(workflow.jobs?.["test-shards"]).toBeDefined();
    expect(workflow.jobs?.["test-shards"]?.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    expect(content).toContain("pnpm test:ci:shard --shard ${{ matrix.shard }} --total 3");
    expect(content).not.toContain("run: pnpm test\n");
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

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workspaceRoot = join(import.meta.dirname!, "..", "..", "..", "..");

function loadYamlFile(...pathParts: string[]): any {
  const path = join(workspaceRoot, ...pathParts);
  const content = readFileSync(path, "utf-8");
  const parsed = parse(content) as Record<string, unknown>;

  // Some YAML parsers treat the unquoted `on:` key as boolean `true`.
  // Normalize it so tests can consistently read `workflow.on`.
  if (parsed && parsed.on === undefined) {
    (parsed as any).on = (parsed as any)["on"] ?? (parsed as any).true ?? (parsed as any)["true"];
  }

  return { content, parsed };
}

function loadWorkflow(name: string): any {
  return loadYamlFile(".github", "workflows", name);
}

function findCompositeSetupStep(steps: any[]) {
  return steps.find((step) => step.uses === "./.github/actions/setup-node-pnpm");
}

describe("Merge gate (.github/workflows/pr-checks.yml)", () => {
  let workflow: any;
  let content: string;
  let compositeAction: any;
  let contributingContent: string;
  let readmeContent: string;
  let cliPackageJsonContent: string;
  let extensionSuiteContent: string;
  let agentExportSuiteContent: string;
  let buildExeSuiteContent: string;

  beforeAll(() => {
    const result = loadWorkflow("pr-checks.yml");
    workflow = result.parsed;
    content = result.content;
    compositeAction = loadYamlFile(".github", "actions", "setup-node-pnpm", "action.yml").parsed;
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

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("runs on pull requests targeting main and ONLY there", () => {
    expect(workflow.on?.pull_request?.branches).toContain("main");
    // Post-merge signal lives in full-suite.yml; the gate workflow must not
    // double-run on push (that conflates blocking and non-blocking surfaces).
    expect(workflow.on?.push).toBeUndefined();
  });

  it("blocks PRs on exactly lint, typecheck, build, and gate", () => {
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(["build", "gate", "lint", "typecheck"]);
  });

  it("contains no shard matrix or full-suite invocation (demoted to full-suite.yml)", () => {
    expect(workflow.jobs?.["test-shards"]).toBeUndefined();
    expect(workflow.jobs?.["test-slow"]).toBeUndefined();
    expect(workflow.jobs?.["test-inventory-guard"]).toBeUndefined();
    expect(content).not.toContain("test:ci:shard");
    expect(content).not.toContain("run: pnpm test\n");
    expect(content).not.toContain("pnpm verify:workspace");
  });

  it("gate job runs boot smoke and the dedicated test:gate command", () => {
    const gateSteps = workflow.jobs?.gate?.steps ?? [];
    expect(
      gateSteps.some(
        (step: any) => typeof step.run === "string" && step.run.includes("node scripts/boot-smoke.mjs"),
      ),
    ).toBe(true);
    // The gate must use the dedicated command — `pnpm test` routes through
    // scripts/test-changed.mjs whose selection semantics are for local runs.
    expect(
      gateSteps.some(
        (step: any) => typeof step.run === "string" && step.run.includes("pnpm test:gate"),
      ),
    ).toBe(true);
  });

  it("pins dependency bootstrap to frozen lockfile in every job", () => {
    for (const jobName of ["lint", "typecheck", "build", "gate"]) {
      expect(findCompositeSetupStep(workflow.jobs?.[jobName]?.steps ?? [])).toBeDefined();
    }
    expect(content).not.toContain("run: pnpm install\n");
    expect(content).not.toContain("--no-frozen-lockfile");
    expect(compositeAction.inputs?.["install-args"]?.default).toBe("--frozen-lockfile");
  });

  it("keeps lint as install + lint only, without Bun/setup build coupling", () => {
    const lintSteps = workflow.jobs?.lint?.steps ?? [];
    expect(
      lintSteps.some(
        (step: any) =>
          typeof step.uses === "string" && step.uses.includes("./.github/actions/setup-node-pnpm"),
      ),
    ).toBe(true);
    expect(
      lintSteps.some((step: any) => step.name === "Lint" && typeof step.run === "string" && step.run.includes("pnpm lint")),
    ).toBe(true);
    expect(
      lintSteps.some(
        (step: any) =>
          step.name === "Install Bun" ||
          (typeof step.uses === "string" && step.uses.includes("oven-sh/setup-bun")) ||
          (typeof step.run === "string" && step.run.includes("pnpm build")),
      ),
    ).toBe(false);
  });

  it("keeps build coverage as an explicit PR gate", () => {
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    expect(
      buildSteps.some(
        (step: any) =>
          step.name === "Install Bun" ||
          (typeof step.uses === "string" && step.uses.includes("oven-sh/setup-bun")),
      ),
    ).toBe(true);
    expect(
      buildSteps.some(
        (step: any) => step.name === "Build" && typeof step.run === "string" && step.run.includes("pnpm build"),
      ),
    ).toBe(true);
  });

  it("keeps contributing docs aligned with the gate contract", () => {
    expect(contributingContent).toContain("pnpm test:full` must be runnable in a clean worktree without requiring a prior `pnpm build`.");
    expect(contributingContent).toContain("`pnpm test:gate` is the merge gate");
    expect(contributingContent).toContain("`pnpm verify:workspace` is the deep opt-in verification (not the merge gate)");
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

  it("the deleted manual CI workflow stays deleted", () => {
    // ci.yml was the trigger-disabled (FN-1541) 3-shard manual workflow; the
    // merge-gate redesign removed it. Reintroducing it would resurrect a
    // second, drift-prone definition of the test pipeline.
    expect(() => loadWorkflow("ci.yml")).toThrow();
  });
});

describe("Full suite workflow (.github/workflows/full-suite.yml)", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("full-suite.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("is valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("runs ONLY on push to main — never as a PR gate", () => {
    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on?.pull_request).toBeUndefined();
  });

  it("carries the demoted tier: 4-way shards, engine slow, inventory guard", () => {
    expect(workflow.jobs?.["test-shards"]?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(content).toContain("pnpm test:ci:shard --shard ${{ matrix.shard }} --total 4");
    expect(workflow.jobs?.["test-slow"]).toBeDefined();
    expect(workflow.jobs?.["test-inventory-guard"]).toBeDefined();
  });

  it("keeps full clones where real-git tests need history", () => {
    const shardSteps = workflow.jobs?.["test-shards"]?.steps ?? [];
    const slowSteps = workflow.jobs?.["test-slow"]?.steps ?? [];
    for (const steps of [shardSteps, slowSteps]) {
      expect(
        steps.some((step: any) => step.uses?.includes("actions/checkout") && step.with?.["fetch-depth"] === 0),
      ).toBe(true);
    }
  });

  it("still uploads per-shard timing artifacts for snapshot refresh", () => {
    expect(content).toContain("test-timings-shard-${{ matrix.shard }}");
  });

  it("does not spend action minutes on a pre-test workspace build", () => {
    const testSteps = workflow.jobs?.["test-shards"]?.steps ?? [];
    expect(
      testSteps.some(
        (step: any) => step.name === "Build" || (typeof step.run === "string" && step.run.includes("pnpm build")),
      ),
    ).toBe(false);
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
    const compositeStep = findCompositeSetupStep(steps);
    expect(compositeStep?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
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

  it("supports workflow_dispatch and version tag triggers", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).toHaveProperty("push");
  });

  it("auto-triggers on v* version tags", () => {
    expect(workflow.on.push.tags).toContain("v*");
  });

  it("has build-binaries job with 4-target matrix", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    expect(matrix).toHaveLength(4);
    const targets = matrix.map((m: any) => m.target);
    expect(targets).toContain("bun-linux-x64");
    expect(targets).toContain("bun-linux-arm64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-windows-x64");
    // bun-darwin-x64 dropped: macos-13 runner scarcity; CLI is Apple-Silicon-only.
    expect(targets).not.toContain("bun-darwin-x64");
  });

  it("has correct OS runners for each target", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const osMap: Record<string, string> = {};
    matrix.forEach((m: any) => { osMap[m.target] = m.os; });
    expect(osMap["bun-linux-x64"]).toBe("ubuntu-latest");
    expect(osMap["bun-linux-arm64"]).toBe("ubuntu-24.04-arm");
    expect(osMap["bun-darwin-arm64"]).toBe("macos-latest");
    expect(osMap["bun-windows-x64"]).toBe("windows-latest");
  });

  it("maps bun-linux-arm64 to fn-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-linux-arm64");
  });

  it("uses softprops/action-gh-release", () => {
    expect(content).toContain("softprops/action-gh-release");
  });

  it("uses frozen-lockfile install in every matrix job", () => {
    const steps = workflow.jobs["build-binaries"].steps ?? [];
    const setupSteps = steps.filter((step: any) => step.uses === "./.github/actions/setup-node-pnpm");

    const hasValidCompositeSetup = setupSteps.some((step: any) => {
      const installArgs = step.with?.["install-args"];
      return installArgs === undefined || String(installArgs).trim() === "--frozen-lockfile";
    });

    const hasInlineFrozenInstall = steps.some((step: any) =>
      typeof step.run === "string" && /\bpnpm install --frozen-lockfile\b/.test(step.run),
    );

    expect(hasValidCompositeSetup || hasInlineFrozenInstall).toBe(true);

    for (const step of setupSteps) {
      const installArgs = step.with?.["install-args"];
      if (installArgs !== undefined) {
        expect(String(installArgs).trim()).toBe("--frozen-lockfile");
      }
    }

    expect(content).not.toMatch(/run:\s*pnpm install\s*(?:\r?\n)/);
    expect(content).not.toContain("--no-frozen-lockfile");
    expect(content).not.toMatch(/install-args:\s*["']?\s*["']?\s*(?:\r?\n)/);
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
    expect(targets).toContain("bun-linux-arm64");
    expect(targets).toContain("bun-darwin-arm64");
    expect(targets).toContain("bun-windows-x64");
    // bun-darwin-x64 dropped: macos-13 runner scarcity; CLI is Apple-Silicon-only.
    expect(targets).not.toContain("bun-darwin-x64");
  });

  it("maps bun-linux-arm64 to fn-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-linux-arm64");
  });

  it("includes smoke tests with --help", () => {
    expect(content).toContain("--help");
  });

  it("has signing steps with secret-availability guards", () => {
    expect(content).toContain("APPLE_CERTIFICATE_BASE64 != ''");
    expect(content).toContain("WINDOWS_CERTIFICATE_BASE64 != ''");
  });

  it("uses frozen-lockfile install in every matrix job", () => {
    const steps = workflow.jobs["build-binaries"].steps ?? [];
    const compositeStep = findCompositeSetupStep(steps);
    expect(compositeStep).toBeDefined();
    expect(compositeStep.with?.["install-args"] ?? "--frozen-lockfile").toBe("--frozen-lockfile");
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

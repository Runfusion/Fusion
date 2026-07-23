import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, accessSync, constants, existsSync, readdirSync } from "node:fs";
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

function findSetupJavaStep(steps: any[]) {
  return steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-java@"));
}

function resolveCapacitorAndroidGradlePath(): string {
  const primaryPath = join(
    workspaceRoot,
    "packages",
    "mobile",
    "node_modules",
    "@capacitor",
    "android",
    "capacitor",
    "build.gradle",
  );
  if (existsSync(primaryPath)) {
    return primaryPath;
  }

  const pnpmStoreCandidates = [
    join(workspaceRoot, "node_modules", ".pnpm"),
    join(workspaceRoot, "packages", "mobile", "node_modules", ".pnpm"),
  ];

  for (const pnpmStore of pnpmStoreCandidates) {
    if (!existsSync(pnpmStore)) {
      continue;
    }

    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith("@capacitor+android@")) {
        continue;
      }

      const candidate = join(
        pnpmStore,
        entry,
        "node_modules",
        "@capacitor",
        "android",
        "capacitor",
        "build.gradle",
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Unable to resolve @capacitor/android capacitor/build.gradle from packages/mobile/node_modules or the pnpm store",
  );
}

function readCapacitorAndroidSourceCompatibilityMajor(): number {
  const gradleContent = readFileSync(resolveCapacitorAndroidGradlePath(), "utf-8");
  const match = gradleContent.match(/sourceCompatibility\s+JavaVersion\.VERSION_(\d+)/);
  if (!match) {
    throw new Error("Unable to parse @capacitor/android sourceCompatibility JavaVersion.VERSION_<major>");
  }
  return Number.parseInt(match[1], 10);
}

function expectAndroidBuildJobJavaVersionAtLeast(workflow: any, workflowName: string, minimumJavaVersion: number) {
  const buildAndroidJob = workflow.jobs?.["build-android"];
  expect(buildAndroidJob, `${workflowName} must define a build-android job`).toBeDefined();

  const setupJavaStep = findSetupJavaStep(buildAndroidJob?.steps ?? []);
  expect(setupJavaStep, `${workflowName} build-android must provision Java`).toBeDefined();
  expect(setupJavaStep.name).toBe("Setup Java 21");

  const javaVersion = setupJavaStep.with?.["java-version"];
  expect(javaVersion, `${workflowName} build-android must pin JDK 21`).toBe("21");
  expect(Number.parseInt(javaVersion, 10), `${workflowName} JDK must satisfy @capacitor/android sourceCompatibility`).toBeGreaterThanOrEqual(
    minimumJavaVersion,
  );
}

describe("Merge gate (.github/workflows/pr-checks.yml)", () => {
  let workflow: any;
  let content: string;
  let compositeAction: any;
  let contributingContent: string;
  let readmeContent: string;
  let rootPackageJson: any;
  let enginePackageJson: any;
  let cliPackageJsonContent: string;
  let engineVitestConfigContent: string;
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
    rootPackageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf-8"));
    enginePackageJson = JSON.parse(readFileSync(join(workspaceRoot, "packages", "engine", "package.json"), "utf-8"));
    cliPackageJsonContent = readFileSync(join(workspaceRoot, "packages", "cli", "package.json"), "utf-8");
    engineVitestConfigContent = readFileSync(join(workspaceRoot, "packages", "engine", "vitest.config.ts"), "utf-8");
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

  /*
  FNXC:CIGateSpeed 2026-07-22-23:30:
  The Gate job's dist cache is INCREMENTAL (`gate-dist-*` with restore-keys), which is only
  safe because `pnpm build` always runs after restore and reconciles a near-match restore via
  the content-hash skip cache (.fusion/cache/plugin-build-cache.json, cached alongside dist).
  Pin the coupled invariants so no future edit keeps restore-keys while dropping the build
  (stale-dist FN-4232/FN-4605), drops the hash-cache path (full rebuild every run), or lets
  the exact-hit-only seed step fire on a near-hit restore.
  */
  it("gate dist cache is incremental and reconciled by a mandatory build", () => {
    const gateSteps = workflow.jobs?.gate?.steps ?? [];
    const cacheStep = gateSteps.find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(cacheStep).toBeDefined();
    expect(cacheStep.with?.key).toContain("gate-dist-");
    expect(cacheStep.with?.["restore-keys"]).toContain("gate-dist-");
    expect(cacheStep.with?.path).toContain(".fusion/cache/plugin-build-cache.json");
    expect(cacheStep.with?.path).toContain("packages/cli/dist");
    expect(cacheStep.with?.path).not.toContain("node_modules");

    // restore-keys is only safe with the reconciling build; the build must run
    // AFTER the cache restore and BEFORE boot smoke / gate tests.
    const buildIndex = gateSteps.findIndex(
      (step: any) => step.name === "Build" && typeof step.run === "string" && step.run.includes("pnpm build"),
    );
    expect(buildIndex).toBeGreaterThan(gateSteps.indexOf(cacheStep));
    const smokeIndex = gateSteps.findIndex(
      (step: any) => typeof step.run === "string" && step.run.includes("boot-smoke.mjs"),
    );
    expect(smokeIndex).toBeGreaterThan(buildIndex);

    // Fast CLI packaging in the gate (verify:fast shape); the blocking Build
    // job keeps full CI packaging coverage.
    expect(gateSteps[buildIndex].env?.FUSION_CLI_FULL_PACKAGE).toBe("0");

    // The mtime-defeating seed must stay exact-hit-only: on a near-hit restore
    // the dist is stale for changed packages until the build reconciles it.
    const seedStep = gateSteps.find(
      (step: any) => typeof step.run === "string" && step.run.includes("--seed-artifact-cache"),
    );
    expect(seedStep?.if).toContain("cache-hit == 'true'");
  });

  /*
  FNXC:CITestGate 2026-06-26-06:40:
  The merge gate is the thin trusted CI surface. ci-workflow.test.ts must pin not only that the Gate job invokes `pnpm test:gate`, but also test:gate's internal composition (guards + engine test:core + cli test:ci-shape) and that engine test:core references the engine-core vitest project — otherwise a rename could hollow the gate while this CI-shape test stays green (FN-7059).
  */
  it("pins test:gate to the audited guard scripts and curated suites", () => {
    const testGateScript = rootPackageJson.scripts?.["test:gate"] ?? "";

    expect(testGateScript).toContain("node scripts/check-no-" + "no" + "hup" + ".mjs"); // process-supervisor-allowlist: asserts the gate wires the checker; not a real spawn
    expect(testGateScript).toContain("node scripts/check-no-kill-" + "40" + "40" + ".mjs"); // port-4040-allowlist: asserts the gate wires the checker; not a real port bind
    expect(testGateScript).toContain("node scripts/check-no-test-timeout-appeasement.mjs");
    expect(testGateScript).toContain("node scripts/check-changeset-format.mjs");
    expect(testGateScript).toContain("pnpm --filter @fusion/engine test:core");
    expect(testGateScript).toContain("pnpm --filter @fusion/core test:pg-gate");
    expect(testGateScript).toContain("pnpm --filter @runfusion/fusion test:ci-shape");
  });

  it("pins engine test:core to the engine-core vitest project", () => {
    expect(enginePackageJson.scripts?.["test:core"] ?? "").toContain("--project=engine-core");
    expect(engineVitestConfigContent).toContain('name: "engine-core"');
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

  it("keeps build coverage as an explicit Node/pnpm PR gate", () => {
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    expect(findCompositeSetupStep(buildSteps)).toBeDefined();
    expect(
      buildSteps.some(
        (step: any) =>
          step.name === "Install Bun" ||
          (typeof step.uses === "string" && step.uses.includes("oven-sh/setup-bun")),
      ),
    ).toBe(false);
    expect(
      buildSteps.some(
        (step: any) => step.name === "Build" && typeof step.run === "string" && step.run.includes("pnpm build"),
      ),
    ).toBe(true);
  });

  /*
  FNXC:CIGateSpeed 2026-07-23-00:05:
  The Build job taps the gate's incremental dist cache RESTORE-ONLY: it runs full CLI
  packaging (CI=true), and saving that shape would swap the cache's canonical fast-CLI
  contents out from under the Gate job. Pin restore-only, path parity with the gate block,
  and that the Build step does NOT opt out of full CLI packaging (that coverage is this
  job's distinctive value — ensureFullPackageCliPlanned force-plans the CLI in full mode
  regardless of cache state).
  */
  it("build job restores the gate dist cache without saving and keeps full CLI packaging", () => {
    const buildSteps = workflow.jobs?.build?.steps ?? [];
    const restoreStep = buildSteps.find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(restoreStep).toBeDefined();
    expect(restoreStep.uses).toContain("actions/cache/restore");
    expect(restoreStep.with?.key).toContain("gate-dist-");
    expect(restoreStep.with?.["restore-keys"]).toContain("gate-dist-");

    const gateCache = (workflow.jobs?.gate?.steps ?? []).find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(restoreStep.with?.path).toBe(gateCache?.with?.path);

    const buildStep = buildSteps.find(
      (step: any) => step.name === "Build" && typeof step.run === "string" && step.run.includes("pnpm build"),
    );
    expect(buildStep).toBeDefined();
    expect(buildStep.env?.FUSION_CLI_FULL_PACKAGE).toBeUndefined();
    expect(buildSteps.indexOf(buildStep)).toBeGreaterThan(buildSteps.indexOf(restoreStep));
  });

  /*
  FNXC:CIGateSpeed 2026-07-23-00:05:
  Typecheck caches tsc incremental buildinfo. Restored buildinfo is self-validating (tsc
  re-checks every input that changed), so restore-keys is correctness-neutral. The cache
  only works if the dashboard's TWO typecheck programs (tsconfig.json + tsconfig.app.json)
  keep DISTINCT tsBuildInfoFile paths — both inherit ${configDir}/dist/.tsbuildinfo from
  tsconfig.base.json otherwise and clobber each other, silently re-checking the full
  program every run. Pin the cache shape and the distinct app buildinfo path together.
  */
  it("typecheck job caches self-validating tsc buildinfo with distinct dashboard paths", () => {
    const typecheckSteps = workflow.jobs?.typecheck?.steps ?? [];
    const cacheStep = typecheckSteps.find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(cacheStep).toBeDefined();
    expect(cacheStep.with?.key).toContain("typecheck-tsbuildinfo-");
    expect(cacheStep.with?.["restore-keys"]).toContain("typecheck-tsbuildinfo-");
    expect(cacheStep.with?.path).toContain("packages/*/dist/.tsbuildinfo");
    expect(cacheStep.with?.path).toContain("packages/dashboard/dist/.tsbuildinfo-app");
    expect(cacheStep.with?.path).toContain("plugins/*/dist/.tsbuildinfo");

    const typecheckIndex = typecheckSteps.findIndex(
      (step: any) => typeof step.run === "string" && step.run.includes("pnpm typecheck"),
    );
    expect(typecheckIndex).toBeGreaterThan(typecheckSteps.indexOf(cacheStep));

    const appTsconfig = readFileSync(join(workspaceRoot, "packages", "dashboard", "tsconfig.app.json"), "utf-8");
    expect(appTsconfig).toContain('.tsbuildinfo-app');
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

  /*
  FNXC:CIGateSpeed 2026-07-22-23:30:
  Caches saved on a PR merge ref are invisible to other PRs, so the gate's
  incremental `gate-dist-*` cache must be warmed from main or every PR's first
  gate run builds cold. Pin the warm job's existence AND that its cache path
  list is byte-identical to the Gate job's — actions/cache versions caches by
  path list, so a drifted list silently makes the warm cache unrestorable.
  */
  it("warms the gate build cache from main with a path list identical to the gate's", () => {
    const warmSteps = workflow.jobs?.["warm-gate-build-cache"]?.steps ?? [];
    const warmCache = warmSteps.find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(warmCache).toBeDefined();
    expect(warmCache.with?.key).toContain("gate-dist-");
    expect(warmCache.with?.["restore-keys"]).toContain("gate-dist-");

    const gateWorkflow = loadWorkflow("pr-checks.yml").parsed;
    const gateCache = (gateWorkflow.jobs?.gate?.steps ?? []).find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(warmCache.with?.path).toBe(gateCache?.with?.path);
    expect(warmCache.with?.key).toBe(gateCache?.with?.key);

    // The warm job must actually build (that is what populates dist + the
    // content-hash cache), in the gate's fast-CLI-packaging shape.
    const warmBuild = warmSteps.find(
      (step: any) => typeof step.run === "string" && step.run.includes("pnpm build"),
    );
    expect(warmBuild).toBeDefined();
    expect(warmBuild.env?.FUSION_CLI_FULL_PACKAGE).toBe("0");
  });

  /*
  FNXC:CIGateSpeed 2026-07-23-00:05:
  The warm job also warms the Typecheck job's tsc buildinfo cache (PR caches are
  invisible to other PRs, so main must seed first-run PRs). Path parity with the
  Typecheck job's block is load-bearing for the same actions/cache versioning reason
  as the dist cache.
  */
  it("warms the typecheck buildinfo cache from main with a path list identical to the typecheck job's", () => {
    const warmSteps = workflow.jobs?.["warm-gate-build-cache"]?.steps ?? [];
    const warmTsCache = warmSteps.find(
      (step: any) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/cache") &&
        typeof step.with?.key === "string" &&
        step.with.key.includes("typecheck-tsbuildinfo-"),
    );
    expect(warmTsCache).toBeDefined();
    expect(warmTsCache.with?.["restore-keys"]).toContain("typecheck-tsbuildinfo-");

    const gateWorkflow = loadWorkflow("pr-checks.yml").parsed;
    const typecheckCache = (gateWorkflow.jobs?.typecheck?.steps ?? []).find(
      (step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
    );
    expect(warmTsCache.with?.path).toBe(typecheckCache?.with?.path);
    expect(warmTsCache.with?.key).toBe(typecheckCache?.with?.key);

    const warmTypecheck = warmSteps.find(
      (step: any) => typeof step.run === "string" && step.run.includes("pnpm typecheck"),
    );
    expect(warmTypecheck).toBeDefined();
    expect(warmSteps.indexOf(warmTypecheck)).toBeGreaterThan(warmSteps.indexOf(warmTsCache));
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

describe("Android build JDK compatibility", () => {
  let capacitorAndroidSourceCompatibility: number;

  beforeAll(() => {
    capacitorAndroidSourceCompatibility = readCapacitorAndroidSourceCompatibilityMajor();
  });

  /*
  FNXC:MobileAndroidBuild 2026-06-28-00:00:
  Android CI jobs that run Capacitor Gradle builds must provision a JDK version greater than or equal to @capacitor/android's sourceCompatibility. FN-7209 proved JDK 17 silently drifted below Capacitor 7's JavaVersion.VERSION_21 requirement and failed release builds with `invalid source release: 21`.
  */
  it("pins every Android-building workflow to a JDK compatible with Capacitor", () => {
    for (const workflowName of ["release.yml", "test-release.yml", "mobile.yml"]) {
      const workflow = loadWorkflow(workflowName).parsed;
      expectAndroidBuildJobJavaVersionAtLeast(workflow, workflowName, capacitorAndroidSourceCompatibility);
    }
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

  it("maps bun-linux-arm64 to fn-cli-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-cli-linux-arm64");
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

  it("has github-release job that depends on binary and Android builds", () => {
    expect(workflow.jobs["github-release"].needs).toContain("build-binaries");
    expect(workflow.jobs["github-release"].needs).toContain("build-android");
  });

  it("wires signed Android AAB artifacts into release aggregation", () => {
    const androidJob = workflow.jobs["build-android"];
    const collectStep = workflow.jobs["github-release"].steps.find((step: any) => step.name === "Collect release files");

    expect(androidJob.env.ANDROID_KEYSTORE_BASE64).toBe("${{ secrets.ANDROID_KEYSTORE_BASE64 }}");
    expect(content).toContain("./gradlew assembleRelease bundleRelease");
    expect(content).toContain("fusion-android-release.aab");
    expect(collectStep.run).toContain('-name "*.apk"');
    expect(collectStep.run).toContain('-name "*.aab"');
    expect(collectStep.run).toContain('-name "*.sha256"');
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

  it("maps bun-linux-arm64 to fn-cli-linux-arm64 binary name", () => {
    const matrix = workflow.jobs["build-binaries"].strategy.matrix.include;
    const arm64Entry = matrix.find((m: any) => m.target === "bun-linux-arm64");
    expect(arm64Entry?.binary).toBe("fn-cli-linux-arm64");
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

  it("has a collect job that combines binary and Android artifacts", () => {
    expect(workflow.jobs.collect).toBeDefined();
    expect(workflow.jobs.collect.needs).toContain("build-binaries");
    expect(workflow.jobs.collect.needs).toContain("build-android");
    expect(content).toContain("all-binaries");
  });

  it("wires signed Android AAB artifacts into rehearsal aggregation", () => {
    const androidJob = workflow.jobs["build-android"];
    const combineStep = workflow.jobs.collect.steps.find((step: any) => step.name === "Combine artifacts");

    expect(androidJob.env.ANDROID_KEYSTORE_BASE64).toBe("${{ secrets.ANDROID_KEYSTORE_BASE64 }}");
    expect(content).toContain("./gradlew assembleRelease bundleRelease");
    expect(content).toContain("fusion-android-release.aab");
    expect(combineStep.run).toContain('-name "*.apk"');
    expect(combineStep.run).toContain('-name "*.aab"');
    expect(combineStep.run).toContain('-name "*.sha256"');
  });
});

describe("Cross-platform agent-browser install workflow", () => {
  let workflow: any;
  let content: string;

  beforeAll(() => {
    const result = loadWorkflow("agent-browser-install.yml");
    workflow = result.parsed;
    content = result.content;
  });

  it("runs packed consumer installs on Windows, Linux, and macOS for relevant pull requests", () => {
    expect(workflow.on?.pull_request?.branches).toContain("main");
    expect(workflow.on?.pull_request?.paths).toContain(".github/workflows/agent-browser-install.yml");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/agent-browser.mjs");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/package.json");
    expect(workflow.on?.pull_request?.paths).toContain("packages/cli/scripts/prepare-publish-manifest.mjs");
    const packFixture = workflow.jobs?.["pack-fixture"];
    const installSmoke = workflow.jobs?.["install-smoke"];
    expect(packFixture?.["runs-on"]).toBe("ubuntu-latest");
    expect(findCompositeSetupStep(packFixture?.steps ?? [])?.with?.["skip-install"]).toBe("true");
    expect(installSmoke?.needs).toBe("pack-fixture");
    expect(installSmoke?.["runs-on"]).toBe("${{ matrix.os }}");
    expect(installSmoke?.strategy?.matrix?.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(findCompositeSetupStep(installSmoke?.steps ?? [])).toBeUndefined();
  });

  it("executes npm's generated platform shim and checks the matching native executable", () => {
    expect(content).toContain("pnpm pack --pack-destination");
    expect(content).toContain('dependencies["agent-browser"]');
    expect(content).toContain("agent-browser-version.txt");
    expect(content).toContain("actions/upload-artifact@v4");
    expect(content).toContain("actions/download-artifact@v4");
    expect(content).toContain("Packed Fusion manifest lost the exact agent-browser pin");
    expect(content).toContain("Packed Fusion manifest lost the agent-browser bin");
    expect(content).toContain("Packed Fusion tarball omitted agent-browser.mjs");
    expect(content).toContain("npm install --ignore-scripts --no-audit --no-fund --install-strategy=nested");
    expect(content).toContain('$shimName = if ($IsWindows) { "agent-browser.cmd" } else { "agent-browser" }');
    expect(content).toContain('"node_modules/.bin/$shimName"');
    expect(content).toContain("& $shim --version");
    expect(content).toContain("does not match declared pin");
    expect(content).toContain("Missing native executable:");
    expect(content).toContain("process.platform + '-' + process.arch");
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

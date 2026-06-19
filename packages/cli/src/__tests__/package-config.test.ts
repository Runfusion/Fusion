import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { parse } from "yaml";
import { applyPrepackTransform } from "../../scripts/prepare-publish-manifest.mjs";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");

function loadPackageJson(packageDir: string): any {
  const path = join(workspaceRoot, "packages", packageDir, "package.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadWorkflowYaml(name: string): any {
  const path = join(workspaceRoot, ".github", "workflows", name);
  const content = readFileSync(path, "utf-8");
  return parse(content);
}

function loadRootPackageJson(): any {
  const path = join(workspaceRoot, "package.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadCliPrepackScript(): string {
  const path = join(workspaceRoot, "packages", "cli", "scripts", "prepare-publish-manifest.mjs");
  return readFileSync(path, "utf-8");
}

function hasProjectArg(script: string | undefined, project: string): boolean {
  const parts = script?.trim().split(/\s+/) ?? [];
  return parts.some((part, index) => part === "--project" && parts[index + 1] === project);
}

function assertRuntimeDepsAreNotOptionalPeers(pkg: any, label: string): void {
  const dependencies = pkg.dependencies ?? {};
  const peerDependencies = pkg.peerDependencies ?? {};
  const peerDependenciesMeta = pkg.peerDependenciesMeta ?? {};

  for (const dependencyName of Object.keys(dependencies)) {
    expect(
      peerDependenciesMeta[dependencyName]?.optional,
      `${label}: runtime dependency "${dependencyName}" must not also be an optional peer; npm/pnpm may omit it from clean standalone installs.`,
    ).not.toBe(true);
  }

  for (const dependencyName of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
    expect(dependencies, `${label}: ${dependencyName} must remain a required runtime dependency`).toHaveProperty(
      dependencyName,
      "^0.79.1",
    );
    expect(peerDependencies, `${label}: ${dependencyName} must not be a peer dependency`).not.toHaveProperty(
      dependencyName,
    );
    expect(peerDependenciesMeta, `${label}: ${dependencyName} must not have peer metadata`).not.toHaveProperty(
      dependencyName,
    );
  }

  expect(dependencies, `${label}: typebox must not be promoted into runtime dependencies`).not.toHaveProperty(
    "typebox",
  );
  expect(peerDependencies, `${label}: typebox remains the optional peer control`).toHaveProperty(
    "typebox",
    "*",
  );
  expect(peerDependenciesMeta.typebox, `${label}: typebox remains optional peer metadata`).toEqual({
    optional: true,
  });
}

describe("CLI package.json publishing config", () => {
  const pkg = loadPackageJson("cli");
  const prepackScript = loadCliPrepackScript();

  it('has "bin" field with fn/fusion pointing to committed launcher', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.fn).toBe("./bin.mjs");
    expect(pkg.bin.fusion).toBe("./bin.mjs");
  });

  it('has "files" array with committed launcher and refined globs for dist output', () => {
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("bin.mjs");
    expect(pkg.files).toContain("dist/**/*.js");
    expect(pkg.files).toContain("dist/**/*.d.ts");
    expect(pkg.files).toContain("dist/**/*.d.ts.map");
    expect(pkg.files).toContain("dist/**/*.js.map");
    expect(pkg.files).toContain("dist/client/**");
    expect(pkg.files).toContain("README.md");
  });

  it("does not include bare 'dist' entry or globs that would match Bun binaries", () => {
    const bunBinaryNames = [
      "fn",
      "fn-linux-x64",
      "fn-linux-arm64",
      "fn-darwin-x64",
      "fn-darwin-arm64",
      "fn-windows-x64.exe",
    ];
    // No bare "dist" entry that would include everything
    expect(pkg.files).not.toContain("dist");
    // No glob that explicitly targets Bun binaries
    for (const entry of pkg.files) {
      for (const bin of bunBinaryNames) {
        expect(entry).not.toBe(`dist/${bin}`);
      }
      // No wildcard like "dist/fn*" that would match binaries
      expect(entry).not.toMatch(/^dist\/fn/);
    }
  });

  it("excludes runtime directory from npm package (GitHub Releases only)", () => {
    // Runtime assets are for standalone binaries distributed via GitHub Releases
    // npm package should not include them (users install via npm get node-pty naturally)
    for (const entry of pkg.files) {
      expect(entry).not.toContain("runtime");
      expect(entry).not.toMatch(/dist\/runtime/);
    }
  });

  it("is not private", () => {
    expect(pkg.private).not.toBe(true);
  });

  it("declares ioredis as a runtime dependency for badge pub/sub", () => {
    const deps = Object.keys(pkg.dependencies || {});
    expect(deps).toContain("ioredis");
  });

  /**
   * FNXC:Packaging 2026-06-13-16:36:
   * Standalone npm/pnpm installs may omit a package when the published manifest declares it as both a runtime dependency and an optional peer. Keep the pi runtime packages as plain dependencies so dist/bin.js and dist/extension.js can resolve their static imports outside the monorepo, while leaving typebox as the optional-peer control because Fusion does not import it at runtime.
   */
  it("does not declare runtime dependencies as optional peers in source or published manifests", () => {
    assertRuntimeDepsAreNotOptionalPeers(pkg, "source manifest");
    assertRuntimeDepsAreNotOptionalPeers(applyPrepackTransform(pkg), "published manifest");
  });

  it("defines test:docs-index as a single-file docs README index lane", () => {
    const script = pkg.scripts?.["test:docs-index"];
    const parts = script?.trim().split(/\s+/) ?? [];
    const docsIndexPath = "src/__tests__/docs-readme-index.test.ts";

    expect(script).toBeDefined();
    expect(script).toContain("vitest run");
    expect(parts).toEqual([
      "vitest",
      "run",
      docsIndexPath,
      "--silent=passed-only",
      "--reporter=dot",
    ]);
    expect(parts.filter((part) => part.endsWith(".test.ts"))).toEqual([docsIndexPath]);
    expect(parts).not.toContain("--");
    expect(script).not.toMatch(/vitest\s+run\s+(?:--silent=passed-only\s+)?(?:--reporter=dot\s+)?$/);
    expect(script).not.toContain("docs-readme-index ");
  });

  it("prepack manifest rewrite strips workspace-only plugin/tooling devDependencies", () => {
    expect(prepackScript).toContain('delete devDependencies["@fusion/pi-claude-cli"]');
    expect(prepackScript).toContain('delete devDependencies["@fusion/pi-llama-cpp"]');
    expect(prepackScript).toContain('delete devDependencies["@fusion-plugin-examples/roadmap"]');
  });

  // Generalized guard derived from tsup.config.ts. Any non-builtin module
  // marked `external` MUST be a runtime dep (so `npm install @runfusion/fusion`
  // can resolve it after publish), and any module pulled in via `noExternal`
  // (i.e. inlined into the bundle) MUST NOT leak into runtime deps.
  // pnpm hoisting masks the missing-dep case in the workspace, so a hardcoded
  // allowlist isn't enough — this iterates the live config instead.
  describe("tsup external/noExternal vs published deps", () => {
    const tsupRaw = readFileSync(
      join(workspaceRoot, "packages", "cli", "tsup.config.ts"),
      "utf-8",
    );

    function extractStringArray(name: string): string[] {
      const matches = [...tsupRaw.matchAll(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`, "gm"))];
      const values = matches.flatMap((m) =>
        [...m[1].matchAll(/["']([^"']+)["']/g)].map((mm) => mm[1]),
      );
      return [...new Set(values)];
    }

    function extractRegexes(name: string): RegExp[] {
      const matches = [...tsupRaw.matchAll(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`, "gm"))];
      // Match `/PATTERN/flags` where PATTERN may contain escaped slashes (`\/`).
      return matches.flatMap((m) =>
        [...m[1].matchAll(/\/((?:\\\/|[^/\n])+)\/[gimsuy]*/g)].map(
          (mm) => new RegExp(mm[1].replace(/\\\//g, "/")),
        ),
      );
    }

    const externals = extractStringArray("external");
    const noExternalRegexes = extractRegexes("noExternal");
    const noExternalStrings = extractStringArray("noExternal");

    // Externals that intentionally aren't direct deps. Each entry needs a reason —
    // when adding to this list, document *why* it doesn't need to be a runtime dep
    // (transitive via another dep, only used by the Bun binary, etc.) so future
    // edits don't silently re-introduce the dockerode-class bug.
    const TRANSITIVE_EXTERNALS: Record<string, string> = {
      ssh2: "transitive dep of dockerode",
      "cpu-features": "transitive dep of dockerode (via ssh2)",
      "@homebridge/node-pty-prebuilt-multiarch":
        "aliased as node-pty in dependencies; the alias entry satisfies the import",
      "@fusion/core": "plugin-entry bundling external only; not a runtime dep of the CLI bin",
      "@fusion/engine": "plugin-entry bundling external only; not a runtime dep of the CLI bin",
    };

    it("parses externals from tsup.config.ts", () => {
      expect(externals.length).toBeGreaterThan(0);
      expect(externals).toContain("dockerode");
    });

    it.each(externals.filter(
      (e) =>
        !builtinModules.includes(e) &&
        !e.startsWith("node:") &&
        !(e in TRANSITIVE_EXTERNALS),
    ))(
      'external "%s" is declared as a runtime dependency',
      (external) => {
        const deps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        expect(
          deps,
          `tsup external "${external}" must be in @runfusion/fusion dependencies — otherwise \`npx runfusion.ai\` fails with ERR_MODULE_NOT_FOUND on a clean install. If this is a transitive dep, add it to TRANSITIVE_EXTERNALS with a reason.`,
        ).toContain(external);
        expect(
          devDeps,
          `tsup external "${external}" must not be only a devDependency`,
        ).not.toContain(external);
      },
    );

    it("TRANSITIVE_EXTERNALS entries still appear in tsup external (otherwise stale)", () => {
      for (const name of Object.keys(TRANSITIVE_EXTERNALS)) {
        expect(
          externals,
          `TRANSITIVE_EXTERNALS["${name}"] is no longer in tsup external — remove the allowlist entry.`,
        ).toContain(name);
      }
    });

    it("noExternal (bundled) modules are not also runtime deps", () => {
      const deps = Object.keys(pkg.dependencies || {});
      for (const dep of deps) {
        for (const re of noExternalRegexes) {
          expect(
            re.test(dep),
            `dep "${dep}" matches noExternal pattern ${re} — bundled code should not also be a runtime dep`,
          ).toBe(false);
        }
        for (const s of noExternalStrings) {
          expect(
            dep,
            `dep "${dep}" is listed in noExternal — bundled code should not also be a runtime dep`,
          ).not.toBe(s);
        }
      }
    });
  });
});

describe("Scoped @fusion/* packages publishing config", () => {
  const scopedPackages = ["core", "engine", "dashboard"];

  for (const name of scopedPackages) {
    describe(`@fusion/${name}`, () => {
      const pkg = loadPackageJson(name);

      it('has publishConfig with access "public"', () => {
        expect(pkg.publishConfig).toBeDefined();
        expect(pkg.publishConfig.access).toBe("public");
      });

      it('has "files" array', () => {
        expect(pkg.files).toBeDefined();
        expect(Array.isArray(pkg.files)).toBe(true);
        expect(pkg.files).toContain("dist");
      });

      it("exports point to compiled dist output", () => {
        const exports = pkg.exports?.["."];
        expect(exports).toBeDefined();
        if (typeof exports === "object") {
          expect(exports.import).toMatch(/^\.\/dist\//);
        } else {
          expect(exports).toMatch(/^\.\/dist\//);
        }
      });
    });
  }
});

describe("Workspace bootstrap script contract", () => {
  const rootPkg = loadRootPackageJson();
  const dashboardPkg = loadPackageJson("dashboard");

  it("makes root test changed-only while keeping explicit full-suite and CI-shard commands", () => {
    expect(rootPkg.scripts?.test).toBe("node scripts/test-changed.mjs");
    expect(rootPkg.scripts?.["test:full"]).toBe("node scripts/test-changed.mjs --full --no-cache && pnpm --filter @fusion/engine test:slow");
    expect(rootPkg.scripts?.["test:full"]).not.toContain("pnpm build");
    expect(rootPkg.scripts?.["test:ci:shard"]).toBe("node scripts/ci-test-shard.mjs");
  });

  it("defines verify:workspace in lint -> test:full -> build order", () => {
    const verifyScript = rootPkg.scripts?.["verify:workspace"];
    expect(verifyScript).toBe("pnpm lint && pnpm test:full && pnpm build");

    const lintIdx = verifyScript.indexOf("pnpm lint");
    const testIdx = verifyScript.indexOf("pnpm test:full");
    const buildIdx = verifyScript.indexOf("pnpm build");

    expect(lintIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(lintIdx);
    expect(buildIdx).toBeGreaterThan(testIdx);
  });

  it("keeps default build CLI-first by excluding desktop/mobile", () => {
    expect(rootPkg.scripts?.build).toBe(
      "pnpm -r --filter=!@fusion/desktop --filter=!@fusion/mobile build",
    );
  });

  it("keeps explicit opt-in scripts for full, desktop, and mobile builds", () => {
    expect(rootPkg.scripts?.["build:all"]).toBe("pnpm -r build");
    expect(rootPkg.scripts?.["build:desktop"]).toBe(
      "pnpm --filter @fusion/desktop build",
    );
    expect(rootPkg.scripts?.["mobile:build"]).toBe(
      "pnpm --filter @fusion/dashboard build && pnpm --filter @fusion/mobile cap sync",
    );
  });

  it("keeps dashboard's default test lane curated with explicit deep coverage", () => {
    const defaultTest = dashboardPkg.scripts?.test;
    const defaultAppQuality = dashboardPkg.scripts?.["test:quality:app"];
    const defaultApiQuality = dashboardPkg.scripts?.["test:quality:api"];
    const appSettings = dashboardPkg.scripts?.["test:quality:app:settings"];
    const apiCurated = dashboardPkg.scripts?.["test:quality:api:curated"];
    const deepTest = dashboardPkg.scripts?.["test:deep"];

    expect(defaultTest).toBe("node scripts/run-quality-tests.mjs");
    expect(defaultAppQuality).toBe("node scripts/run-quality-tests.mjs --group app");
    expect(defaultApiQuality).toBe("node scripts/run-quality-tests.mjs --group api");
    expect(defaultAppQuality).toContain("--group app");
    expect(appSettings).toContain("dashboard-app-quality-settings");
    // The default quality runner dispatches grouped quality lanes by script
    // name; the curated API sub-lane still carries the explicit quality project.
    expect(defaultApiQuality).toContain("--group api");
    expect(hasProjectArg(apiCurated, "dashboard-api-quality")).toBe(true);
    expect(hasProjectArg(defaultTest, "dashboard-app")).toBe(false);
    expect(hasProjectArg(defaultTest, "dashboard-api")).toBe(false);

    expect(hasProjectArg(deepTest, "dashboard-app")).toBe(true);
    expect(hasProjectArg(deepTest, "dashboard-api")).toBe(true);
    expect(hasProjectArg(deepTest, "dashboard-app-quality")).toBe(false);
    expect(hasProjectArg(deepTest, "dashboard-api-quality")).toBe(false);
  });
});

describe("Workflow YAML validity", () => {
  it("pr-checks.yml is valid YAML", () => {
    const parsed = loadWorkflowYaml("pr-checks.yml");
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("PR Checks");
  });

  it("full-suite.yml is valid YAML", () => {
    const parsed = loadWorkflowYaml("full-suite.yml");
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("Full Suite (non-blocking)");
  });

  it("version.yml is valid YAML", () => {
    const parsed = loadWorkflowYaml("version.yml");
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("Version & Release");
  });
});

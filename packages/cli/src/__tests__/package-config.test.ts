import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { parse } from "yaml";

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

describe("CLI package.json publishing config", () => {
  const pkg = loadPackageJson("cli");

  it('has "bin" field with fn pointing to ./dist/bin.js', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.fn).toBe("./dist/bin.js");
  });

  it('has "files" array with refined globs for dist output', () => {
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
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
      const m = tsupRaw.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`, "m"));
      if (!m) return [];
      return [...m[1].matchAll(/["']([^"']+)["']/g)].map((mm) => mm[1]);
    }

    function extractRegexes(name: string): RegExp[] {
      const m = tsupRaw.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`, "m"));
      if (!m) return [];
      // Match `/PATTERN/flags` where PATTERN may contain escaped slashes (`\/`).
      return [...m[1].matchAll(/\/((?:\\\/|[^/\n])+)\/[gimsuy]*/g)].map(
        (mm) => new RegExp(mm[1].replace(/\\\//g, "/")),
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
      "node-pty": "only loaded by the Bun-compiled binary from dist/runtime/",
      "@homebridge/node-pty-prebuilt-multiarch":
        "only loaded by the Bun-compiled binary from dist/runtime/",
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

  it("makes root test changed-only while keeping explicit full-suite and CI-shard commands", () => {
    expect(rootPkg.scripts?.test).toBe("node scripts/test-changed.mjs");
    expect(rootPkg.scripts?.["test:full"]).toContain("pnpm -r --workspace-concurrency=2 test");
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
});

describe("Workflow YAML validity", () => {
  it("ci.yml is valid YAML", () => {
    const parsed = loadWorkflowYaml("ci.yml");
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("CI");
  });

  it("version.yml is valid YAML", () => {
    const parsed = loadWorkflowYaml("version.yml");
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("Version & Release");
  });
});

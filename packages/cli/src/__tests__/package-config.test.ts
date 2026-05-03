import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("keeps root test self-sufficient (no implicit pre-build dependency)", () => {
    const testScript = rootPkg.scripts?.test;
    expect(testScript).toBeDefined();
    expect(testScript).toContain("pnpm -r");
    expect(testScript).not.toContain("pnpm build");
  });

  it("defines verify:workspace in lint -> test -> build order", () => {
    const verifyScript = rootPkg.scripts?.["verify:workspace"];
    expect(verifyScript).toBe("pnpm lint && pnpm test && pnpm build");

    const lintIdx = verifyScript.indexOf("pnpm lint");
    const testIdx = verifyScript.indexOf("pnpm test");
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

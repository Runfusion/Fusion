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

describe("CLI package.json publishing config", () => {
  const pkg = loadPackageJson("cli");

  it('has "bin" field with hai pointing to ./dist/bin.js', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.hai).toBe("./dist/bin.js");
  });

  it('has "files" array that includes "dist"', () => {
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("dist");
  });

  it("is not private", () => {
    expect(pkg.private).not.toBe(true);
  });
});

describe("Scoped @hai/* packages publishing config", () => {
  const scopedPackages = ["core", "engine", "dashboard"];

  for (const name of scopedPackages) {
    describe(`@hai/${name}`, () => {
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

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, validatePluginManifest } from "@fusion/plugin-sdk";
import { applyPrepackTransform } from "../../scripts/prepare-publish-manifest.mjs";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");

describe("plugin-sdk export surface", () => {
  it("keeps definePlugin as identity and validates manifests", () => {
    const plugin = { manifest: { id: "demo-plugin", name: "Demo", version: "1.0.0" } } as any;
    expect(definePlugin(plugin)).toBe(plugin);

    expect(validatePluginManifest(plugin.manifest)).toEqual({ valid: true, errors: [] });
    expect(validatePluginManifest({ id: "Bad_ID", name: "", version: "nope" }).valid).toBe(false);
  });

  it("injects plugin-sdk subpath export into prepack manifest", () => {
    const pkgPath = join(workspaceRoot, "packages", "cli", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const transformed = applyPrepackTransform(pkg);

    expect(transformed.exports["./plugin-sdk"]).toEqual({
      types: "./dist/plugin-sdk/index.d.ts",
      import: "./dist/plugin-sdk/index.js",
    });
    expect(transformed.exports["./package.json"]).toBe("./package.json");
    // The runfusion.ai alias imports `@runfusion/fusion/dist/bin.js`; the
    // injected exports field must keep `./dist/*` subpaths resolvable or the
    // pre-publish smoke test fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
    expect(transformed.exports["./dist/*"]).toBe("./dist/*");
    expect(transformed.bin).toEqual(pkg.bin);
    expect(transformed.pi).toEqual(pkg.pi);
  });

  it("declares plugin-sdk tsup build entry with dts and fusion inlining", () => {
    const tsupPath = join(workspaceRoot, "packages", "cli", "tsup.config.ts");
    const tsupRaw = readFileSync(tsupPath, "utf-8");

    expect(tsupRaw).toContain('"plugin-sdk/index"');
    expect(tsupRaw).toContain('"..", "plugin-sdk", "src", "index.ts"');
    expect(tsupRaw).toContain("dts:");
    expect(tsupRaw).toContain("/^@fusion\\//");
  });

  it("has no @fusion runtime specifiers in built plugin-sdk artifact when present", () => {
    const distPath = join(workspaceRoot, "packages", "cli", "dist", "plugin-sdk", "index.js");
    if (!existsSync(distPath)) {
      return;
    }
    const built = readFileSync(distPath, "utf-8");
    expect(built.includes("@fusion/")).toBe(false);
  });

  it("has no @fusion specifiers in built plugin-sdk declaration artifact when present", () => {
    const distPath = join(workspaceRoot, "packages", "cli", "dist", "plugin-sdk", "index.d.ts");
    if (!existsSync(distPath)) {
      return;
    }
    const built = readFileSync(distPath, "utf-8");
    expect(built.includes("@fusion/")).toBe(false);
  });
});

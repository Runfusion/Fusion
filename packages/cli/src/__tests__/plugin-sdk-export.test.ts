import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { definePlugin, validatePluginManifest } from "@fusion/plugin-sdk";
import {
  applyPrepackTransform,
  assertPluginSdkDeclarationExists,
} from "../../scripts/prepare-publish-manifest.mjs";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");

function executableModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile("artifact.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

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

  it("refuses to pack a types export without the plugin-sdk declaration", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "fusion-plugin-sdk-prepack-"));
    try {
      expect(() => assertPluginSdkDeclarationExists(packageRoot)).toThrow(
        /dist\/plugin-sdk\/index\.d\.ts/,
      );

      const declarationPath = join(packageRoot, "dist", "plugin-sdk", "index.d.ts");
      mkdirSync(join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
      writeFileSync(declarationPath, "");
      expect(() => assertPluginSdkDeclarationExists(packageRoot)).toThrow(
        /dist\/plugin-sdk\/index\.d\.ts/,
      );

      writeFileSync(declarationPath, "export declare const definePlugin: unknown;\n");

      expect(() => assertPluginSdkDeclarationExists(packageRoot)).not.toThrow();
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("declares plugin-sdk tsup build entry with dts and fusion inlining", () => {
    const tsupPath = join(workspaceRoot, "packages", "cli", "tsup.config.ts");
    const tsupRaw = readFileSync(tsupPath, "utf-8");

    expect(tsupRaw).toContain('"plugin-sdk/index"');
    expect(tsupRaw).toContain('"..", "plugin-sdk", "src", "index.ts"');
    expect(tsupRaw).toContain("dts:");
    expect(tsupRaw).toContain("/^@fusion\\//");
  });

  it("uses a runtime-only core shim that bundles required plugin values without core dist", () => {
    const tsupPath = join(workspaceRoot, "packages", "cli", "tsup.config.ts");
    const tsupRaw = readFileSync(tsupPath, "utf-8");
    const shimPath = join(workspaceRoot, "packages", "cli", "src", "plugin-sdk-core-runtime-shim.mjs");
    const shimRaw = readFileSync(shimPath, "utf-8");

    expect(tsupRaw).toContain('"plugin-sdk-core-runtime-shim.mjs"');
    expect(shimRaw).toContain('from "../../core/src/postgres/schema/index.js"');
    /*
     * FNXC:BundledPlugins 2026-08-03-18:39:
     * Bundled plugins must receive runtime values through the CLI source shim so clean package builds never leave private `@fusion/core` imports unresolved.
     */
    expect(shimRaw).toContain('from "../../core/src/agents/agent-store.js"');
    expect(shimRaw).toContain("export { AgentStore, postgresSchema }");
    expect(shimRaw).toContain("export function superviseSpawn");
    expect(shimRaw).not.toContain("../../core/dist/");
  });

  it("has no @fusion runtime specifiers in built plugin-sdk artifact when present", () => {
    const distPath = join(workspaceRoot, "packages", "cli", "dist", "plugin-sdk", "index.js");
    if (!existsSync(distPath)) {
      return;
    }
    const built = readFileSync(distPath, "utf-8");
    const fusionRuntimeSpecifiers = executableModuleSpecifiers(built).filter((specifier) =>
      specifier.startsWith("@fusion/"),
    );
    expect(fusionRuntimeSpecifiers).toEqual([]);
  });

  it("distinguishes executable @fusion specifiers from documentation text", () => {
    const source = [
      'import value from "@fusion/static";',
      'import /* comment */ ("@fusion/dynamic");',
      'require(/* comment */ "@fusion/commonjs");',
      'export {} from /* comment */ "@fusion/exported";',
      'const docs = "Run pnpm --filter @fusion/core test";',
    ].join("\n");

    expect(executableModuleSpecifiers(source)).toEqual([
      "@fusion/static",
      "@fusion/dynamic",
      "@fusion/commonjs",
      "@fusion/exported",
    ]);
  });

  it("has no @fusion specifiers in built plugin-sdk declaration artifact when present", () => {
    const distPath = join(workspaceRoot, "packages", "cli", "dist", "plugin-sdk", "index.d.ts");
    if (!existsSync(distPath)) {
      return;
    }
    const built = readFileSync(distPath, "utf-8");
    const fusionTypeSpecifiers = executableModuleSpecifiers(built).filter((specifier) =>
      specifier.startsWith("@fusion/"),
    );
    expect(fusionTypeSpecifiers).toEqual([]);
  });
});

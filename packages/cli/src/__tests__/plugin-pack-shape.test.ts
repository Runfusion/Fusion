import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifestFromPath, resolvePluginEntryFile } from "../commands/plugin.js";
import { ALL_STAGED_BUNDLED_IDS } from "../plugins/staged-bundled-plugin-ids.js";

function writePackedPlugin(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fusion-plugin-packed-test",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
        files: ["dist", "manifest.json"],
        devDependencies: {
          "@runfusion/fusion": "^0.1.0",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        id: "fusion-plugin-packed-test",
        name: "Packed Test",
        version: "0.1.0",
        description: "Synthetic standalone packed plugin artifact.",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "dist", "index.js"),
    "import { definePlugin } from '@runfusion/fusion/plugin-sdk';\nexport default definePlugin({ manifest: { id: 'fusion-plugin-packed-test', name: 'Packed Test', version: '0.1.0' } });\n",
  );
  writeFileSync(join(root, "dist", "index.d.ts"), "export {};\n");
}

function collectTextFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if ([".js", ".mjs", ".cjs", ".json", ".ts", ".d.ts"].includes(extname(fullPath))) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

const dependencyMapKeys = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendoredExtensionManifestPaths = [
  join(packageRoot, "dist", "pi-claude-cli", "package.json"),
  join(packageRoot, "dist", "droid-cli", "package.json"),
  join(packageRoot, "dist", "pi-llama-cpp", "package.json"),
];

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function assertNoPrivateWorkspaceDependencies(path: string): void {
  const packageJson = readPackageJson(path);
  for (const dependencyMapKey of dependencyMapKeys) {
    const dependencyMap = packageJson[dependencyMapKey] ?? {};
    for (const [name, specifier] of Object.entries(dependencyMap)) {
      expect.soft(name, `${path} ${dependencyMapKey} must not depend on private @fusion/* packages`).not.toMatch(/^@fusion\//);
      expect.soft(specifier, `${path} ${dependencyMapKey}.${name} must not use workspace: specifiers`).not.toContain("workspace:");
    }
  }
}

describe("standalone plugin pack shape", () => {
  /*
   * FNXC:Packaging 2026-06-26-00:00:
   * FN-7060 guards the published CLI install path: every staged bundled plugin and vendored pi extension manifest shipped in dist must be free of workspace: specifiers and private @fusion/* dependency keys, or Linux npm/pnpm installs can try to resolve unpublished workspace packages and fail with a missing fusion core error.
   */
  it("does not ship private workspace dependency references in built plugin manifests", () => {
    for (const pluginId of ALL_STAGED_BUNDLED_IDS) {
      const packageJsonPath = join(packageRoot, "dist", "plugins", pluginId, "package.json");
      if (existsSync(packageJsonPath)) {
        assertNoPrivateWorkspaceDependencies(packageJsonPath);
      }
    }

    for (const packageJsonPath of vendoredExtensionManifestPaths) {
      if (existsSync(packageJsonPath)) {
        assertNoPrivateWorkspaceDependencies(packageJsonPath);
      }
    }
  });

  it("is accepted by the loader entry seams and does not leak private workspace imports", async () => {
    const packedRoot = join(tmpdir(), `fn-plugin-pack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      writePackedPlugin(packedRoot);

      const { manifest, path } = await loadManifestFromPath(packedRoot);
      expect(path).toBe(packedRoot);
      expect(manifest).toMatchObject({
        id: "fusion-plugin-packed-test",
        name: "Packed Test",
        version: "0.1.0",
      });
      await expect(resolvePluginEntryFile(packedRoot)).resolves.toBe(join(packedRoot, "dist", "index.js"));

      const contents = collectTextFiles(packedRoot).map((file) => readFileSync(file, "utf-8"));
      expect(contents.length).toBeGreaterThan(0);
      for (const content of contents) {
        expect(content).not.toContain("@fusion/");
        expect(content).not.toContain("workspace:");
      }
    } finally {
      rmSync(packedRoot, { recursive: true, force: true });
    }
  });
});

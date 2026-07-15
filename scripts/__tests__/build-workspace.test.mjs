import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  BUILD_CACHE_VERSION,
  PLUGIN_BUILD_GLOBAL_INPUT_PATHS,
  computePluginSourceHash,
  discoverWorkspacePackages,
  ensureFullPackageCliPlanned,
  planWorkspaceBuild,
  readPluginBuildCache,
  requiredPluginOutputs,
  wantsFullCliPackage,
} from "../build-workspace.mjs";

function createWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "fn-7290-build-workspace-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'plugins/*'\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "workspace-root", private: true }, null, 2));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }, null, 2));
  writeFileSync(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  writeFileSync(path.join(root, "plugins", "tsconfig.base.json"), JSON.stringify({ extends: "../tsconfig.base.json" }, null, 2));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-workspace.mjs"), "export {};\n");
  writeFileSync(path.join(root, "scripts", "lib", "content-hash.mjs"), "export {};\n");
  writePackage(root, "packages/core", {
    name: "@fusion/core",
    scripts: { build: "tsc" },
  });
  mkdirSync(path.join(root, "packages/core", "src"), { recursive: true });
  writeFileSync(path.join(root, "packages/core", "src", "index.ts"), "export const core = 1;\n");
  writePackage(root, "packages/desktop", {
    name: "@fusion/desktop",
    scripts: { build: "tsc" },
  });
  writePackage(root, "plugins/fusion-plugin-alpha", {
    name: "@fusion-plugin-examples/alpha",
    scripts: { build: "tsc" },
    dependencies: { "@fusion/core": "workspace:*" },
    exports: { ".": { types: "./src/index.ts", import: "./dist/index.js" } },
  });
  mkdirSync(path.join(root, "plugins/fusion-plugin-alpha", "src"), { recursive: true });
  writeFileSync(path.join(root, "plugins/fusion-plugin-alpha", "src", "index.ts"), "export const alpha = 1;\n");
  return root;
}

function writePackage(root, dir, manifest) {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest, null, 2));
}

function withWorkspace(fn) {
  const root = createWorkspace();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initGit(root) {
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
}

function packageByName(packages, name) {
  return packages.find((pkg) => pkg.name === name);
}

function writePluginDist(root, dir = "plugins/fusion-plugin-alpha") {
  mkdirSync(path.join(root, dir, "dist"), { recursive: true });
  writeFileSync(path.join(root, dir, "dist", "index.js"), "export const alpha = 1;\n");
}

test("discovers workspace packages and classifies plugin directories", () => {
  withWorkspace((root) => {
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");

    assert.equal(plugin.isPlugin, true);
    assert.equal(core.isPlugin, false);
    assert.deepEqual(plugin.requiredOutputs, ["plugins/fusion-plugin-alpha/dist/index.js"]);
    assert.deepEqual(plugin.inputPaths, [
      ...PLUGIN_BUILD_GLOBAL_INPUT_PATHS,
      "packages/core",
      "plugins/fusion-plugin-alpha",
    ].sort((a, b) => a.localeCompare(b)));
  });
});

test("unchanged packages with outputs and cache are skipped (plugins and non-plugins)", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    // Core required outputs from src/index.ts → packages/core/dist/index.js
    mkdirSync(path.join(root, "packages/core", "dist"), { recursive: true });
    writeFileSync(path.join(root, "packages/core", "dist", "index.js"), "export const core = 1;\n");
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");
    const pluginHash = computePluginSourceHash(plugin, root);
    const coreHash = computePluginSourceHash(core, root);
    const cache = {
      version: BUILD_CACHE_VERSION,
      entries: {
        [plugin.name]: { sourceHash: pluginHash },
        [core.name]: { sourceHash: coreHash },
      },
    };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache });

    assert.deepEqual(plan.plannedPackages.map((pkg) => pkg.name), []);
    assert.deepEqual(
      (plan.skippedPackages ?? plan.skippedPlugins).map((pkg) => pkg.name).sort(),
      ["@fusion-plugin-examples/alpha", "@fusion/core"].sort(),
    );
    assert.deepEqual(plan.excludedPackages.map((pkg) => pkg.name), ["@fusion/desktop"]);
  });
});

test("force rebuilds packages even when cache matches", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    mkdirSync(path.join(root, "packages/core", "dist"), { recursive: true });
    writeFileSync(path.join(root, "packages/core", "dist", "index.js"), "export const core = 1;\n");
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const core = packageByName(packages, "@fusion/core");
    const cache = {
      version: BUILD_CACHE_VERSION,
      entries: {
        [plugin.name]: { sourceHash: computePluginSourceHash(plugin, root) },
        [core.name]: { sourceHash: computePluginSourceHash(core, root) },
      },
    };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache, force: true });
    assert.ok(plan.plannedPackages.some((pkg) => pkg.name === "@fusion/core"));
    assert.ok(plan.plannedPackages.some((pkg) => pkg.name === "@fusion-plugin-examples/alpha"));
    assert.equal(packageByName(plan.plannedPackages, "@fusion/core").buildReason, "force");
  });
});

test("plugin packages build when required outputs are missing even with a matching cache", () => {
  withWorkspace((root) => {
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const hash = computePluginSourceHash(plugin, root);
    const cache = { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: hash } } };

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "missing-output");
  });
});

test("plugin packages build when no successful-build cache entry exists", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);

    const plan = planWorkspaceBuild({ rootDir: root, packages, cache: { version: BUILD_CACHE_VERSION, entries: {} } });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "no-cache");
  });
});

test("plugin packages build when tracked source files change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, plugin.dir, "src", "index.ts"), "export const alpha = 2;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when untracked plugin source files are present", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, plugin.dir, "src", "extra.ts"), "export const extra = true;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when declared workspace dependency files change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, "packages/core", "src", "index.ts"), "export const core = 2;\n");

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("plugin packages build when root TypeScript/build-tooling inputs change", () => {
  withWorkspace((root) => {
    writePluginDist(root);
    initGit(root);
    const packages = discoverWorkspacePackages(root);
    const plugin = packageByName(packages, "@fusion-plugin-examples/alpha");
    const originalHash = computePluginSourceHash(plugin, root);
    writeFileSync(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: false } }, null, 2));

    const plan = planWorkspaceBuild({
      rootDir: root,
      packages,
      cache: { version: BUILD_CACHE_VERSION, entries: { [plugin.name]: { sourceHash: originalHash } } },
    });

    const plannedPlugin = packageByName(plan.plannedPackages, "@fusion-plugin-examples/alpha");
    assert.equal(plannedPlugin.buildReason, "changed-inputs");
  });
});

test("invalid cache versions are ignored so plugins rebuild once", () => {
  withWorkspace((root) => {
    mkdirSync(path.join(root, ".fusion", "cache"), { recursive: true });
    writeFileSync(path.join(root, ".fusion", "cache", "plugin-build-cache.json"), JSON.stringify({ version: -1, entries: { stale: {} } }));

    assert.deepEqual(readPluginBuildCache(root), { version: BUILD_CACHE_VERSION, entries: {} });
  });
});

test("required outputs include source-export dist counterparts", () => {
  withWorkspace((root) => {
    mkdirSync(path.join(root, "plugins/fusion-plugin-beta", "src", "nested"), { recursive: true });
    writeFileSync(path.join(root, "plugins/fusion-plugin-beta", "src", "index.ts"), "export {};\n");
    writeFileSync(path.join(root, "plugins/fusion-plugin-beta", "src", "nested", "view.tsx"), "export {};\n");
    const outputs = requiredPluginOutputs(root, "plugins/fusion-plugin-beta", {
      exports: {
        ".": { types: "./src/index.d.ts", import: "./src/index.ts" },
        "./view": { types: "./src/nested/view.d.ts", import: "./src/nested/view.tsx" },
      },
    });

    assert.deepEqual(outputs, [
      "plugins/fusion-plugin-beta/dist/index.js",
      "plugins/fusion-plugin-beta/dist/nested/view.js",
    ]);
  });
});

test("root package build script points at the workspace build wrapper", () => {
  const rootPackage = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

  assert.equal(rootPackage.scripts.build, "node scripts/build-workspace.mjs");
});

test("full package mode force-includes CLI even when content-hash would skip it", () => {
  const skipped = [
    { name: "@runfusion/fusion", isPlugin: false, buildReason: "unchanged", sourceHash: "abc" },
    { name: "@fusion/core", isPlugin: false, buildReason: "unchanged", sourceHash: "def" },
  ];
  const { plannedPackages, skippedPackages } = ensureFullPackageCliPlanned([], skipped, { fullPackage: true });
  assert.equal(plannedPackages.length, 1);
  assert.equal(plannedPackages[0].name, "@runfusion/fusion");
  assert.equal(plannedPackages[0].buildReason, "full-package");
  assert.deepEqual(skippedPackages.map((p) => p.name), ["@fusion/core"]);
});

test("full package mode is a no-op when CLI already planned", () => {
  const planned = [{ name: "@runfusion/fusion", buildReason: "changed-inputs" }];
  const skipped = [{ name: "@fusion/core", buildReason: "unchanged" }];
  const result = ensureFullPackageCliPlanned(planned, skipped, { fullPackage: true });
  assert.equal(result.plannedPackages.length, 1);
  assert.equal(result.plannedPackages[0].buildReason, "changed-inputs");
});

test("wantsFullCliPackage matches CLI packaging env rules", () => {
  assert.equal(wantsFullCliPackage({}, { fullFlag: false }), false);
  assert.equal(wantsFullCliPackage({}, { fullFlag: true }), true);
  assert.equal(wantsFullCliPackage({ CI: "true" }, { fullFlag: false }), true);
  assert.equal(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "1" }, { fullFlag: false }), true);
  assert.equal(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "0", CI: "true" }, { fullFlag: true }), false);
  assert.equal(wantsFullCliPackage({ npm_lifecycle_event: "prepack" }, { fullFlag: false }), true);
});

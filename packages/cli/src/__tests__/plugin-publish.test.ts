import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerPlugin: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  PluginStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    registerPlugin: mocks.registerPlugin,
  })),
  PluginLoader: vi.fn(),
  resolveGlobalDir: vi.fn().mockReturnValue("/tmp/fusion-global"),
  validatePluginManifest: vi.fn((manifest: unknown) => {
    const errors: string[] = [];
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { valid: false, errors: ["Manifest must be an object"] };
    }
    const candidate = manifest as Record<string, unknown>;
    if (!candidate.id || typeof candidate.id !== "string") errors.push("id is required");
    if (!candidate.name || typeof candidate.name !== "string") errors.push("name is required");
    if (typeof candidate.version !== "string" || !/^\d+\.\d+\.\d+$/.test(candidate.version)) {
      errors.push("version must be a valid semver string (e.g., 1.0.0)");
    }
    return { valid: errors.length === 0, errors };
  }),
}));

import {
  classifyVersionBump,
  collectPluginPreflight,
  runPluginPublish,
} from "../commands/plugin-publish.js";

async function writeFixture(files: Array<{ path: string; content: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fn-plugin-publish-test-"));
  for (const file of files) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf-8");
  }
  return dir;
}

function manifest(version = "1.2.3", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "publish-test", name: "Publish Test", version, ...extra }, null, 2);
}

function packageJson(version = "1.2.3", main = "./dist/index.js"): string {
  return JSON.stringify({ name: "fusion-plugin-publish-test", version, type: "module", main }, null, 2);
}

function pluginModule(version = "1.2.3", hooks = "onLoad() {}, onUnload() {}"): string {
  return `export default {\n  manifest: { id: "publish-test", name: "Publish Test", version: "${version}" },\n  state: "installed",\n  hooks: { ${hooks} }\n};\n`;
}

async function validFixture(version = "1.2.3"): Promise<string> {
  return writeFixture([
    { path: "manifest.json", content: manifest(version) },
    { path: "package.json", content: packageJson(version) },
    { path: "dist/index.js", content: pluginModule(version) },
  ]);
}

describe("plugin publish preflight", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.registerPlugin.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("classifies strict semver bumps", () => {
    expect(classifyVersionBump("1.2.3", "2.0.0")).toBe("major");
    expect(classifyVersionBump("1.2.3", "1.3.0")).toBe("minor");
    expect(classifyVersionBump("1.2.3", "1.2.4")).toBe("patch");
    expect(classifyVersionBump("1.2.3", "1.2.3")).toBe("none");
    expect(classifyVersionBump("1.2", "1.2.3")).toBe("invalid");
    expect(classifyVersionBump("1.2.3", "1.2.3-beta.1")).toBe("invalid");
    expect(classifyVersionBump("2.0.0", "1.9.9")).toBe("invalid");
  });

  it("collects a happy-path preflight report without mutating plugin state", async () => {
    const dir = await validFixture();
    tempDirs.push(dir);

    const report = await collectPluginPreflight(dir, { previousVersion: "1.2.2" });

    expect(report.ok).toBe(true);
    expect(report.manifest).toMatchObject({ id: "publish-test", version: "1.2.3" });
    expect(report.entryPath).toBe(join(dir, "dist", "index.js"));
    expect(report.declaredHooks).toEqual(["hooks.onLoad", "hooks.onUnload"]);
    expect(report.versionBump).toEqual({ class: "patch", previous: "1.2.2", next: "1.2.3" });
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });

  it("reports manifest validation failures", async () => {
    const dir = await writeFixture([
      { path: "manifest.json", content: JSON.stringify({ name: "No ID", version: "not-semver" }) },
      { path: "package.json", content: packageJson() },
      { path: "dist/index.js", content: pluginModule() },
    ]);
    tempDirs.push(dir);

    const report = await collectPluginPreflight(dir);

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Manifest", status: "fail" }),
    ]));
  });

  it("reports TypeScript source entrypoints as missing builds", async () => {
    const dir = await writeFixture([
      { path: "manifest.json", content: manifest() },
      { path: "package.json", content: packageJson("1.2.3", "./src/index.ts") },
      { path: "src/index.ts", content: "export default {};\n" },
    ]);
    tempDirs.push(dir);

    const report = await collectPluginPreflight(dir);

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Entrypoint", status: "fail", detail: expect.stringContaining("Build the plugin first") }),
    ]));
  });

  it("fails when package.json and manifest.json versions differ", async () => {
    const dir = await writeFixture([
      { path: "manifest.json", content: manifest("1.2.3") },
      { path: "package.json", content: packageJson("1.2.4") },
      { path: "dist/index.js", content: pluginModule("1.2.3") },
    ]);
    tempDirs.push(dir);

    const report = await collectPluginPreflight(dir);

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Package version", status: "fail" }),
    ]));
  });

  it("warns without previous version and fails downgrade classification", async () => {
    const dir = await validFixture();
    tempDirs.push(dir);

    const withoutPrevious = await collectPluginPreflight(dir);
    expect(withoutPrevious.versionBump).toBeNull();
    expect(withoutPrevious.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Version bump", status: "warn" }),
    ]));

    const downgrade = await collectPluginPreflight(dir, { previousVersion: "2.0.0" });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.versionBump).toEqual({ class: "invalid", previous: "2.0.0", next: "1.2.3" });
  });

  it("exits non-zero on failed command preflight without uncaught plugin-registration work", async () => {
    const dir = await writeFixture([
      { path: "manifest.json", content: manifest() },
      { path: "package.json", content: packageJson("9.9.9") },
      { path: "dist/index.js", content: pluginModule() },
    ]);
    tempDirs.push(dir);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(runPluginPublish(dir, { dryRun: true })).rejects.toThrow("exit:1");
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });

  it("prints manual pack and publish next steps on success", async () => {
    const dir = await validFixture();
    tempDirs.push(dir);
    const log = vi.mocked(console.log);

    await runPluginPublish(dir, { dryRun: true, previousVersion: "1.2.2" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("preflight passed"));
    expect(log).toHaveBeenCalledWith("  pnpm pack");
    expect(log).toHaveBeenCalledWith("  npm publish --access public");
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });
});

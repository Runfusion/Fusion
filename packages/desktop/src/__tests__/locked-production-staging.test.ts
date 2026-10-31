import { EventEmitter } from "node:events";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

let temporary: string;
let deploy: string;
let exitCode: number;
let omitPostgres: boolean;
let invalidWorkspaceManifest: boolean;
let missingWorkspaceManifest: boolean;
let externalPackageLink: boolean;
let originalDeployDir: string | undefined;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "fusion-locked-desktop-stage-"));
  deploy = join(temporary, "deploy");
  originalDeployDir = process.env.FUSION_DESKTOP_DEPLOY_DIR;
  process.env.FUSION_DESKTOP_DEPLOY_DIR = deploy;
  exitCode = 0;
  omitPostgres = false;
  invalidWorkspaceManifest = false;
  missingWorkspaceManifest = false;
  externalPackageLink = false;
  vi.resetModules();
  spawn.mockReset().mockImplementation((command, args, options) => {
    const child = new EventEmitter();
    void (async () => {
      expect(command).toBe("pnpm");
      expect(options.cwd).toBe(resolve(import.meta.dirname, "../../../.."));
      expect(args).toEqual([
        "--filter", "@fusion/desktop", "deploy", "--prod",
        "--config.inject-workspace-packages=true", "--config.node-linker=hoisted", deploy,
      ]);
      await mkdir(deploy, { recursive: true });
      await writeFile(join(deploy, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFile(join(deploy, "package.json"), JSON.stringify({
        name: "@fusion/desktop", version: "1.0.0",
        dependencies: { "@fusion/core": "@fusion/core@file:///build-host/packages/core", "embedded-postgres": "^15.0.0" },
      }));
      await mkdir(join(deploy, "node_modules/@fusion/core"), { recursive: true });
      const sourceManifest = join(temporary, "source-core-package.json");
      await writeFile(sourceManifest, JSON.stringify({
        name: invalidWorkspaceManifest ? "different-package" : "@fusion/core", version: "1.2.3",
        dependencies: { "@fusion/plugin-sdk": "workspace:*" },
      }));
      if (!missingWorkspaceManifest) {
        await link(sourceManifest, join(deploy, "node_modules/@fusion/core/package.json"));
      }
      if (externalPackageLink) {
        const external = join(temporary, "external-package");
        await mkdir(external);
        await writeFile(join(external, "package.json"), JSON.stringify({ name: "external-package", version: "1.0.0" }));
        await symlink(external, join(deploy, "node_modules/external-package"), process.platform === "win32" ? "junction" : "dir");
      }
      const nestedSdk = join(deploy, "node_modules/@fusion/core/node_modules/@fusion/plugin-sdk");
      await mkdir(nestedSdk, { recursive: true });
      await writeFile(join(nestedSdk, "package.json"), JSON.stringify({
        name: "@fusion/plugin-sdk", version: "2.0.0", dependencies: { "@fusion/core": "workspace:*" },
      }));
      await mkdir(join(deploy, "node_modules/@fusion/plugin-sdk"), { recursive: true });
      await writeFile(join(deploy, "node_modules/@fusion/plugin-sdk/package.json"), JSON.stringify({
        name: "@fusion/plugin-sdk", version: "3.0.0",
      }));
      await writeFile(join(deploy, "electron-builder.yml"), "directories:\n  output: dist-electron\n");
      const { requiredEmbeddedPostgresPackages } = await import("../../scripts/workspace-tools");
      const names = ["embedded-postgres", ...requiredEmbeddedPostgresPackages(process.platform as "linux" | "darwin" | "win32")];
      for (const name of names) {
        const root = join(deploy, "node_modules", name);
        await mkdir(join(root, "native", "bin"), { recursive: true });
        await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
        if (name !== "embedded-postgres" && !omitPostgres) {
          for (const binary of ["initdb", "pg_ctl", "postgres"]) {
            await writeFile(join(root, "native", "bin", binary + (process.platform === "win32" ? ".exe" : "")), "fixture");
          }
        }
      }
      child.emit("exit", exitCode);
    })().catch((error: unknown) => child.emit("error", error));
    return child;
  });
});

afterEach(async () => {
  if (originalDeployDir === undefined) delete process.env.FUSION_DESKTOP_DEPLOY_DIR;
  else process.env.FUSION_DESKTOP_DEPLOY_DIR = originalDeployDir;
  await rm(temporary, { recursive: true, force: true });
});

describe("locked desktop production staging", () => {
  it("uses the workspace lock while preserving Electron's flat layout and native payload checks", async () => {
    const { stageDesktopDeploy, workspaceRoot, packageRoot } = await import("../../scripts/workspace-tools");
    const lock = await readFile(join(workspaceRoot, "pnpm-lock.yaml"));
    await stageDesktopDeploy();
    expect(spawn).toHaveBeenCalledOnce();
    await expect(readFile(join(deploy, "pnpm-lock.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(workspaceRoot, "pnpm-lock.yaml"))).toEqual(lock);
    expect(JSON.parse(await readFile(join(temporary, "source-core-package.json"), "utf8")).dependencies).toEqual({
      "@fusion/plugin-sdk": "workspace:*",
    });
    expect(JSON.parse(await readFile(join(deploy, "package.json"), "utf8"))).toEqual({
      name: "@fusion/desktop", version: "1.0.0",
      dependencies: { "@fusion/core": "1.2.3", "embedded-postgres": "^15.0.0" },
    });
    expect(JSON.parse(await readFile(join(deploy, "node_modules/@fusion/core/package.json"), "utf8")).dependencies).toEqual({
      "@fusion/plugin-sdk": "2.0.0",
    });
    expect(JSON.parse(await readFile(join(deploy, "node_modules/@fusion/core/node_modules/@fusion/plugin-sdk/package.json"), "utf8")).dependencies).toEqual({
      "@fusion/core": "1.2.3",
    });
    expect(await readFile(join(deploy, "node_modules/electron/package.json"))).toEqual(
      await readFile(join(packageRoot, "node_modules/electron/package.json")),
    );
    expect(await readFile(join(deploy, "electron-builder.yml"), "utf8")).toContain("output: ../dist-electron");
    expect((await readFile(join(deploy, "node_modules/@fusion/core/dist/postgres/migrations/0000_initial.sql"))).length).toBeGreaterThan(0);
  });

  it("propagates deployment failure before changing the generated lock or copying Electron metadata", async () => {
    exitCode = 2;
    const { stageDesktopDeploy } = await import("../../scripts/workspace-tools");
    await expect(stageDesktopDeploy()).rejects.toThrow("exited with code 2");
    expect(await readFile(join(deploy, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion");
    await expect(readFile(join(deploy, "node_modules/electron/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a workspace alias whose installed package identity is wrong", async () => {
    invalidWorkspaceManifest = true;
    const { stageDesktopDeploy } = await import("../../scripts/workspace-tools");
    await expect(stageDesktopDeploy()).rejects.toThrow("invalid installed manifest");
    await expect(readFile(join(deploy, "node_modules/electron/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a missing workspace target instead of resolving from the build host", async () => {
    missingWorkspaceManifest = true;
    const { stageDesktopDeploy } = await import("../../scripts/workspace-tools");
    await expect(stageDesktopDeploy()).rejects.toThrow("Cannot resolve staged workspace dependency @fusion/core");
  });

  it("refuses package links that escape the portable deployment", async () => {
    externalPackageLink = true;
    const { stageDesktopDeploy } = await import("../../scripts/workspace-tools");
    await expect(stageDesktopDeploy()).rejects.toThrow("Staged dependency resolves outside the deployment");
  });

  it("still refuses a deployment missing native database binaries", async () => {
    omitPostgres = true;
    const { stageDesktopDeploy } = await import("../../scripts/workspace-tools");
    await expect(stageDesktopDeploy()).rejects.toThrow("Desktop embedded Postgres payload is incomplete");
  });
});

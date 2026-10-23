import { type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ workspace: "", env: {} as NodeJS.ProcessEnv, output: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      const child = actual.spawn(command, args, {
        ...options, cwd: fixture.workspace, env: { ...options.env, ...fixture.env }, stdio: "pipe",
      });
      child.stdout?.on("data", (chunk) => { fixture.output += String(chunk); });
      child.stderr?.on("data", (chunk) => { fixture.output += String(chunk); });
      return child;
    },
  };
});

let temporary: string | undefined;
let registry: Server | undefined;
let originalDeployDir: string | undefined;

/**
 * FNXC:DesktopLockedStaging 2026-10-23-12:39:
 * Serve tiny npm tarballs entirely on loopback so version selection is exercised
 * by real pnpm without an external registry, credentials or additional test dependencies.
 */
function packageTarball(version: string): Buffer {
  const entries = {
    "package/package.json": JSON.stringify({ name: "fixture-stage-dep", version, main: "index.js" }),
    "package/index.js": `module.exports = ${JSON.stringify(version)};\n`,
  };
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, body.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset);
    }
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** FNXC:DesktopLockedStaging 2026-10-23-12:39: Seed the fixture with real pnpm before publishing the newer version. */
async function installFixture(): Promise<void> {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["install", "--ignore-scripts"], {
      cwd: fixture.workspace, env: { ...process.env, ...fixture.env },
      shell: process.platform === "win32", stdio: "pipe",
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Fixture install failed (${code}): ${output}`)));
  });
}

afterEach(async () => {
  if (originalDeployDir === undefined) delete process.env.FUSION_DESKTOP_DEPLOY_DIR;
  else process.env.FUSION_DESKTOP_DEPLOY_DIR = originalDeployDir;
  if (registry) {
    const closed = new Promise<void>((resolve, reject) => registry!.close((error) => error ? reject(error) : resolve()));
    registry.closeAllConnections();
    await closed;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

/**
 * FNXC:DesktopLockedStaging 2026-10-23-12:39:
 * Keep the production staging helper and its pnpm arguments under test. Only
 * redirect the subprocess cwd/env to an owned workspace; pnpm, HTTP, tarball
 * installation and deployed version resolution remain real, unlike the filesystem unit fixtures.
 */
it("stages the locked version even when a newer matching registry version exists", async () => {
  originalDeployDir = process.env.FUSION_DESKTOP_DEPLOY_DIR;
  temporary = await mkdtemp(join(tmpdir(), "fusion-desktop-locked-registry-"));
  fixture.workspace = join(temporary, "workspace");
  fixture.output = "";
  const deploy = join(temporary, "deploy");
  process.env.FUSION_DESKTOP_DEPLOY_DIR = deploy;
  vi.resetModules();
  const { stageDesktopDeploy, requiredEmbeddedPostgresPackages, workspaceRoot } = await import("../../scripts/workspace-tools");
  const payloads = new Map(["1.0.0", "1.1.0"].map((version) => [version, packageTarball(version)]));
  let latest = "1.0.0";
  let registryUrl: string;
  registry = createServer((request, response) => {
    if (request.url === "/fixture-stage-dep") {
      const versions = [...payloads.keys()].filter((version) => version <= latest);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        name: "fixture-stage-dep", "dist-tags": { latest },
        versions: Object.fromEntries(versions.map((version) => [version, {
          name: "fixture-stage-dep", version, main: "index.js",
          dist: {
            tarball: `${registryUrl}/fixture-stage-dep/-/${version}.tgz`,
            shasum: createHash("sha1").update(payloads.get(version)!).digest("hex"),
          },
        }])),
      }));
      return;
    }
    const version = request.url?.match(/^\/fixture-stage-dep\/-\/(1\.[01]\.0)\.tgz$/)?.[1];
    const body = version && payloads.get(version);
    if (body) { response.end(body); return; }
    response.writeHead(404).end();
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const address = registry.address();
  if (!address || typeof address === "string") throw new Error("Fixture registry has no TCP port");
  registryUrl = `http://127.0.0.1:${address.port}`;
  const userConfig = join(temporary, "empty.npmrc");
  await writeFile(userConfig, "");
  fixture.env = {
    CI: "true", npm_config_registry: registryUrl, npm_config_userconfig: userConfig,
    npm_config_store_dir: join(temporary, "store"), npm_config_cache_dir: join(temporary, "install-cache"),
  };
  await mkdir(fixture.workspace);
  const sourceRoot = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  await writeFile(join(fixture.workspace, "package.json"), JSON.stringify({
    name: "locked-stage-fixture", private: true, packageManager: sourceRoot.packageManager,
  }));
  await writeFile(join(fixture.workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const nativePackages = requiredEmbeddedPostgresPackages(process.platform as "linux" | "darwin" | "win32");
  const dependencies = Object.fromEntries(["@fusion/core", "embedded-postgres", ...nativePackages].map((name) => [name, "workspace:*"]));
  for (const [index, name] of ["@fusion/desktop", "@fusion/core", "embedded-postgres", ...nativePackages].entries()) {
    const directory = join(fixture.workspace, "packages", `package-${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name, version: "1.0.0", main: "index.js",
      ...(name === "@fusion/desktop" ? { dependencies: { ...dependencies, "fixture-stage-dep": "^1.0.0" } }
        : name === "@fusion/core" ? { dependencies: { "fixture-stage-dep": "^1.0.0" } } : {}),
    }));
    await writeFile(join(directory, "index.js"), 'module.exports = require("fixture-stage-dep");\n');
    if (name === "@fusion/desktop") await writeFile(join(directory, "electron-builder.yml"), "directories:\n  output: dist-electron\n");
    if (nativePackages.includes(name)) {
      await mkdir(join(directory, "native/bin"), { recursive: true });
      for (const binary of ["initdb", "pg_ctl", "postgres"]) {
        await writeFile(join(directory, "native/bin", binary + (process.platform === "win32" ? ".exe" : "")), "fixture");
      }
    }
  }
  await installFixture();
  const sourceLock = await readFile(join(fixture.workspace, "pnpm-lock.yaml"));
  expect(JSON.parse(await readFile(join(fixture.workspace, "packages/package-0/node_modules/fixture-stage-dep/package.json"), "utf8")).version).toBe("1.0.0");
  latest = "1.1.0";
  const metadata = await fetch(`${registryUrl}/fixture-stage-dep`).then((response) => response.json());
  expect(metadata["dist-tags"].latest).toBe("1.1.0");
  expect(metadata.versions["1.1.0"].version).toBe("1.1.0");
  fixture.env.npm_config_cache_dir = join(temporary, "deploy-cache");
  await stageDesktopDeploy().catch((error: unknown) => { throw new Error(fixture.output, { cause: error }); });
  expect(JSON.parse(await readFile(join(deploy, "node_modules/fixture-stage-dep/package.json"), "utf8")).version).toBe("1.0.0");
  expect(await readFile(join(fixture.workspace, "pnpm-lock.yaml"))).toEqual(sourceLock);
  await rename(fixture.workspace, join(temporary, "source-detached"));
  const { createRequire } = await import("node:module");
  const deployedRequire = createRequire(join(deploy, "package.json"));
  expect(deployedRequire("fixture-stage-dep")).toBe("1.0.0");
  expect(deployedRequire("@fusion/core")).toBe("1.0.0");
}, 30_000);

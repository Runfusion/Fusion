#!/usr/bin/env node
/* global console, process */
/*
FNXC:Terminal 2026-09-04-02:00:
Foreign standalone targets are absent from the script-free workspace install.
Fetch only a tarball pinned by pnpm-lock.yaml and verify it before staging, so a
release either carries the matching PTY payload or fails explicitly.
*/
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [platform, arch, version] = process.argv.slice(2);
if (!platform || !arch || !version) throw new Error("Usage: fetch-node-pty-platform-package.mjs <platform> <arch> <version>");
// FNXC:Terminal 2026-09-04-02:17: Test-only root injection keeps integrity and extraction checks network-free.
const workspaceRoot = process.env.FUSION_NODE_PTY_WORKSPACE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packageName = `@lydell/node-pty-${platform}-${arch}`;
const cacheDir = join(workspaceRoot, "node_modules", ".cache", "fusion-node-pty", `${platform}-${arch}@${version}`);
if (existsSync(join(cacheDir, "package.json"))) {
  console.log(cacheDir);
  process.exit(0);
}
const lock = readFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "utf8");
const key = `'${packageName}@${version}':`;
const section = lock.slice(lock.indexOf(key), lock.indexOf("\n\n", lock.indexOf(key)));
const integrity = /integrity: (sha512-[^}\s]+)/.exec(section)?.[1];
if (!integrity) throw new Error(`No pinned sha512 integrity for ${packageName}@${version} in pnpm-lock.yaml; refusing unverified download.`);
const tarball = process.env.FUSION_NODE_PTY_TARBALL_FILE;
const tempTarball = join(dirname(cacheDir), `${platform}-${arch}@${version}.tgz`);
mkdirSync(dirname(cacheDir), { recursive: true });
try {
  if (tarball) writeFileSync(tempTarball, readFileSync(tarball));
  else execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", `https://registry.npmjs.org/${packageName}/-/${packageName.split("/")[1]}-${version}.tgz`, "--output", tempTarball]);
  const actual = `sha512-${createHash("sha512").update(readFileSync(tempTarball)).digest("base64")}`;
  if (actual !== integrity) throw new Error(`Integrity mismatch for ${packageName}@${version}; expected lockfile sha512.`);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  execFileSync("tar", ["-xzf", tempTarball, "--strip-components=1", "-C", cacheDir]);
  console.log(cacheDir);
} catch (error) {
  rmSync(cacheDir, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(tempTarball, { force: true });
}

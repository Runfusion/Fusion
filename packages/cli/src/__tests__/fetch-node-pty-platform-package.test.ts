import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoots: string[] = [];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(packageRoot, "scripts", "fetch-node-pty-platform-package.mjs");
const version = "1.2.0-beta.15";

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-node-pty-fetch-"));
  workspaceRoots.push(root);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  return root;
}

function createTarball(root: string, token: string, assets: string[]): string {
  const packageRoot = join(root, "tarball", "package", "prebuilds", token);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(root, "tarball", "package", "package.json"), "{}");
  for (const asset of assets) {
    const destination = join(packageRoot, asset);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, asset);
  }
  const tarball = join(root, `${token}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", join(root, "tarball"), "package"]);
  return tarball;
}

function writePinnedLockfile(root: string, token: string, tarball: string): void {
  const packageName = `@lydell/node-pty-${token}`;
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  writeFileSync(join(root, "pnpm-lock.yaml"), `packages:\n  '${packageName}@${version}':\n    resolution: {integrity: ${integrity}}\n\n`);
}

function fetchFixture(root: string, token: string, tarball: string): string {
  const [platform, arch] = token.split("-");
  return execFileSync(process.execPath, [script, platform, arch, version], {
    encoding: "utf8",
    env: {
      ...process.env,
      FUSION_NODE_PTY_WORKSPACE_ROOT: root,
      FUSION_NODE_PTY_TARBALL_FILE: tarball,
    },
  }).trim();
}

afterEach(() => {
  for (const root of workspaceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetch-node-pty-platform-package", () => {
  it("extracts the actual native layout required by every supported target package", () => {
    const layouts: Record<string, string[]> = {
      "darwin-arm64": ["pty.node", "spawn-helper"],
      "darwin-x64": ["pty.node", "spawn-helper"],
      "linux-arm64": ["pty.node"],
      "linux-x64": ["pty.node"],
      "win32-arm64": ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"],
      "win32-x64": ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"],
    };

    for (const [token, assets] of Object.entries(layouts)) {
      const root = makeWorkspace();
      const tarball = createTarball(root, token, assets);
      writePinnedLockfile(root, token, tarball);
      const cacheDir = fetchFixture(root, token, tarball);
      for (const asset of assets) {
        expect(readFileSync(join(cacheDir, "prebuilds", token, asset), "utf8")).toBe(asset);
      }
    }
  });

  it("rejects a tarball with a digest that differs from the lockfile", () => {
    const root = makeWorkspace();
    const tarball = createTarball(root, "linux-x64", ["pty.node"]);
    writePinnedLockfile(root, "linux-x64", tarball);
    writeFileSync(tarball, "tampered");
    expect(() => fetchFixture(root, "linux-x64", tarball)).toThrow(/Command failed/);
  });
});

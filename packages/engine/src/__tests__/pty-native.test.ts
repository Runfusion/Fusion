import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  getNativePrebuildName,
  nodePtyPlatformPackageName,
  describePtyLoadFailure,
  findInstalledNodePtyNativeDir,
  findStagedNativeDir,
  ensureNodePtyNativePermissions,
} from "../cli-runtime/pty-native.js";

const SAVED_ENV = {
  FUSION_RUNTIME_DIR: process.env.FUSION_RUNTIME_DIR,
  NODE_PTY_SPAWN_HELPER_DIR: process.env.NODE_PTY_SPAWN_HELPER_DIR,
  FUSION_NATIVE_ASSETS_PATH: process.env.FUSION_NATIVE_ASSETS_PATH,
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "pty-native-"));
  delete process.env.FUSION_RUNTIME_DIR;
  delete process.env.NODE_PTY_SPAWN_HELPER_DIR;
  delete process.env.FUSION_NATIVE_ASSETS_PATH;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Create a fixture for the platform's published staged native entry. */
function makeStagedDir(
  root: string,
  opts: { broken?: boolean; platform?: string; arch?: string } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const dir = join(root, getNativePrebuildName(platform, arch));
  fs.mkdirSync(dir, { recursive: true });
  const nativePath = join(dir, platform === "win32" ? "conpty.node" : "pty.node");
  const helperPath = join(dir, "spawn-helper");
  fs.writeFileSync(nativePath, "fake-native");
  fs.writeFileSync(helperPath, "fake-helper");
  if (opts.broken) {
    // Strip executable + write/read bits to simulate a broken-mode install.
    fs.chmodSync(nativePath, 0o400);
    fs.chmodSync(helperPath, 0o400);
  }
  return dir;
}

describe("getNativePrebuildName", () => {
  it("returns a <platform>-<arch> token", () => {
    const name = getNativePrebuildName();
    expect(name).toMatch(/^(darwin|linux|win32|unknown)-(arm64|x64|unknown)$/);
  });
});

describe("node-pty platform package resolution", () => {
  it("maps every supported platform and architecture to its package", () => {
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
      const [platform, arch] = target.split("-");
      expect(nodePtyPlatformPackageName(platform, arch)).toBe(`@lydell/node-pty-${target}`);
    }
    expect(nodePtyPlatformPackageName("unknown", "unknown")).toBeNull();
  });

  it("reports actionable package diagnostics for supported and unsupported hosts", () => {
    expect(describePtyLoadFailure(new Error("missing"), "darwin", "arm64")).toContain("@lydell/node-pty-darwin-arm64");
    expect(describePtyLoadFailure(new Error("missing"), "linux", "x64")).toContain("@lydell/node-pty-linux-x64");
    const windowsDiagnostic = describePtyLoadFailure(new Error("missing"), "win32", "x64");
    expect(windowsDiagnostic).toContain("@lydell/node-pty-win32-x64");
    expect(windowsDiagnostic).toContain("conpty.node");
    expect(describePtyLoadFailure(new Error("missing"), "unknown", "unknown")).toContain("Platform not supported");
  });

  it("returns null rather than throwing when resolution fails", () => {
    expect(() => findInstalledNodePtyNativeDir()).not.toThrow();
  });
});

describe("findStagedNativeDir (packaged-binary mode)", () => {
  it("resolves the staged dir via FUSION_RUNTIME_DIR fixture", () => {
    const staged = makeStagedDir(tmpRoot);
    process.env.FUSION_RUNTIME_DIR = tmpRoot;
    expect(findStagedNativeDir()).toBe(staged);
  });

  it("returns null when no staged native entry is present", () => {
    process.env.FUSION_RUNTIME_DIR = tmpRoot; // empty, no platform native entry
    expect(findStagedNativeDir()).toBeNull();
  });

  it("selects a Windows staged umbrella directory from its ConPTY entry", () => {
    const staged = makeStagedDir(tmpRoot, { platform: "win32", arch: "x64" });
    process.env.FUSION_RUNTIME_DIR = tmpRoot;

    // This mirrors a standalone Windows runtime: its umbrella is selected only
    // after the staged probe accepts conpty.node rather than a nonexistent pty.node.
    expect(findStagedNativeDir("win32", "x64")).toBe(staged);
  });
});

describe("ensureNodePtyNativePermissions (permission repair)", () => {
  // chmod semantics don't apply on win32; skip there.
  const maybe = process.platform === "win32" ? it.skip : it;

  maybe("repairs broken modes on a fixture native dir to 0o755", () => {
    const dir = makeStagedDir(tmpRoot, { broken: true });
    process.env.FUSION_RUNTIME_DIR = tmpRoot;

    const nativePath = join(dir, "pty.node");
    const helperPath = join(dir, "spawn-helper");
    // Precondition: not executable.
    expect(fs.statSync(nativePath).mode & 0o111).toBe(0);

    ensureNodePtyNativePermissions();

    expect(fs.statSync(nativePath).mode & 0o777).toBe(0o755);
    expect(fs.statSync(helperPath).mode & 0o777).toBe(0o755);
  });

  maybe("is a no-op (does not throw) when no candidate dirs exist", () => {
    expect(() => ensureNodePtyNativePermissions()).not.toThrow();
  });
});

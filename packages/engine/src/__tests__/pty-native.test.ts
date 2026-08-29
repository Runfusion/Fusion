import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  getNativePrebuildName,
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

/** Create a fixture `<root>/<prebuildName>/pty.node` (+ spawn-helper) directory. */
function makeStagedDir(root: string, opts: { broken?: boolean } = {}): string {
  const dir = join(root, getNativePrebuildName());
  fs.mkdirSync(dir, { recursive: true });
  const nativePath = join(dir, "pty.node");
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

describe("findStagedNativeDir (packaged-binary mode)", () => {
  it("resolves the staged dir via FUSION_RUNTIME_DIR fixture", () => {
    const staged = makeStagedDir(tmpRoot);
    process.env.FUSION_RUNTIME_DIR = tmpRoot;
    expect(findStagedNativeDir()).toBe(staged);
  });

  it("returns null when no staged pty.node is present", () => {
    process.env.FUSION_RUNTIME_DIR = tmpRoot; // empty, no pty.node
    expect(findStagedNativeDir()).toBeNull();
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

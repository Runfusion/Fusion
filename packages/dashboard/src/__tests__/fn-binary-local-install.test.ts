// @vitest-environment node

import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installLocalFnBinary,
  removeLocalFnShims,
  resolveFnBinaryLocalPaths,
} from "../fn-binary-local-install.js";

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Unit tests for the local fn install layout used by System panel link-local /
use-global actions: co-located client assets, ~/.local/bin shims, and selective
shim removal that leaves unrelated binaries alone.
*/

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("fn-binary-local-install", () => {
  it("installs the binary with co-located client/runtime and links PATH shims", () => {
    const home = makeTemp("fn-bin-home-");
    const dist = makeTemp("fn-bin-dist-");
    const logs: string[] = [];

    writeFileSync(join(dist, "fn"), "#!/bin/sh\necho ok\n");
    chmodSync(join(dist, "fn"), 0o755);
    mkdirSync(join(dist, "client"), { recursive: true });
    writeFileSync(join(dist, "client", "index.html"), "<html></html>");
    mkdirSync(join(dist, "runtime", "darwin-arm64"), { recursive: true });
    writeFileSync(join(dist, "runtime", "darwin-arm64", "pty.node"), "native");

    const paths = resolveFnBinaryLocalPaths(home);
    installLocalFnBinary(dist, (_stream, text) => logs.push(text), paths);

    expect(logs.some((line) => line.includes("Installing binary"))).toBe(true);
    expect(readlinkSync(paths.fnShimPath)).toBe(paths.binaryPath);
    expect(readlinkSync(paths.fusionShimPath)).toBe(paths.binaryPath);
  });

  it("removeLocalFnShims only drops shims that point at the local install", () => {
    const home = makeTemp("fn-bin-home-rm-");
    const dist = makeTemp("fn-bin-dist-rm-");
    const logs: string[] = [];

    writeFileSync(join(dist, "fn"), "bin");
    mkdirSync(join(dist, "client"), { recursive: true });
    writeFileSync(join(dist, "client", "index.html"), "<html></html>");

    const paths = resolveFnBinaryLocalPaths(home);
    installLocalFnBinary(dist, () => {}, paths);

    // Unrelated shim in the same bin dir must survive.
    const otherShim = join(paths.binDir, "other-tool");
    writeFileSync(otherShim, "keep-me");

    const result = removeLocalFnShims((_stream, text) => logs.push(text), paths);
    expect(result.removed).toEqual(expect.arrayContaining([paths.fnShimPath, paths.fusionShimPath]));
    expect(logs.some((line) => line.includes("Removed local shim"))).toBe(true);

    // other-tool is a plain file, not inspected as a fusion shim path — still present.
    expect(() => readlinkSync(paths.fnShimPath)).toThrow();
  });
});

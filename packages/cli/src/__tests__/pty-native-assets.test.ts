import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bunTargetToPlatformArch, nodePtyPlatformPackageName, nodePtyRequiredNativeAssetName, resolveStagingOutcome } from "../runtime/pty-native-assets.js";
import { createNativeModuleRedirect, createWindowsNativeModuleRedirect, resolveBundledPlatformPackageRequest, resolveBundledWindowsNativeRequest } from "../runtime/native-patch.js";

describe("node-pty standalone assets", () => {
  /*
  FNXC:CliPackaging 2026-09-04-04:42:
  Path-only fixtures must use mkdtemp rather than a literal /tmp/... name. ThreatCrush flags predictable temp paths (CWE-377) even when the tests never create files.
  */
  let tmpRoot: string;
  let linuxNativeDir: string;
  let windowsNativeDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "fusion-runtime-"));
    linuxNativeDir = join(tmpRoot, "linux-x64");
    windowsNativeDir = join(tmpRoot, "win32-x64");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("maps all published platform packages", () => {
    for (const token of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
      const [platform, arch] = token.split("-");
      expect(nodePtyPlatformPackageName(platform, arch)).toBe(`@lydell/node-pty-${token}`);
    }
    expect(nodePtyPlatformPackageName("linux", "arm")).toBeNull();
  });

  it("maps every published Bun target to its platform-native entry", () => {
    expect(bunTargetToPlatformArch("bun-linux-x64")).toEqual({ platform: "linux", arch: "x64" });
    expect(bunTargetToPlatformArch("bun-linux-arm64")).toEqual({ platform: "linux", arch: "arm64" });
    expect(bunTargetToPlatformArch("bun-darwin-x64")).toEqual({ platform: "darwin", arch: "x64" });
    expect(bunTargetToPlatformArch("bun-darwin-arm64")).toEqual({ platform: "darwin", arch: "arm64" });
    expect(bunTargetToPlatformArch("bun-windows-x64")).toEqual({ platform: "win32", arch: "x64" });
    expect(bunTargetToPlatformArch("bun-invalid-x64")).toBeNull();
    expect(nodePtyRequiredNativeAssetName("darwin")).toBe("pty.node");
    expect(nodePtyRequiredNativeAssetName("linux")).toBe("pty.node");
    expect(nodePtyRequiredNativeAssetName("win32")).toBe("conpty.node");
    expect(nodePtyRequiredNativeAssetName("unknown")).toBeNull();
  });

  it("fails staging unless the explicit opt-out is selected", () => {
    expect(resolveStagingOutcome({ staged: false, allowMissingNative: false })).toBe("fail");
    expect(resolveStagingOutcome({ staged: false, allowMissingNative: true })).toBe("warn");
    expect(resolveStagingOutcome({ staged: true, allowMissingNative: false })).toBe("success");
  });

  it("redirects a bundled foreign platform-package request to its staged module", () => {
    const nativeDir = linuxNativeDir;
    const parent = { filename: "/$bunfs/root/node-pty/index.js" };
    const platformPackage = "@lydell/node-pty-linux-x64";
    const stagedPlatformEntry = join(nativeDir, "node-pty-platform", "lib", "index.js");

    // A darwin build host must still load this Linux package from the release payload.
    const platformEntry = resolveBundledPlatformPackageRequest(platformPackage, parent.filename, nativeDir, "linux", "x64");
    expect(platformEntry).toBe(stagedPlatformEntry);
    expect(resolveBundledPlatformPackageRequest(platformPackage, "/app/node-pty/index.js", nativeDir, "linux", "x64")).toBeNull();

    const loaded: string[] = [];
    const redirect = createNativeModuleRedirect(nativeDir, (request) => {
      loaded.push(request);
      return { platformModule: request };
    }, "linux", "x64");
    expect(redirect(platformPackage, parent, false)).toEqual({
      platformModule: stagedPlatformEntry,
    });
    expect(loaded).toEqual([stagedPlatformEntry]);
  });

  it("redirects bundled Windows ConPTY probes to the complete staged payload", () => {
    const nativeDir = windowsNativeDir;
    const parent = { filename: "/$bunfs/root/node-pty/lib/utils.js" };
    const conptyPath = join(nativeDir, "conpty.node");
    const conptyListPath = join(nativeDir, "conpty_console_list.node");
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty.node", parent.filename, nativeDir))
      .toBe(conptyPath);
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty_console_list.node", parent.filename, nativeDir))
      .toBe(conptyListPath);
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/../outside.node", parent.filename, nativeDir)).toBeNull();
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty.node", "/app/node-pty/lib/utils.js", nativeDir)).toBeNull();

    const loaded: string[] = [];
    const redirect = createWindowsNativeModuleRedirect(nativeDir, (request) => {
      loaded.push(request);
      return { native: request };
    });
    expect(redirect("./prebuilds/win32-x64/conpty.node", parent, false)).toEqual({
      native: conptyPath,
    });
    expect(loaded).toEqual([conptyPath]);
  });
});

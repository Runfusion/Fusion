import { describe, expect, it } from "vitest";
import { bunTargetToPlatformArch, nodePtyPlatformPackageName, nodePtyRequiredNativeAssetName, resolveStagingOutcome } from "../runtime/pty-native-assets.js";
import { createNativeModuleRedirect, createWindowsNativeModuleRedirect, resolveBundledPlatformPackageRequest, resolveBundledWindowsNativeRequest } from "../runtime/native-patch.js";

describe("node-pty standalone assets", () => {
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
    const nativeDir = "/tmp/fusion-runtime/linux-x64";
    const parent = { filename: "/$bunfs/root/node-pty/index.js" };
    const platformPackage = "@lydell/node-pty-linux-x64";

    // A darwin build host must still load this Linux package from the release payload.
    const platformEntry = resolveBundledPlatformPackageRequest(platformPackage, parent.filename, nativeDir, "linux", "x64");
    expect(platformEntry).toBe("/tmp/fusion-runtime/linux-x64/node-pty-platform/lib/index.js");
    expect(resolveBundledPlatformPackageRequest(platformPackage, "/app/node-pty/index.js", nativeDir, "linux", "x64")).toBeNull();

    const loaded: string[] = [];
    const redirect = createNativeModuleRedirect(nativeDir, (request) => {
      loaded.push(request);
      return { platformModule: request };
    }, "linux", "x64");
    expect(redirect(platformPackage, parent, false)).toEqual({
      platformModule: "/tmp/fusion-runtime/linux-x64/node-pty-platform/lib/index.js",
    });
    expect(loaded).toEqual(["/tmp/fusion-runtime/linux-x64/node-pty-platform/lib/index.js"]);
  });

  it("redirects bundled Windows ConPTY probes to the complete staged payload", () => {
    const nativeDir = "/tmp/fusion-runtime/win32-x64";
    const parent = { filename: "/$bunfs/root/node-pty/lib/utils.js" };
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty.node", parent.filename, nativeDir))
      .toBe("/tmp/fusion-runtime/win32-x64/conpty.node");
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty_console_list.node", parent.filename, nativeDir))
      .toBe("/tmp/fusion-runtime/win32-x64/conpty_console_list.node");
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/../outside.node", parent.filename, nativeDir)).toBeNull();
    expect(resolveBundledWindowsNativeRequest("./prebuilds/win32-x64/conpty.node", "/app/node-pty/lib/utils.js", nativeDir)).toBeNull();

    const loaded: string[] = [];
    const redirect = createWindowsNativeModuleRedirect(nativeDir, (request) => {
      loaded.push(request);
      return { native: request };
    });
    expect(redirect("./prebuilds/win32-x64/conpty.node", parent, false)).toEqual({
      native: "/tmp/fusion-runtime/win32-x64/conpty.node",
    });
    expect(loaded).toEqual(["/tmp/fusion-runtime/win32-x64/conpty.node"]);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface WorkspacePackageJson {
  scripts?: Record<string, string | undefined>;
}

describe("mobile pipeline scripts", () => {
  const rootPackagePath = resolve(__dirname, "../../../../package.json");

  it("defines required root mobile scripts", () => {
    const packageJson = JSON.parse(readFileSync(rootPackagePath, "utf8")) as WorkspacePackageJson;
    const scripts = packageJson.scripts ?? {};

    const requiredScriptNames = [
      "mobile:build",
      "mobile:ios",
      "mobile:android",
      "mobile:dev:ios",
      "mobile:dev:android",
      "mobile:sync",
    ];

    for (const scriptName of requiredScriptNames) {
      expect(typeof scripts[scriptName]).toBe("string");
      expect((scripts[scriptName] ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("configures mobile:build to run dashboard build and cap sync", () => {
    const packageJson = JSON.parse(readFileSync(rootPackagePath, "utf8")) as WorkspacePackageJson;
    const mobileBuild = packageJson.scripts?.["mobile:build"] ?? "";

    expect(mobileBuild).toContain("dashboard");
    expect(mobileBuild).toContain("build");
    expect(mobileBuild).toContain("cap sync");
  });

  it("includes platform-specific open commands", () => {
    const packageJson = JSON.parse(readFileSync(rootPackagePath, "utf8")) as WorkspacePackageJson;

    expect(packageJson.scripts?.["mobile:ios"] ?? "").toContain("ios");
    expect(packageJson.scripts?.["mobile:android"] ?? "").toContain("android");
  });

  /*
  FNXC:TaskDetailIOSSwipeBack 2026-07-05-12:10:
  FN-7586: `WKWebView.allowsBackForwardNavigationGestures` defaults to false and no
  capacitor.config toggle exists for it (confirmed against the installed @capacitor/cli
  declarations), so the fix is a tracked post-`cap sync` patch script
  (`packages/mobile/scripts/patch-ios-webview.ts`) wired into Capacitor's own
  `capacitor:sync:after` npm hook — mirroring FN-7583's Android manifest-patch precedent —
  so `cap sync` regeneration of the git-ignored `ios/` project can never silently drop the
  gesture opt-in. This asserts the patch/wiring is present in tracked source; it fails on the
  pre-fix tree (no patch script, no hook) and passes after.
  */
  describe("iOS edge-swipe-back gesture patch wiring (FN-7586)", () => {
    const mobilePackagePath = resolve(__dirname, "../../../mobile/package.json");
    const patchScriptPath = resolve(__dirname, "../../../mobile/scripts/patch-ios-webview.ts");

    it("ships a tracked post-cap-sync iOS WKWebView patch script", () => {
      const source = readFileSync(patchScriptPath, "utf8");

      expect(source).toContain("allowsBackForwardNavigationGestures");
      expect(source).toContain("CAPBridgeViewController");
    });

    it("wires the iOS webview patch into a Capacitor sync hook so cap sync cannot drop it", () => {
      const mobilePackageJson = JSON.parse(readFileSync(mobilePackagePath, "utf8")) as WorkspacePackageJson;
      const scripts = mobilePackageJson.scripts ?? {};

      const syncAfterHook = scripts["capacitor:sync:after"] ?? "";
      expect(syncAfterHook).toContain("patch-ios-webview");
    });
  });
});

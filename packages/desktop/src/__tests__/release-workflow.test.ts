import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf-8");
}

describe("desktop release workflow wiring", () => {
  it("adds desktop build jobs for windows, macOS, and linux", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    for (const workflow of [release, testRelease]) {
      expect(workflow).toContain("build-desktop-windows:");
      expect(workflow).toContain("runs-on: windows-latest");
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:win|electron-builder[^\n]*--win/);
      expect(workflow).toContain("name: fusion-desktop-windows");
      expect(workflow).toContain("packages/desktop/dist-electron/latest.yml");

      expect(workflow).toContain("build-desktop-macos:");
      expect(workflow).toContain("runs-on: macos-latest");
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:mac|electron-builder[^\n]*--mac/);
      expect(workflow).toContain("name: fusion-desktop-macos");
      expect(workflow).toContain("packages/desktop/dist-electron/latest-mac.yml");

      expect(workflow).toContain("build-desktop-linux:");
      expect(workflow).toContain("runs-on: ubuntu-latest");
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:linux|electron-builder[^\n]*--linux/);
      expect(workflow).toContain("--x64");
      expect(workflow).toContain("--arm64");
      expect(workflow).toContain("Fusion-*-linux-arm64.AppImage");
      expect(workflow).toMatch(/Fusion-\*-linux-(x64|x86_64)\.AppImage/);
      expect(workflow).toContain("name: fusion-desktop-linux");
      expect(workflow).toContain("packages/desktop/dist-electron/latest-linux.yml");
    }
  });

  it("boots embedded Postgres on every native desktop release host", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");
    const manualWindows = await readRepoFile(".github/workflows/desktop-windows.yml");
    const advisoryPackaging = await readRepoFile(".github/workflows/desktop-packaging.yml");

    // FNXC:DesktopEmbeddedPostgres 2026-07-14-09:40:
    // Installer assembly alone cannot prove native Postgres starts. Keep a real
    // lifecycle smoke on Windows, macOS, and Linux release hosts, plus the
    // isolated Windows and advisory packaging paths.
    for (const workflow of [release, testRelease]) {
      for (const platform of ["Windows", "macOS", "Linux"]) {
        expect(workflow).toContain(`Smoke embedded Postgres on ${platform}`);
      }
      expect(workflow.match(/pnpm --filter @fusion\/core test:embedded-postgres/g)).toHaveLength(3);
    }
    expect(manualWindows).toContain("Smoke embedded Postgres on Windows");
    expect(manualWindows).toContain("pnpm --filter @fusion/core test:embedded-postgres");
    // FNXC:WindowsDesktopPackaging 2026-07-15-10:45:
    // windows-latest jobs are elevated; postgres refuses an admin token. CI must
    // run the smoke as a non-admin helper (fusion-pg) so the process token is
    // medium integrity and the normal embedded-postgres path works.
    expect(manualWindows).toContain("fusion-pg");
    expect(manualWindows).toContain("Start-Process");
    expect(manualWindows).toContain("Prewarm embedded-PG helper user profile");
    // FNXC:WindowsDesktopPackaging 2026-07-15-11:45:
    // GitHub-hosted runners provide GITHUB_WORKSPACE; never couple the helper
    // user's ACLs or batch working directory to Fusion's current path on D:.
    expect(manualWindows).toContain("icacls $env:GITHUB_WORKSPACE");
    expect(manualWindows).toContain('"cd /d $env:GITHUB_WORKSPACE"');
    expect(manualWindows).not.toContain("D:\\a\\Fusion\\Fusion");
    expect(advisoryPackaging).toContain("Smoke embedded Postgres lifecycle");
    expect(advisoryPackaging).toContain("pnpm --filter @fusion/core test:embedded-postgres");
  });

  it("inspects Linux AppImage unpacked trees for embedded Postgres packaging", async () => {
    /*
     * FNXC:DesktopEmbeddedPostgres 2026-07-15-00:20:
     * v0.60.0 AppImages existed but omitted embedded-postgres, main-bootstrap, and
     * omp-runtime. Release + test-release must run the packaging content verifier
     * after electron-builder produces linux-*-unpacked dirs.
     */
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");
    const verifier = await readRepoFile("scripts/verify-desktop-linux-pg-packaging.mjs");

    expect(verifier).toContain("main-bootstrap.cjs");
    expect(verifier).toContain("embedded-postgres");
    expect(verifier).toContain("omp-runtime");
    expect(verifier).toContain("@embedded-postgres");
    // FNXC:DesktopEmbeddedPostgres 2026-07-15-00:30: Greptile P1 locks —
    // soname links (pg-symlinks) and runnable omp dist entrypoints, not just
    // binary names / package-name substrings.
    expect(verifier).toContain("pg-symlinks.json");
    expect(verifier).toContain("assertPlatformSonameLinks");
    expect(verifier).toContain("omp-runtime/dist/index.js");
    expect(verifier).toContain("omp-runtime/dist/probe.js");
    // FNXC:DesktopEmbeddedPostgres 2026-07-15-13:20: The x64 unpacked tree can
    // carry optional arm64 packages too; retain validation of x64 binaries and
    // SONAME links without treating that multi-arch closure as a packaging error.
    expect(verifier).toContain("platforms.includes(expectedPlatform)");
    expect(verifier).toContain("expectedPlatform, \"native\", \"bin\"");
    expect(verifier).not.toContain("found ${platform}; expected ${expectedPlatform}");

    const advisoryPackaging = await readRepoFile(".github/workflows/desktop-packaging.yml");
    for (const workflow of [release, testRelease, advisoryPackaging]) {
      expect(workflow).toContain("Verify Linux AppImage embedded Postgres packaging");
      expect(workflow).toContain("node scripts/verify-desktop-linux-pg-packaging.mjs");
    }
  });

  it("wires release aggregation to include desktop assets across platforms", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");

    expect(release).toContain(
      "needs: [build-binaries, build-desktop-windows, build-desktop-macos, build-desktop-linux, build-android]",
    );
    expect(release).toContain('find artifacts -type f \\(');
    expect(release).toContain('-name "*.exe"');
    expect(release).toContain('-name "*.exe.sha256"');
    expect(release).toContain('-name "*.blockmap"');
    expect(release).toContain('-name "*.dmg"');
    expect(release).toContain('-name "*.zip"');
    expect(release).toContain('-name "*.AppImage"');
    expect(release).toContain('-name "*.deb"');
    expect(release).toContain('-name "*.tar.gz"');
    expect(release).toContain('-name "latest*.yml"');
  });

  it("wires test-release collect job to wait for all desktop build jobs", async () => {
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    expect(testRelease).toContain(
      "needs: [build-binaries, build-desktop-windows, build-desktop-macos, build-desktop-linux, build-android]",
    );
    expect(testRelease).toContain('-name "latest*.yml"');
  });

  it("adds signed Android APK/AAB build and aggregation wiring to release workflows", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    for (const workflow of [release, testRelease]) {
      expect(workflow).toContain("build-android:");
      expect(workflow).toContain("runs-on: ubuntu-latest");
      expect(workflow).toContain("actions/setup-java@v4");
      // FNXC:AndroidRelease 2026-07-01-19:52: Capacitor 7 @capacitor/android compiles with JavaVersion.VERSION_21, so the Android release Gradle build must provision JDK 21 (JDK 17 fails with `invalid source release: 21`). Assert the intended JDK here.
      expect(workflow).toContain('java-version: "21"');
      expect(workflow).toContain("pnpm --filter @fusion/mobile cap add android");
      expect(workflow).toContain("pnpm --filter @fusion/mobile cap sync android");
      expect(workflow).toContain("ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}");
      expect(workflow).toContain("ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}");
      expect(workflow).toContain("ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}");
      expect(workflow).toContain("ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}");
      expect(workflow).toContain("env.ANDROID_KEYSTORE_BASE64 != ''");
      expect(workflow).toContain("env.ANDROID_KEYSTORE_BASE64 == ''");
      expect(workflow).toContain("./gradlew assembleRelease bundleRelease");
      expect(workflow).toContain("android.injected.signing.store.file");
      expect(workflow).toContain("android.injected.signing.store.password");
      expect(workflow).toContain("android.injected.signing.key.alias");
      expect(workflow).toContain("android.injected.signing.key.password");
      expect(workflow).toContain("./gradlew assembleDebug");
      expect(workflow).toContain("packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk");
      expect(workflow).toContain("packages/mobile/android/app/build/outputs/apk/release/app-release.apk");
      expect(workflow).toContain("packages/mobile/android/app/build/outputs/bundle/release/app-release.aab");
      expect(workflow).toContain("packages/mobile/dist/fusion-android.apk");
      expect(workflow).toContain("packages/mobile/dist/fusion-android-release.apk");
      expect(workflow).toContain("packages/mobile/dist/fusion-android-release.aab");
      expect(workflow).toContain("apksigner");
      expect(workflow).toContain("jarsigner -verify -strict");
      expect(workflow).toContain("sha256sum \"$file\" > \"$file.sha256\"");
      expect(workflow).toContain("name: fusion-android-apk");
      expect(workflow).toContain("fusion-android-release.apk");
      expect(workflow).toContain("fusion-android-release.aab");
      expect(workflow).toContain('-name "*.apk"');
      expect(workflow).toContain('-name "*.aab"');
    }
  });
});

describe("desktop macos signing wiring", () => {
  it("wires signed and unsigned macOS packaging paths with verification", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    for (const workflow of [release, testRelease]) {
      expect(workflow).toContain("Package signed macOS desktop DMG/ZIP");
      expect(workflow).toContain("Package unsigned macOS desktop DMG/ZIP");
      expect(workflow).toContain("Verify signed and notarized macOS artifacts");

      expect(workflow).toContain("secrets.APPLE_CERTIFICATE_BASE64");
      expect(workflow).toContain("secrets.APPLE_CERTIFICATE_PASSWORD");
      expect(workflow).toContain("secrets.APPLE_ID");
      expect(workflow).toContain("secrets.APPLE_TEAM_ID");
      expect(workflow).toContain("secrets.APPLE_APP_PASSWORD");

      expect(workflow).toContain("CSC_LINK:");
      expect(workflow).toContain("CSC_KEY_PASSWORD:");
      expect(workflow).toContain("APPLE_APP_SPECIFIC_PASSWORD:");
      expect(workflow).toContain("APPLE_TEAM_ID:");

      expect(workflow).toContain("APPLE_CERTIFICATE_BASE64 != ''");
      expect(workflow).toContain("APPLE_CERTIFICATE_BASE64 == ''");

      expect(workflow).toContain("codesign --verify");
      expect(workflow).toContain("spctl --assess");
      expect(workflow).toContain("xcrun stapler validate");

      expect(workflow).toContain("-c.mac.notarize=false");
    }
  });
});

describe("desktop linux signing wiring", () => {
  it("wires Linux GPG secret-guarded signing and asc uploads in both workflows", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    for (const workflow of [release, testRelease]) {
      expect(workflow).toContain("secrets.LINUX_GPG_PRIVATE_KEY");
      expect(workflow).toContain("secrets.LINUX_GPG_PASSPHRASE");
      expect(workflow).toContain("secrets.LINUX_GPG_KEY_ID");
      expect(workflow).toContain("LINUX_GPG_PRIVATE_KEY != ''");
      expect(workflow).toContain("scripts/sign-linux.sh");
      expect(workflow).toContain("Fusion-*-linux-*.AppImage.asc");
      expect(workflow).toContain("Fusion-*-linux-*.deb.asc");
      expect(workflow).toContain("Fusion-*-linux-*.tar.gz.asc");
      expect(workflow).not.toMatch(/echo\s+["']?\$\{?\s*(secrets\.)?LINUX_GPG_PASSPHRASE/);
      expect(workflow).not.toMatch(/cat\s+["']?\$\{?\s*(secrets\.)?LINUX_GPG_PASSPHRASE/);
    }
  });

  it("collectors in both workflows include asc signatures", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");
    const testRelease = await readRepoFile(".github/workflows/test-release.yml");

    expect(release).toContain('-name "*.asc"');
    expect(testRelease).toContain('-name "*.asc"');
  });

  it("sign-linux.sh contains expected guarded gpg sign and verify shape", async () => {
    const script = await readRepoFile("scripts/sign-linux.sh");

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("LINUX_GPG_PRIVATE_KEY");
    expect(script).toContain("LINUX_GPG_PASSPHRASE");
    expect(script).toContain("LINUX_GPG_KEY_ID");
    expect(script).toContain("gpg --verify");
    expect(script).toContain("--detach-sign");
    expect(script).toContain("--armor");
    expect(script).toContain("Linux signing skipped (LINUX_GPG_PRIVATE_KEY not set)");
  });
});

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
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:win|electron-builder --win/);
      expect(workflow).toContain("name: fusion-desktop-windows");
      expect(workflow).toContain("packages/desktop/dist-electron/latest.yml");

      expect(workflow).toContain("build-desktop-macos:");
      expect(workflow).toContain("runs-on: macos-latest");
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:mac|electron-builder --mac/);
      expect(workflow).toContain("name: fusion-desktop-macos");
      expect(workflow).toContain("packages/desktop/dist-electron/latest-mac.yml");

      expect(workflow).toContain("build-desktop-linux:");
      expect(workflow).toContain("runs-on: ubuntu-latest");
      expect(workflow).toMatch(/pnpm --filter @fusion\/desktop dist:linux|electron-builder --linux/);
      expect(workflow).toContain("--x64");
      expect(workflow).toContain("--arm64");
      expect(workflow).toContain("Fusion-*-linux-arm64.AppImage");
      expect(workflow).toMatch(/Fusion-\*-linux-(x64|x86_64)\.AppImage/);
      expect(workflow).toContain("name: fusion-desktop-linux");
      expect(workflow).toContain("packages/desktop/dist-electron/latest-linux.yml");
    }
  });

  it("wires private artifact collection to include desktop assets across platforms", async () => {
    const release = await readRepoFile(".github/workflows/release.yml");

    expect(release).toContain(
      "needs: [build-binaries, build-desktop-windows, build-desktop-macos, build-desktop-linux]",
    );
    expect(release).toContain("fusion-private-release-artifacts");
    expect(release).toContain("retention-days: 30");
    expect(release).not.toContain("softprops/action-gh-release");
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
      "needs: [build-binaries, build-desktop-windows, build-desktop-macos, build-desktop-linux]",
    );
    expect(testRelease).toContain('-name "latest*.yml"');
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

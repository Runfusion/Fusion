import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "../..");

async function readDesktopFile(relativePath: string): Promise<string> {
  return readFile(path.join(desktopRoot, relativePath), "utf-8");
}

describe("electron-builder desktop config", () => {
  it("keeps required Windows packaging targets and metadata", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toContain("win:");
    expect(builderConfig).toMatch(/win:\s*[\s\S]*?target:\s*[\s\S]*?-\s*target:\s*nsis/m);
    expect(builderConfig).toMatch(/win:\s*[\s\S]*?target:\s*[\s\S]*?-\s*target:\s*portable/m);

    const nsisArchMatch = builderConfig.match(
      /-\s*target:\s*nsis\s*arch:\s*([\s\S]*?)(?=\n\s*-\s*target:|\n\w)/m,
    );
    const portableArchMatch = builderConfig.match(
      /-\s*target:\s*portable\s*arch:\s*([\s\S]*?)(?=\n\s*-\s*target:|\n\w)/m,
    );

    expect(nsisArchMatch?.[1]).toBeDefined();
    expect(portableArchMatch?.[1]).toBeDefined();

    const extractArchValues = (archBlock: string) =>
      Array.from(archBlock.matchAll(/-\s*(x64|arm64)/g), (match) => match[1]).sort();

    expect(extractArchValues(nsisArchMatch![1])).toEqual(["x64"]);
    expect(extractArchValues(portableArchMatch![1])).toEqual(["x64"]);

    expect(builderConfig).toMatch(/nsis:\s*[\s\S]*?artifactName:\s*"\$\{productName\}-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}"/m);
    expect(builderConfig).toMatch(/nsis:\s*[\s\S]*?oneClick:\s*false/m);
    expect(builderConfig).toMatch(/nsis:\s*[\s\S]*?allowToChangeInstallationDirectory:\s*true/m);
    expect(builderConfig).toMatch(/portable:\s*[\s\S]*?artifactName:\s*"\$\{productName\}-\$\{version\}-\$\{os\}-\$\{arch\}-portable\.\$\{ext\}"/m);

    expect(builderConfig).toMatch(/artifactName:\s*"\$\{productName\}-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}"/m);
    expect(builderConfig).toMatch(/appId:\s*com\.gsxdsm\.fusion\.desktop/m);
    expect(builderConfig).toMatch(/productName:\s*Fusion/m);
    expect(builderConfig).toMatch(/publish:\s*[\s\S]*?provider:\s*github/m);
    expect(builderConfig).toMatch(/publish:\s*[\s\S]*?owner:\s*gsxdsm/m);
    expect(builderConfig).toMatch(/publish:\s*[\s\S]*?repo:\s*fusion/m);
  });

  it("locks windows signing policy without baked certificate paths", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toMatch(/signtoolOptions:\s*[\s\S]*?signingHashAlgorithms:\s*[\s\S]*?-\s*sha256/m);
    expect(builderConfig).toMatch(/signtoolOptions:\s*[\s\S]*?rfc3161TimeStampServer:\s*http:\/\/timestamp\.digicert\.com/m);
    expect(builderConfig).toMatch(/signtoolOptions:\s*[\s\S]*?publisherName:\s*Fusion/m);
    expect(builderConfig).not.toContain("certificateFile:");
    expect(builderConfig).not.toContain("certificateSubjectName:");
  });

  it("exposes dedicated platform-specific dist scripts", async () => {
    const packageJsonRaw = await readDesktopFile("package.json");
    const packageJson = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> };

    // Scripts package the staged production closure via `--projectDir deploy`
    // (see scripts/workspace-tools.ts stageDesktopDeploy), so assert both the
    // deploy projectDir and the platform flag rather than a bare invocation.
    expect(packageJson.scripts?.["dist:win"]).toBe("electron-builder --projectDir deploy --win");
    expect(packageJson.scripts?.["dist:mac"]).toBe("electron-builder --projectDir deploy --mac");
    expect(packageJson.scripts?.["dist:linux"]).toBe("electron-builder --projectDir deploy --linux");
  });

  it("keeps required mac and linux targets", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?target:\s*[\s\S]*?-\s*target:\s*dmg/m);
    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?target:\s*[\s\S]*?-\s*target:\s*zip/m);

    const macSection = builderConfig.match(/mac:\s*([\s\S]*?)(?=\nwin:)/m)?.[1] ?? "";
    const macArchBlocks = Array.from(
      macSection.matchAll(/-\s*target:\s*(dmg|zip)\s*arch:\s*([\s\S]*?)(?=\n\s*-\s*target:|\n\w|$)/g),
    );
    expect(macArchBlocks).toHaveLength(2);
    for (const [, , archBlock] of macArchBlocks) {
      expect(Array.from(archBlock.matchAll(/-\s*(x64|arm64)/g), (entry) => entry[1]).sort()).toEqual([
        "arm64",
        "x64",
      ]);
    }

    const linuxSectionMatch = builderConfig.match(/linux:\s*[\s\S]*$/m);
    expect(linuxSectionMatch?.[0]).toBeDefined();

    const linuxSection = linuxSectionMatch![0];
    expect(linuxSection).toMatch(/target:\s*[\s\S]*?-\s*target:\s*AppImage/m);
    expect(linuxSection).toMatch(/target:\s*[\s\S]*?-\s*target:\s*deb/m);
    expect(linuxSection).toMatch(/target:\s*[\s\S]*?-\s*target:\s*tar\.gz/m);

    const linuxTargetEntries = Array.from(
      linuxSection.matchAll(/-\s*target:\s*([^\n\r]+)/g),
      (match) => match[1]?.trim(),
    );
    expect(linuxTargetEntries[0]).toBe("AppImage");

    const linuxArchMatches = Array.from(
      linuxSection.matchAll(
        /-\s*target:\s*(AppImage|deb|tar\.gz)\s*arch:\s*([\s\S]*?)(?=\n\s*-\s*target:|\n\w|$)/g,
      ),
    );

    expect(linuxArchMatches).toHaveLength(3);

    const linuxArchByTarget = new Map(
      linuxArchMatches.map((match) => {
        const target = match[1];
        const archBlock = match[2] ?? "";
        const archValues = Array.from(archBlock.matchAll(/-\s*(x64|arm64)/g), (entry) => entry[1]).sort();
        return [target, archValues] as const;
      }),
    );

    expect(linuxArchByTarget.get("AppImage")).toEqual(["arm64", "x64"]);
    expect(linuxArchByTarget.get("deb")).toEqual(["arm64", "x64"]);
    expect(linuxArchByTarget.get("tar.gz")).toEqual(["arm64", "x64"]);
  });

  it("does not exclude Electron runtime pak resources from Windows unpacked output", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    for (const requiredPak of ["chrome_100_percent.pak", "chrome_200_percent.pak", "resources.pak"]) {
      expect(builderConfig).not.toMatch(new RegExp(`!.*${requiredPak.replaceAll(".", "\\.")}`));
    }
  });

  it("unpacks native embedded Postgres processes from app.asar", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toMatch(
      /asarUnpack:\s*[\s\S]*?-\s*"node_modules\/@embedded-postgres\/\*\/native\/\*\*\/\*"/m,
    );
  });

  it("packages @fusion/core runtime dependencies used during desktop startup", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");
    const requiredRuntimeDependencyGlobs = [
      "node_modules/debug/**/*",
      "node_modules/ms/**/*",
      "node_modules/extract-zip/**/*",
      "node_modules/get-stream/**/*",
      "node_modules/pump/**/*",
      "node_modules/end-of-stream/**/*",
      "node_modules/once/**/*",
      "node_modules/wrappy/**/*",
      "node_modules/yauzl/**/*",
      "node_modules/fd-slicer/**/*",
      "node_modules/pend/**/*",
      "node_modules/buffer-crc32/**/*",
      "node_modules/tar/**/*",
      "node_modules/@isaacs/fs-minipass/**/*",
      "node_modules/chownr/**/*",
      "node_modules/minipass/**/*",
      "node_modules/minizlib/**/*",
      "node_modules/yallist/**/*",
      "node_modules/yaml/**/*",
    ];

    for (const dependencyGlob of requiredRuntimeDependencyGlobs) {
      expect(builderConfig).toContain(`- ${dependencyGlob}`);
    }
  });

  it("locks mac signing and notarization configuration", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?hardenedRuntime:\s*true/m);
    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?gatekeeperAssess:\s*false/m);
    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?entitlements:\s*build\/entitlements\.mac\.plist/m);
    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?entitlementsInherit:\s*build\/entitlements\.mac\.plist/m);
    expect(builderConfig).toMatch(/mac:\s*[\s\S]*?notarize:\s*true/m);
    expect(builderConfig).not.toContain("mac.identity:");
    expect(builderConfig).not.toContain("appleId:");
    expect(builderConfig).not.toContain("teamId:");
  });

  it("ships the expected hardened-runtime entitlements plist", async () => {
    const entitlements = await readDesktopFile("build/entitlements.mac.plist");

    expect(entitlements).toContain("<?xml");
    expect(entitlements).toContain("</plist>");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlements).toContain("com.apple.security.cs.allow-dyld-environment-variables");
    expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
    expect(entitlements).toContain("com.apple.security.inherit");
  });
});

describe("desktop windows workflow signing guards", () => {
  it("references signing secrets and verification flow", async () => {
    const workflow = await readFile(
      path.resolve(desktopRoot, "../../.github/workflows/desktop-windows.yml"),
      "utf-8",
    );

    expect(workflow).toContain("secrets.WINDOWS_CERTIFICATE_BASE64");
    expect(workflow).toContain("secrets.WINDOWS_CERTIFICATE_PASSWORD");
    expect(workflow).toContain("CSC_LINK:");
    expect(workflow).toContain("CSC_KEY_PASSWORD:");
    expect(workflow).toContain("WINDOWS_CERTIFICATE_BASE64 != ''");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("Verify Windows runtime resources");
    expect(workflow).toContain("chrome_100_percent.pak");
    expect(workflow).toContain("chrome_200_percent.pak");
    expect(workflow).toContain("resources.pak");
    expect(workflow).toContain("Fusion-*-win-*-portable.exe");
    expect(workflow).toContain("intentionally deferred");
  });
});

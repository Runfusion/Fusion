import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliRoot = join(__dirname, "..", "..");
const shouldRun =
  process.env.FUSION_TEST_PI_CLAUDE_PUBLISH_RESOLVE === "1" ||
  process.env.FUSION_TEST_PI_CLAUDE_PUBLISH_RESOLVE === "true";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
}

/*
FNXC:PublishBoundary 2026-07-19-21:20:
FN-8413 / issue #2355 reproduces the real npm install boundary because the
private nested dist/pi-claude-cli/package.json cannot install dependencies for
raw TypeScript extension files. Pack and install with plain npm, then resolve
from acp-driver.ts to prove the root SDK pin remains the driver's compatible
0.24.0 API instead of silently relying on workspace hoisting or upgrading to 1.x.
*/
describe.skipIf(!shouldRun)("pi-claude-cli published package resolution", () => {
  it("resolves the ACP SDK from the packed raw extension after a clean npm install", () => {
    const driverPath = join(cliRoot, "dist", "pi-claude-cli", "src", "acp-driver.ts");
    if (!existsSync(driverPath)) {
      run("pnpm", ["run", "build:package"], cliRoot);
    }
    expect(existsSync(driverPath), "CLI build must stage the raw pi-claude-cli driver").toBe(true);

    const smokeDir = mkdtempSync(join(tmpdir(), "fusion-pi-claude-resolve-"));
    try {
      const packDir = join(smokeDir, "tarballs");
      const installDir = join(smokeDir, "install");
      mkdirSync(installDir, { recursive: true });
      run("pnpm", ["pack", "--pack-destination", packDir], cliRoot);

      const tarball = readdirSync(packDir).find(
        (file) => file.startsWith("runfusion-fusion-") && file.endsWith(".tgz"),
      );
      expect(tarball, "pnpm pack must produce the @runfusion/fusion tarball").toBeDefined();

      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "fusion-pi-claude-resolve-smoke", version: "0.0.0", private: true }),
      );
      run(
        "npm",
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(packDir, tarball!)],
        installDir,
      );

      const installedRoot = join(installDir, "node_modules", "@runfusion", "fusion");
      const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
      expect(installedPackage.dependencies).toHaveProperty("@agentclientprotocol/sdk", "0.24.0");

      const installedDriver = join(installedRoot, "dist", "pi-claude-cli", "src", "acp-driver.ts");
      expect(existsSync(installedDriver), "packed package must retain the raw extension driver").toBe(true);
      expect(createRequire(installedDriver).resolve("@agentclientprotocol/sdk")).toContain(
        "@agentclientprotocol/sdk",
      );
    } finally {
      rmSync(smokeDir, { recursive: true, force: true });
    }
  }, 300_000);
});

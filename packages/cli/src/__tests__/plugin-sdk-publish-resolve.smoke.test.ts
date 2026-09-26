import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  process.env.FUSION_TEST_PLUGIN_SDK_PUBLISH_RESOLVE === "1" ||
  process.env.FUSION_TEST_PLUGIN_SDK_PUBLISH_RESOLVE === "true";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
}

/*
 * FNXC:PluginSdkDeclarations 2026-09-24-06:07:
 * A plugin author installs Fusion rather than this workspace. Pack and typecheck from a clean npm consumer so strict declarations prove the published manifest installs Drizzle and its postgres peer closure.
 */
describe.skipIf(!shouldRun)("plugin SDK published declaration resolution", () => {
  it("typechecks FusionPlugin from a clean packed consumer", () => {
    const declarationPath = join(cliRoot, "dist", "plugin-sdk", "index.d.ts");
    /*
     * FNXC:PluginSdkDeclarations 2026-09-24-07:34:
     * Rebuild unconditionally so a stale finalized declaration cannot mask a
     * release build path that emits the incompatible upstream generic.
     */
    run("pnpm", ["run", "build:package"], cliRoot);
    expect(existsSync(declarationPath), "CLI build must emit the SDK declaration").toBe(true);

    const smokeDir = mkdtempSync(join(tmpdir(), "fusion-plugin-sdk-resolve-"));
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
        JSON.stringify({
          name: "fusion-plugin-sdk-resolve-smoke",
          version: "0.0.0",
          private: true,
          dependencies: { "@types/node": "^22.0.0" },
        }),
      );
      run(
        "npm",
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(packDir, tarball!)],
        installDir,
      );

      writeFileSync(
        join(installDir, "plugin.ts"),
        'import type { FusionPlugin } from "@runfusion/fusion/plugin-sdk";\nexport const plugin: FusionPlugin | null = null;\n',
      );
      writeFileSync(
        join(installDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: false,
            noEmit: true,
          },
          files: ["plugin.ts"],
        }),
      );

      const consumerRequire = createRequire(join(installDir, "package.json"));
      const consumerTsc = consumerRequire.resolve("typescript/bin/tsc");
      run("node", [consumerTsc, "--project", "tsconfig.json"], installDir);
    } finally {
      rmSync(smokeDir, { recursive: true, force: true });
    }
  }, 300_000);
});

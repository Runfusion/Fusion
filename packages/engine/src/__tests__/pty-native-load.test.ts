import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPtyModule } from "../cli-runtime/pty-native.js";

const platform = process.platform;
const arch = process.arch;
const packageName = `@lydell/node-pty-${platform}-${arch}`;

/** FNXC:Terminal 2026-09-04-01:43: This is the reported macOS failure in executable form:
 * a script-free install must resolve the platform payload and spawn a real short-lived PTY. */
describe("node-pty host platform prebuild", () => {
  let pty: { kill(): void } | undefined;

  afterEach(() => {
    pty?.kill();
    pty = undefined;
  });

  it("loads the host pty.node without an install-time compile", async () => {
    const testRequire = createRequire(import.meta.url);
    const umbrellaRequire = createRequire(testRequire.resolve("node-pty"));
    const platformEntry = umbrellaRequire.resolve(packageName);
    const ptyNode = join(dirname(dirname(platformEntry)), "prebuilds", `${platform}-${arch}`, "pty.node");
    expect(() => accessSync(ptyNode)).not.toThrow();

    const module = await loadPtyModule();
    expect(module.spawn).toBeTypeOf("function");
  });

  const nonWindows = process.platform === "win32" ? it.skip : it;
  nonWindows("spawns a short-lived PTY through the installed native module", async () => {
    const module = await loadPtyModule();
    const output = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("PTY did not emit its completion marker")), 2_000);
      pty = module.spawn("/bin/sh", ["-c", "echo fusion-pty-ok"], { name: "xterm-256color", cols: 80, rows: 24 });
      pty.onData((data) => {
        if (data.includes("fusion-pty-ok")) {
          clearTimeout(timeout);
          resolve(data);
        }
      });
      pty.onExit(() => clearTimeout(timeout));
    });
    expect(output).toContain("fusion-pty-ok");
  });
});

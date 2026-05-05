import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execWithProcessGroup } from "../verification-utils.js";

const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

describe("execWithProcessGroup", { timeout: 10_000 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fn-verification-utils-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports buffer overflow while preserving capped stdout", async () => {
    const result = await execWithProcessGroup(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(128))"`,
      { cwd: tempDir, timeout: 1_000, maxBuffer: 12 },
    );

    expect(result).toEqual({
      stdout: "x".repeat(12),
      stderr: "",
      bufferOverflow: true,
    });
  });

  it("rejects and kills the command when the abort signal fires", async () => {
    const controller = new AbortController();
    const promise = execWithProcessGroup(
      `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      { cwd: tempDir, timeout: 5_000, maxBuffer: 1_024, signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toMatchObject({
      code: "ABORT_ERR",
      aborted: true,
      killed: true,
    });
  });

  itPosix("times out and terminates child processes in the spawned process group", async () => {
    const markerPath = join(tempDir, "descendant-survived.txt");
    const parentScriptPath = join(tempDir, "spawn-descendant.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
spawn(process.execPath, [
  "-e",
  "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'survived'), 450)",
], {
  env: { ...process.env, MARKER: process.argv[2] },
  stdio: "ignore",
}).unref();
setInterval(() => {}, 1000);
`,
      "utf-8",
    );

    await expect(execWithProcessGroup(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(parentScriptPath)} ${JSON.stringify(markerPath)}`,
      { cwd: tempDir, timeout: 75, maxBuffer: 1_024 },
    )).rejects.toMatchObject({
      code: "ETIMEDOUT",
      killed: true,
    });

    await delay(700);
    await expect(access(markerPath)).rejects.toThrow();
  });
});

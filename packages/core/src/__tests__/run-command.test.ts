import { describe, expect, it } from "vitest";
import { runCommandAsync } from "../process/run-command.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runCommandAsync", () => {
  it("terminates background children left in the command process group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "console.log(child.pid);",
      "child.unref();",
    ].join(" ");

    const result = await runCommandAsync(
      `${process.execPath} -e ${JSON.stringify(parentScript)}`,
      { timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    const leakedPid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isFinite(leakedPid)).toBe(true);

    for (let i = 0; i < 10 && isProcessAlive(leakedPid); i++) {
      await sleep(100);
    }

    expect(isProcessAlive(leakedPid)).toBe(false);
  });
});

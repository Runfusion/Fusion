import { once } from "node:events";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");
const fixturePath = join(repoRoot, "packages", "core", "src", "__tests__", "fixtures", "process-supervisor-child.mjs");

type Scenario = "clean-exit" | "sigterm" | "uncaught-exception";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for supervised child ${pid} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function buildParentScript(scenario: Scenario): string {
  return `
    import { superviseSpawn } from "./packages/core/src/index.ts";
    const child = superviseSpawn(process.execPath, [${JSON.stringify(fixturePath)}, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 500,
    });
    await new Promise((resolve) => process.stdout.write(String(child.pid) + "\\n", resolve));
    if (${JSON.stringify(scenario)} === "clean-exit") {
      process.exit(0);
    } else if (${JSON.stringify(scenario)} === "sigterm") {
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1_000);
    } else {
      setTimeout(() => {
        throw new Error("FN-5189 uncaught parent failure");
      }, 10);
      setInterval(() => {}, 1_000);
    }
  `;
}

async function spawnParent(scenario: Scenario): Promise<{ parent: ReturnType<typeof spawn>; childPid: number }> {
  const parent = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", buildParentScript(scenario)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  parent.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  const childPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for supervised child pid from scenario ${scenario}`));
    }, 15_000);

    const onData = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(pid)) {
        return;
      }
      clearTimeout(timeout);
      parent.stdout?.off("data", onData);
      resolve(pid);
    };

    parent.stdout?.on("data", onData);
    parent.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    parent.once("exit", (code, signal) => {
      if (!Number.isFinite(Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10))) {
        clearTimeout(timeout);
        reject(new Error(`Parent exited before printing child pid (code=${code} signal=${signal})`));
      }
    });
  });

  return { parent, childPid };
}

describe("reliability interactions: FN-5189 verification spawn supervision", () => {
  const spawnedParents = new Set<ReturnType<typeof spawn>>();

  afterEach(async () => {
    for (const parent of spawnedParents) {
      if (parent.exitCode === null && parent.signalCode === null) {
        // Register the exit listener BEFORE kill so we don't miss the
        // event and deadlock.
        const exited = once(parent, "exit");
        try {
          parent.kill("SIGKILL");
        } catch {
          // ignore cleanup failures
        }
        await exited.catch(() => {});
      }
    }
    spawnedParents.clear();
  });

  const caseIt = process.platform === "win32" ? it.skip : it;

  caseIt.each([
    // Cover all parent teardown surfaces from FN-5893: normal exit, signal-driven exit,
    // and crash exit should all reap the supervised keepalive child within the guard window.
    ["clean-exit"],
    ["sigterm"],
    ["uncaught-exception"],
  ] satisfies [Scenario][]) ("reaps supervised child after parent %s", async (scenario) => {
    const { parent, childPid } = await spawnParent(scenario);
    spawnedParents.add(parent);

    if (scenario === "sigterm") {
      parent.kill("SIGTERM");
    }

    await once(parent, "exit");
    await waitForDead(childPid);

    expect(isAlive(childPid)).toBe(false);
  });
});

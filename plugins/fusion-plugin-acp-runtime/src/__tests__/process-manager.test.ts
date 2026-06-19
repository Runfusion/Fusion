import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  MissingAcpEnvError,
  buildSpawnEnv,
  redactSecrets,
  captureStderr,
  registerProcess,
  unregisterProcess,
  killAllProcesses,
  forceKill,
  spawnAgent,
  activeProcessCount,
} from "../process-manager.js";

const spawned: ChildProcess[] = [];

function track(child: ChildProcess): ChildProcess {
  spawned.push(child);
  return child;
}

afterEach(() => {
  for (const child of spawned) forceKill(child);
  spawned.length = 0;
  killAllProcesses();
});

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once("exit", () => resolve());
  });
}

describe("buildSpawnEnv (KTD6b allow-list)", () => {
  it("returns an empty env for an empty allow-list", () => {
    process.env.ACP_TEST_SECRET = "super-secret-value";
    try {
      const env = buildSpawnEnv([]);
      expect(Object.keys(env)).toHaveLength(0);
      expect(env.ACP_TEST_SECRET).toBeUndefined();
    } finally {
      delete process.env.ACP_TEST_SECRET;
    }
  });

  it("copies only allow-listed vars and excludes secret vars", () => {
    process.env.ACP_TEST_ALLOWED = "ok";
    process.env.ACP_TEST_SECRET = "leak-me";
    process.env.ANTHROPIC_API_KEY = "do-not-forward";
    process.env.ANTHROPIC_AUTH_TOKEN = "do-not-forward";
    try {
      const env = buildSpawnEnv(["ACP_TEST_ALLOWED"]);
      expect(env).toEqual({ ACP_TEST_ALLOWED: "ok" });
      expect(env.ACP_TEST_SECRET).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.ACP_TEST_ALLOWED;
      delete process.env.ACP_TEST_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it("builds the Claude bridge env from exactly HOME and PATH", () => {
    const env = buildSpawnEnv(["HOME", "PATH"], {
      required: ["HOME"],
      sourceEnv: {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "do-not-forward",
        ANTHROPIC_AUTH_TOKEN: "do-not-forward",
        EXTRA_SECRET: "do-not-forward",
      },
    });
    expect(env).toEqual({ HOME: "/Users/tester", PATH: "/usr/bin" });
  });

  it("rejects the Claude bridge env when HOME is missing", () => {
    expect(() =>
      buildSpawnEnv(["HOME", "PATH"], {
        required: ["HOME"],
        sourceEnv: { PATH: "/usr/bin" },
      }),
    ).toThrow(MissingAcpEnvError);
  });
});

describe("redactSecrets (Risk S8)", () => {
  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer sk-live-ABCDEFG1234567890abcdef");
    expect(out).not.toContain("sk-live-ABCDEFG1234567890abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts key=/token= assignments", () => {
    const out = redactSecrets("api_key=abcdef0123456789 token=ZZZ987654321");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).not.toContain("ZZZ987654321");
  });

  it("redacts long opaque hex/base64 secrets", () => {
    const out = redactSecrets("value 0123456789abcdef0123456789abcdef done");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("leaves benign text intact", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});

describe("captureStderr", () => {
  it("accumulates and redacts stderr", async () => {
    const child = track(
      spawn(process.execPath, [
        "-e",
        "process.stderr.write('Authorization: Bearer sk-live-SECRETSECRETSECRET123456\\n')",
      ]),
    );
    const getStderr = captureStderr(child);
    await waitForExit(child);
    const out = getStderr();
    expect(out).toContain("Authorization:");
    expect(out).not.toContain("sk-live-SECRETSECRETSECRET123456");
  });

  it("redacts a token split across two stderr writes (cross-chunk) (FIX 5)", async () => {
    // The secret is emitted in two separate write() calls so it straddles two
    // `data` chunks. Per-chunk redaction would leak it; cross-boundary redaction
    // must catch it.
    const child = track(
      spawn(process.execPath, [
        "-e",
        "process.stderr.write('Authorization: Bearer sk-live-SPLIT');" +
          "setTimeout(()=>process.stderr.write('TOKENTOKENTOKEN123456\\n'),20);",
      ]),
    );
    const getStderr = captureStderr(child);
    await waitForExit(child);
    const out = getStderr();
    expect(out).not.toContain("sk-live-SPLITTOKENTOKENTOKEN123456");
    expect(out).toContain("[REDACTED]");
  });
});

describe("process registry (KTD4)", () => {
  it("auto-removes a process from the registry on exit", async () => {
    killAllProcesses();
    const child = track(spawn(process.execPath, ["-e", "setTimeout(()=>{},50)"]));
    registerProcess(child);
    expect(activeProcessCount()).toBe(1);
    await waitForExit(child);
    // allow the 'exit' handler to run
    await new Promise((r) => setTimeout(r, 20));
    expect(activeProcessCount()).toBe(0);
  });

  it("killAllProcesses reaps survivors and clears the registry", async () => {
    killAllProcesses();
    const a = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    const b = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    registerProcess(a);
    registerProcess(b);
    expect(activeProcessCount()).toBe(2);
    killAllProcesses();
    expect(activeProcessCount()).toBe(0);
    await Promise.all([waitForExit(a), waitForExit(b)]);
    expect(a.killed || a.exitCode !== null).toBe(true);
    expect(b.killed || b.exitCode !== null).toBe(true);
  });
});

describe("forceKill", () => {
  it("no-ops on an already-dead process", async () => {
    const child = track(spawn(process.execPath, ["-e", ""]));
    await waitForExit(child);
    expect(() => forceKill(child)).not.toThrow();
  });
});

describe("spawnAgent", () => {
  it("registers on spawn and unregisters on exit", async () => {
    killAllProcesses();
    const child = track(
      spawnAgent({
        binaryPath: process.execPath,
        args: ["-e", "setTimeout(()=>{},30)"],
        cwd: process.cwd(),
        env: {},
      }),
    );
    expect(activeProcessCount()).toBe(1);
    await waitForExit(child);
    await new Promise((r) => setTimeout(r, 20));
    expect(activeProcessCount()).toBe(0);
  });

  it("unregisterProcess removes a tracked child", () => {
    killAllProcesses();
    const child = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    registerProcess(child);
    expect(activeProcessCount()).toBe(1);
    unregisterProcess(child);
    expect(activeProcessCount()).toBe(0);
  });
});


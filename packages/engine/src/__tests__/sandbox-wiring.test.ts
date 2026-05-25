import { afterEach, describe, expect, it, vi } from "vitest";

import { __runConfiguredCommandForTests } from "../executor.js";
import { __executePostMergeScriptStepForTests } from "../merger.js";
import { RoutineRunner } from "../routine-runner.js";
import {
  __resetSandboxBackendForTests,
  __setSandboxBackendForTests,
  type SandboxBackend,
} from "../sandbox/index.js";
import { defaultShell } from "../shell-utils.js";
import {
  runVerificationCommand,
  VERIFICATION_COMMAND_MAX_BUFFER,
  VERIFICATION_COMMAND_TIMEOUT_MS,
} from "../verification-utils.js";

function makeStub(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
    prepare: async () => {},
    run: vi.fn(),
    runStreaming: vi.fn(),
    dispose: async () => {},
    ...overrides,
  };
}

describe("sandbox wiring", () => {
  afterEach(() => {
    __resetSandboxBackendForTests();
    vi.restoreAllMocks();
  });

  it("routes executor runConfiguredCommand through sandbox backend", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "out",
      stderr: "err",
      exitCode: 23,
      signal: "SIGTERM",
      timedOut: true,
      bufferExceeded: true,
      spawnError: new Error("spawn"),
    });
    const stub = makeStub({ run });
    __setSandboxBackendForTests(stub);
    const controller = new AbortController();

    const result = await __runConfiguredCommandForTests("echo hi", "/tmp", 1200, { A: "1" }, undefined, controller.signal);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("echo hi", {
      cwd: "/tmp",
      timeoutMs: 1200,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      env: { A: "1" },
      signal: controller.signal,
    });
    expect((stub.runStreaming as any)).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stdout: "out",
      stderr: "err",
      exitCode: 23,
      signal: "SIGTERM",
      timedOut: true,
      bufferExceeded: true,
    });
    expect(result.spawnError).toBeInstanceOf(Error);
  });

  it("routes merger executePostMergeScriptStep through sandbox backend", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    });
    __setSandboxBackendForTests(makeStub({ run }));
    const controller = new AbortController();

    const result = await __executePostMergeScriptStepForTests(
      { updateTask: vi.fn() } as any,
      "FN-1",
      { scriptName: "post" } as any,
      "/tmp/worktree",
      { scripts: { post: "echo post" } } as any,
      undefined,
      controller.signal,
    );

    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledWith("echo post", {
      cwd: "/tmp/worktree",
      encoding: "utf-8",
      timeoutMs: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: controller.signal,
    });
  });

  it("routes routine runner command branch through sandbox backend", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "routine",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    });
    __setSandboxBackendForTests(makeStub({ run }));

    const runner = new RoutineRunner({
      routineStore: {} as any,
      heartbeatMonitor: {} as any,
      rootDir: "/tmp/root",
    });

    const routine = { id: "routine-1", agentId: "agent-1" } as any;
    const result = await (runner as any).executeCommand(routine, "echo routine", 5000, new Date().toISOString());
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledWith("echo routine", {
      cwd: "/tmp/root",
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      shell: defaultShell,
    });
  });

  it("routes verification command through sandbox runStreaming", async () => {
    const run = vi.fn();
    const runStreaming = vi.fn().mockResolvedValue({
      outcome: "success",
      stdout: "ok",
      stderr: "",
      bufferOverflow: false,
    });
    __setSandboxBackendForTests(makeStub({ run, runStreaming }));

    const store = {
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await runVerificationCommand(
      store,
      "/tmp/project",
      "FN-TEST",
      "echo ok",
      "test",
      undefined,
      undefined,
      undefined,
      { FOO: "1" },
    );

    expect(runStreaming).toHaveBeenCalledTimes(1);
    expect(runStreaming).toHaveBeenCalledWith("echo ok", {
      cwd: "/tmp/project",
      timeout: VERIFICATION_COMMAND_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      signal: undefined,
      env: { FOO: "1" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("maps non-zero streaming failures through runVerificationCommand", async () => {
    const runStreaming = vi.fn().mockResolvedValue({
      outcome: "non-zero-exit",
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      signal: null,
    });
    __setSandboxBackendForTests(makeStub({ runStreaming }));

    const store = {
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await runVerificationCommand(store, "/tmp/project", "FN-TEST", "false", "test", undefined);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(store.logEntry).toHaveBeenCalled();
    expect(store.appendAgentLog).toHaveBeenCalled();
  });
});

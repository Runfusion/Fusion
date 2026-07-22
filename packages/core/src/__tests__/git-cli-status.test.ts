// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFileException } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { GIT_INSTALL_URL, probeGitCliStatus } from "../cli/git-cli-status.js";

function mockChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn() },
  });
}

function callbackFromExecFileCall() {
  const callback = mockExecFile.mock.calls[0]?.[3];
  if (typeof callback !== "function") {
    throw new Error("execFile callback was not captured");
  }
  return callback as (error: ExecFileException | null, stdout: string, stderr: string) => void;
}

async function waitForExecFileCall(count: number): Promise<void> {
  for (let i = 0; i < 50 && mockExecFile.mock.calls.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("probeGitCliStatus", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue(mockChildProcess());
  });

  it("runs git --version with a bounded argument-vector probe", async () => {
    const resultPromise = probeGitCliStatus({ timeoutMs: 1234 });
    callbackFromExecFileCall()(null, "git version 2.45.1\n", "");

    await expect(resultPromise).resolves.toEqual({
      available: true,
      version: "2.45.1",
      installUrl: GIT_INSTALL_URL,
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["--version"],
      expect.objectContaining({ encoding: "utf-8", timeout: 1234, windowsHide: true }),
      expect.any(Function),
    );
  });

  it("reports missing git as unavailable with the install URL", async () => {
    // Empty fallback list keeps the test hermetic (the default probes the real filesystem).
    const resultPromise = probeGitCliStatus({ fallbackGitPaths: [] });
    callbackFromExecFileCall()(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as ExecFileException, "", "");

    await expect(resultPromise).resolves.toEqual({
      available: false,
      installUrl: GIT_INSTALL_URL,
    });
  });

  /*
  FNXC:Onboarding 2026-07-18-03:20:
  A git installed mid-session is not on the server's stale PATH snapshot; the
  probe must find it at a well-known absolute location instead of reporting
  "missing" until Fusion restarts.
  */
  it("falls back to well-known install locations when PATH lookup ENOENTs", async () => {
    const resultPromise = probeGitCliStatus({ fallbackGitPaths: ["C:\\Program Files\\Git\\cmd\\git.exe"] });
    callbackFromExecFileCall()(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as ExecFileException, "", "");
    await waitForExecFileCall(2);
    const secondCallback = mockExecFile.mock.calls[1]?.[3] as (error: ExecFileException | null, stdout: string, stderr: string) => void;
    secondCallback(null, "git version 2.50.0\n", "");

    await expect(resultPromise).resolves.toEqual({
      available: true,
      version: "2.50.0",
      installUrl: GIT_INSTALL_URL,
    });
    expect(mockExecFile.mock.calls[1]?.[0]).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("reports probe errors as unavailable without throwing", async () => {
    const resultPromise = probeGitCliStatus();
    callbackFromExecFileCall()(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) as ExecFileException, "", "");

    await expect(resultPromise).resolves.toEqual({
      available: false,
      installUrl: GIT_INSTALL_URL,
    });
  });

  it("tolerates version output that does not match the usual prefix", async () => {
    const resultPromise = probeGitCliStatus();
    callbackFromExecFileCall()(null, "custom-git-build\n", "");

    await expect(resultPromise).resolves.toMatchObject({
      available: true,
      version: "custom-git-build",
    });
  });
});

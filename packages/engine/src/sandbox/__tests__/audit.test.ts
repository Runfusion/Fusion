import { describe, expect, it, vi } from "vitest";

import type { RunAuditor } from "../../run-audit.js";
import { withSandboxAudit } from "../audit.js";
import type { SandboxBackend, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "../types.js";

function makeBackend(runImpl?: (command: string, options: SandboxRunOptions) => Promise<SandboxRunResult>): SandboxBackend {
  return {
    capabilities: () => ({
      id: "native",
      supportsNetworkPolicy: false,
      supportsFilesystemPolicy: false,
      supportsStreaming: true,
      platform: "any",
    }),
    prepare: vi.fn(async (policy: SandboxPolicy) => {
      policy.onFallback?.({ fromBackendId: "sandbox-exec", toBackendId: "native", reason: "unavailable" });
    }),
    run: runImpl ?? vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false })),
    runStreaming: vi.fn(async () => ({ outcome: "success" as const, stdout: "", stderr: "", bufferOverflow: false })),
    dispose: vi.fn(async () => {}),
  };
}

function makeAuditor() {
  return {
    git: vi.fn(async () => {}),
    database: vi.fn(async () => {}),
    filesystem: vi.fn(async () => {}),
    sandbox: vi.fn(async () => {}),
  } satisfies RunAuditor;
}

describe("withSandboxAudit", () => {
  it("emits prepare once and fallback callback", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(makeBackend(), auditor);

    await backend.prepare({ allowNetwork: false });
    await backend.prepare({ allowNetwork: false });

    const sandboxCalls = auditor.sandbox.mock.calls as unknown as Array<[Parameters<RunAuditor["sandbox"]>[0]]>;
    const prepareEvents = sandboxCalls.filter(([input]) => input.type === "sandbox:prepare");
    const fallbackEvents = sandboxCalls.filter(([input]) => input.type === "sandbox:fallback");
    expect(prepareEvents).toHaveLength(1);
    expect(fallbackEvents).toHaveLength(2);
  });

  it("emits run on success", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(makeBackend(), auditor);

    await backend.run("echo hello", { cwd: "/tmp", timeoutMs: 10_000, maxBuffer: 1000 });

    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:run", target: "native" }),
    );
  });

  it("emits failure for non-zero exit, timeout, and buffer overflow", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(
      makeBackend(async () => ({ stdout: "", stderr: "err", exitCode: 1, signal: null, timedOut: true, bufferExceeded: true })),
      auditor,
    );

    await backend.run("bad", { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 });

    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:failure", target: "native" }),
    );
  });

  it("emits failure and rethrows on thrown error", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(
      makeBackend(async () => {
        throw new Error("boom");
      }),
      auditor,
    );

    await expect(backend.run("explode", { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 })).rejects.toThrow("boom");
    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:failure", target: "native" }),
    );
  });
});

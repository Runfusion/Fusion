import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktrunkSettings } from "@fusion/core";
import type { AgentActionGateContext } from "../agent-action-gate.js";
import type { RunAuditor } from "../run-audit.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { exec: execImport } = await import("node:child_process");
const execMock = vi.mocked(execImport);

const {
  resolveWorktrunkBinary,
  installWorktrunk,
  probeWorktrunk,
  clearWorktrunkResolveCache,
  requestWorktrunkInstallApproval,
  executeApprovedWorktrunkInstall,
  WORKTRUNK_PINNED_RELEASE,
  WorktrunkInstallDeniedError,
  WorktrunkInstallFailedError,
} = await import("../worktrunk-installer.js");

function mockExecSequence(responses: Array<{ stdout?: string; error?: Error }>): void {
  let i = 0;
  execMock.mockImplementation(((_cmd: string, _opts: unknown, cb: unknown) => {
    const callback = typeof _opts === "function" ? (_opts as (...args: unknown[]) => void) : (cb as (...args: unknown[]) => void);
    const resp = responses[Math.min(i++, responses.length - 1)];
    if (resp.error) {
      callback(resp.error);
      return;
    }
    callback(null, { stdout: resp.stdout ?? "", stderr: "" });
  }) as unknown as typeof execImport);
}

function makeSettings(overrides?: Partial<WorktrunkSettings>): WorktrunkSettings {
  return { enabled: true, onFailure: "fail", ...overrides };
}

function makeAuditor(): { auditor: RunAuditor; events: Array<{ type: string; metadata: Record<string, unknown> }> } {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  return {
    auditor: {
      git: vi.fn().mockResolvedValue(undefined),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockImplementation(async (input: { type: string; metadata?: Record<string, unknown> }) => {
        events.push({ type: input.type, metadata: input.metadata ?? {} });
      }),
      sandbox: vi.fn().mockResolvedValue(undefined),
    },
    events,
  };
}

describe("worktrunk-installer", () => {
  const actor = { actorId: "dashboard-user", actorType: "user" as const, actorName: "Dashboard User" };

  beforeEach(() => {
    vi.clearAllMocks();
    clearWorktrunkResolveCache();
  });

  it("probeWorktrunk returns ok=true with parsed version", async () => {
    mockExecSequence([{ stdout: "worktrunk 0.4.2\n" }]);
    await expect(probeWorktrunk("/usr/local/bin/worktrunk")).resolves.toEqual({ ok: true, version: "0.4.2" });
  });

  it("requestWorktrunkInstallApproval creates pending request and dedupes", async () => {
    const created = {
      id: "apr-1",
      status: "pending" as const,
    };
    const approvalStore = {
      findLatestByDedupeKey: vi.fn().mockReturnValue(null),
      create: vi.fn().mockReturnValue(created),
    } as any;

    await expect(requestWorktrunkInstallApproval({ approvalStore, actor })).resolves.toEqual({
      approvalRequestId: "apr-1",
      status: "pending",
    });
    expect(approvalStore.create).toHaveBeenCalledTimes(1);
    expect(approvalStore.create.mock.calls[0][0].targetAction.action).toBe("worktrunk_install");

    approvalStore.findLatestByDedupeKey.mockReturnValue({ id: "apr-1", status: "pending" });
    await expect(requestWorktrunkInstallApproval({ approvalStore, actor })).resolves.toEqual({
      approvalRequestId: "apr-1",
      status: "pending",
    });
    expect(approvalStore.create).toHaveBeenCalledTimes(1);
  });

  it("executeApprovedWorktrunkInstall throws when request is not approved", async () => {
    const approvalStore = { markCompleted: vi.fn() } as any;
    await expect(
      executeApprovedWorktrunkInstall({
        approvalStore,
        settings: makeSettings(),
        request: {
          id: "apr-2",
          status: "denied",
          requester: actor,
          targetAction: { category: "network_api", action: "worktrunk_install", summary: "", resourceType: "binary", resourceId: "x" },
          requestedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
      }),
    ).rejects.toThrow(WorktrunkInstallDeniedError);
  });

  it("installWorktrunk with pre-approved override emits requested/success and returns path", async () => {
    const { auditor, events } = makeAuditor();
    await expect(installWorktrunk({ settings: makeSettings(), auditor, gateOverride: "pre-approved" })).resolves.toEqual({
      binaryPath: expect.stringContaining("worktrunk"),
      source: "installed-release",
    });
    expect(events.some((event) => event.type === "binary:install-requested" && event.metadata.reason === "pre-approved")).toBe(true);
    expect(events.some((event) => event.type === "binary:install-success")).toBe(true);
  });

  it("executeApprovedWorktrunkInstall marks request completed", async () => {
    const approvalStore = {
      markCompleted: vi.fn(),
    } as any;
    const request = {
      id: "apr-3",
      status: "approved",
      requester: actor,
      targetAction: {
        category: "network_api",
        action: "worktrunk_install",
        summary: `Install worktrunk v${WORKTRUNK_PINNED_RELEASE.version}`,
        resourceType: "binary",
        resourceId: "/tmp/worktrunk",
      },
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    await expect(executeApprovedWorktrunkInstall({ approvalStore, settings: makeSettings(), request })).resolves.toEqual({
      binaryPath: expect.stringContaining("worktrunk"),
      source: "installed-release",
    });
    expect(approvalStore.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("installWorktrunk throws disabled-path error and emits binary:install-denied", async () => {
    const { auditor, events } = makeAuditor();
    await expect(installWorktrunk({ settings: makeSettings(), auditor })).rejects.toThrow(WorktrunkInstallFailedError);
    await expect(installWorktrunk({ settings: makeSettings(), auditor })).rejects.toThrow(
      "worktrunk auto-install path disabled; set worktrunk.binaryPath or install worktrunk on PATH",
    );
    expect(events.some((event) => event.type === "binary:install-denied")).toBe(true);
    expect(events.find((event) => event.type === "binary:install-denied")?.metadata.reason).toBe("auto-install-disabled");
  });

  it("resolveWorktrunkBinary resolves explicit binaryPath when probe succeeds", async () => {
    mockExecSequence([{ stdout: "worktrunk 0.4.2\n" }]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings({ binaryPath: "/opt/worktrunk" }) })).resolves.toEqual({
      binaryPath: "/opt/worktrunk",
      source: "override",
    });
  });

  it("accepts actionGateContext and preserves current disabled-install behavior", async () => {
    mockExecSequence([{ stdout: "worktrunk 0.4.2\n" }]);
    const result = await resolveWorktrunkBinary({
      settings: makeSettings({ binaryPath: "/opt/worktrunk" }),
      actionGateContext: {} as AgentActionGateContext,
    });

    const _sourceUnionAssertion: {
      source: "override" | "path" | "cached" | "installed-release" | "installed-cargo";
    } = result;
    expect(_sourceUnionAssertion.source).toBe("override");
  });

  it("resolveWorktrunkBinary resolves PATH hit when override is absent", async () => {
    mockExecSequence([
      { stdout: "/usr/bin/worktrunk\n" },
      { stdout: "worktrunk 0.4.2\n" },
    ]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).resolves.toEqual({
      binaryPath: "/usr/bin/worktrunk",
      source: "path",
    });
  });

  it("resolveWorktrunkBinary fails with disabled install error when override/PATH/cached probes fail", async () => {
    mockExecSequence([
      { error: new Error("not found") },
      { error: new Error("not found") },
    ]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).rejects.toThrow(WorktrunkInstallFailedError);
    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).rejects.toThrow(
      "worktrunk auto-install path disabled; set worktrunk.binaryPath or install worktrunk on PATH",
    );
  });
});

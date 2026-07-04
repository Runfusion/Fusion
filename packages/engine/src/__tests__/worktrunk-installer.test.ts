import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktrunkSettings } from "@fusion/core";
import type { AgentActionGateContext } from "../agent-action-gate.js";
import type { RunAuditor } from "../run-audit.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

const loggerMock = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../logger.js", () => ({
  createLogger: () => loggerMock,
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
  validateWorktrunkManifest,
  WORKTRUNK_INSTALL_PATH,
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

function makeAuditor(): {
  auditor: RunAuditor;
  filesystemEvents: Array<{ type: string; metadata: Record<string, unknown> }>;
  gitEvents: Array<{ type: string; target: string; metadata: Record<string, unknown> }>;
} {
  const filesystemEvents: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const gitEvents: Array<{ type: string; target: string; metadata: Record<string, unknown> }> = [];
  return {
    auditor: {
      git: vi.fn().mockImplementation(async (input: { type: string; target: string; metadata?: Record<string, unknown> }) => {
        gitEvents.push({ type: input.type, target: input.target, metadata: input.metadata ?? {} });
      }),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockImplementation(async (input: { type: string; metadata?: Record<string, unknown> }) => {
        filesystemEvents.push({ type: input.type, metadata: input.metadata ?? {} });
      }),
      sandbox: vi.fn().mockResolvedValue(undefined),
    },
    filesystemEvents,
    gitEvents,
  };
}

function resetPinnedRelease(): void {
  WORKTRUNK_PINNED_RELEASE.source = "upstream-pending-verification";
  WORKTRUNK_PINNED_RELEASE.version = null;
  WORKTRUNK_PINNED_RELEASE.verifiedAt = null;
  WORKTRUNK_PINNED_RELEASE.assets = {};
}

function setVerifiedPinnedRelease(): void {
  WORKTRUNK_PINNED_RELEASE.source = "upstream-verified";
  WORKTRUNK_PINNED_RELEASE.version = "0.4.2";
  WORKTRUNK_PINNED_RELEASE.verifiedAt = "2026-05-20T00:00:00.000Z";
  WORKTRUNK_PINNED_RELEASE.assets = {
    linux: {
      url: "https://github.com/max-sixty/worktrunk/releases/download/v0.4.2/wt-linux-x64.tar.gz",
      sha256: "a".repeat(64),
    },
  };
}

describe("worktrunk-installer", () => {
  const actor = { actorId: "dashboard-user", actorType: "user" as const, actorName: "Dashboard User" };

  beforeEach(() => {
    vi.clearAllMocks();
    loggerMock.warn.mockReset();
    clearWorktrunkResolveCache();
    resetPinnedRelease();
  });

  it("probeWorktrunk returns ok=true with parsed version", async () => {
    mockExecSequence([{ stdout: "wt 0.4.2\n" }]);
    await expect(probeWorktrunk("/usr/local/bin/wt")).resolves.toEqual({ ok: true, version: "0.4.2" });
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
    expect(approvalStore.create.mock.calls[0][0].targetAction.context.approvalDedupeKey).toBe("worktrunk_install:pending");

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
    setVerifiedPinnedRelease();
    const { auditor, filesystemEvents } = makeAuditor();
    await expect(installWorktrunk({ settings: makeSettings(), auditor, gateOverride: "pre-approved" })).resolves.toEqual({
      binaryPath: WORKTRUNK_INSTALL_PATH,
      source: "installed-release",
    });
    expect(filesystemEvents.some((event) => event.type === "binary:install-requested" && event.metadata.reason === "pre-approved")).toBe(true);
    expect(filesystemEvents.some((event) => event.type === "binary:install-success")).toBe(true);
  });

  it("executeApprovedWorktrunkInstall marks request completed", async () => {
    setVerifiedPinnedRelease();
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
        summary: "Install worktrunk (pending verification)",
        resourceType: "binary",
        resourceId: "/tmp/wt",
      },
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    await expect(executeApprovedWorktrunkInstall({ approvalStore, settings: makeSettings(), request })).resolves.toEqual({
      binaryPath: WORKTRUNK_INSTALL_PATH,
      source: "installed-release",
    });
    expect(approvalStore.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("installWorktrunk throws disabled-path error and emits binary:install-denied", async () => {
    const { auditor, filesystemEvents } = makeAuditor();
    await expect(installWorktrunk({ settings: makeSettings(), auditor })).rejects.toThrow(WorktrunkInstallFailedError);
    await expect(installWorktrunk({ settings: makeSettings(), auditor })).rejects.toThrow(
      "worktrunk auto-install path disabled; set worktrunk.binaryPath or install worktrunk on PATH",
    );
    expect(filesystemEvents.some((event) => event.type === "binary:install-denied")).toBe(true);
    expect(filesystemEvents.find((event) => event.type === "binary:install-denied")?.metadata.reason).toBe("auto-install-disabled");
  });

  it("resolveWorktrunkBinary resolves explicit binaryPath when probe succeeds", async () => {
    mockExecSequence([{ stdout: "wt 0.4.2\n" }]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings({ binaryPath: "/opt/wt" }) })).resolves.toEqual({
      binaryPath: "/opt/wt",
      source: "override",
    });
  });

  it("accepts actionGateContext and preserves current disabled-install behavior", async () => {
    mockExecSequence([{ stdout: "wt 0.4.2\n" }]);
    const result = await resolveWorktrunkBinary({
      settings: makeSettings({ binaryPath: "/opt/wt" }),
      actionGateContext: {} as AgentActionGateContext,
    });

    const _sourceUnionAssertion: {
      source: "override" | "path" | "cached" | "installed-release" | "installed-cargo";
    } = result;
    expect(_sourceUnionAssertion.source).toBe("override");
  });

  it("resolveWorktrunkBinary resolves PATH hit when override is absent", async () => {
    mockExecSequence([
      { stdout: "/usr/bin/wt\n" },
      { stdout: "wt 0.4.2\n" },
    ]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).resolves.toEqual({
      binaryPath: "/usr/bin/wt",
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

  it("PATH probe looks for wt", async () => {
    mockExecSequence([
      { error: new Error("not found") },
      { error: new Error("not found") },
    ]);

    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).rejects.toThrow(WorktrunkInstallFailedError);

    const commands = execMock.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes(" wt"))).toBe(true);
    expect(commands.some((command) => command.includes(" worktrunk"))).toBe(false);
  });

  /*
  FNXC:WindowsTerminalStartup 2026-07-03-16:10:
  On Windows `wt` resolves to Windows Terminal (`wt.exe`, an App Execution Alias
  under WindowsApps). Probing it with `--version` launches Windows Terminal and
  pops its native version/Help dialog. probeWorktrunk must refuse to exec the
  Windows Terminal alias, and resolveWorktrunkBinary must not probe a PATH hit
  that is Windows Terminal — otherwise opening Settings on Windows pops the dialog.
  */
  it("probeWorktrunk refuses to launch the Windows Terminal alias without exec", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      execMock.mockClear();
      const result = await probeWorktrunk(
        "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
      );
      expect(result.ok).toBe(false);
      expect(execMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("probeWorktrunk still probes a genuine wt binary outside WindowsApps on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      mockExecSequence([{ stdout: "wt 0.4.2\n" }]);
      const result = await probeWorktrunk("C:\\tools\\worktrunk\\wt.exe");
      expect(result).toEqual({ ok: true, version: "0.4.2" });
      expect(execMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("resolveWorktrunkBinary never execs --version against a Windows Terminal PATH hit", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      // `where wt` returns Windows Terminal's alias; the Fusion install-path probe then misses.
      mockExecSequence([
        { stdout: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe\n" },
        { error: new Error("not found") },
      ]);
      await expect(resolveWorktrunkBinary({ settings: makeSettings() })).rejects.toThrow(
        WorktrunkInstallFailedError,
      );
      const commands = execMock.mock.calls.map(([command]) => String(command));
      // The Windows Terminal alias was never launched with --version.
      expect(commands.some((c) => c.toLowerCase().includes("windowsapps") && c.includes("--version"))).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("probeWorktrunk refuses a bare wt/wt.exe override on Windows (resolves to Windows Terminal via PATH)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      for (const bare of ["wt", "wt.exe"]) {
        execMock.mockClear();
        const result = await probeWorktrunk(bare);
        expect(result.ok).toBe(false);
        expect(execMock).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("probeWorktrunk refuses a forward-slash-normalized Windows Terminal path", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      execMock.mockClear();
      const result = await probeWorktrunk("C:/Users/me/AppData/Local/Microsoft/WindowsApps/wt.exe");
      expect(result.ok).toBe(false);
      expect(execMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("probeWorktrunk probes a genuine wt.exe under an unrelated windowsterminal-named folder", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      mockExecSequence([{ stdout: "wt 0.4.2\n" }]);
      // "windowsterminal-tools" is an unrelated dir, not the Microsoft.WindowsTerminal package.
      const result = await probeWorktrunk("C:\\tools\\windowsterminal-tools\\wt.exe");
      expect(result).toEqual({ ok: true, version: "0.4.2" });
      expect(execMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("installer metadata points at canonical upstream", () => {
    const serialized = JSON.stringify(WORKTRUNK_PINNED_RELEASE);
    const fabricatedUpstream = ["worktrunk", "worktrunk"].join("/");
    expect(serialized).not.toContain(fabricatedUpstream);
    for (const asset of Object.values(WORKTRUNK_PINNED_RELEASE.assets)) {
      expect(asset.url.startsWith("https://github.com/max-sixty/worktrunk/releases/")).toBe(true);
    }
  });

  it("auto-install fails closed without checksum", async () => {
    const { auditor, filesystemEvents } = makeAuditor();

    await expect(
      installWorktrunk({ settings: makeSettings(), auditor, gateOverride: "pre-approved" }),
    ).rejects.toMatchObject({
      name: "WorktrunkInstallFailedError",
      stage: "manifest-unverified",
    });
    expect(filesystemEvents.some((event) => event.type === "binary:install-success")).toBe(false);

    mockExecSequence([
      { error: new Error("not found") },
      { error: new Error("not found") },
    ]);
    await expect(resolveWorktrunkBinary({ settings: makeSettings() })).rejects.toMatchObject({
      name: "WorktrunkInstallFailedError",
    });
  });

  it("external-tool integrations require a source-of-truth manifest", () => {
    const validation = validateWorktrunkManifest({} as any);
    expect(validation).toMatchObject({ ok: false });
    if (validation.ok) throw new Error("expected validation failure");
    expect(validation.missingFields).toEqual(expect.arrayContaining(["source", "assets", "verifiedAt"]));
  });

  describe("install audit emission", () => {
    it("is a safe no-op when auditor is undefined", async () => {
      setVerifiedPinnedRelease();
      await expect(
        installWorktrunk({
          settings: makeSettings(),
          gateOverride: "pre-approved",
          runContext: { runId: "run-no-audit", agentId: "agent-1", taskId: "FN-4711" },
        }),
      ).resolves.toEqual({
        binaryPath: WORKTRUNK_INSTALL_PATH,
        source: "installed-release",
      });
    });

    it("swallows install audit emitter failures and logs a warning", async () => {
      setVerifiedPinnedRelease();
      const { auditor } = makeAuditor();
      vi.mocked(auditor.git).mockRejectedValueOnce(new Error("audit write failed"));

      await expect(
        installWorktrunk({
          settings: makeSettings(),
          auditor,
          gateOverride: "pre-approved",
          runContext: { runId: "run-audit-fail", agentId: "agent-1", taskId: "FN-4711" },
        }),
      ).resolves.toEqual({
        binaryPath: WORKTRUNK_INSTALL_PATH,
        source: "installed-release",
      });

      expect(loggerMock.warn).toHaveBeenCalledWith("install-audit-failed", expect.objectContaining({ err: "audit write failed" }));
    });

    it.each([
      { expectedSource: "release-binary" as const },
    ])("emits worktree install audit event metadata for $expectedSource", async ({ expectedSource }) => {
      setVerifiedPinnedRelease();
      const { auditor, gitEvents } = makeAuditor();
      const runContext = { runId: "run-install-success", agentId: "agent-1", taskId: "FN-4711" };

      await installWorktrunk({ settings: makeSettings(), auditor, gateOverride: "pre-approved", runContext });

      const installEvent = gitEvents.find((event) => event.type === "worktree:worktrunk-install");
      expect(installEvent).toBeDefined();
      expect(installEvent?.target).toContain("/wt");
      expect(installEvent?.metadata).toEqual(
        expect.objectContaining({
          op: "install",
          binaryPath: expect.stringContaining("/wt"),
          installSource: expectedSource,
          durationMs: expect.any(Number),
          taskId: "FN-4711",
          runId: "run-install-success",
        }),
      );
      expect((installEvent?.metadata.durationMs as number) ?? -1).toBeGreaterThanOrEqual(0);
    });

    it("does not emit worktree install audit for PATH cache-hit resolution", async () => {
      const { auditor, gitEvents } = makeAuditor();
      mockExecSequence([
        { stdout: "/usr/bin/wt\n" },
        { stdout: "wt 0.4.2\n" },
      ]);

      await resolveWorktrunkBinary({ settings: makeSettings(), auditor });

      expect(gitEvents.some((event) => event.type === "worktree:worktrunk-install")).toBe(false);
    });
  });
});

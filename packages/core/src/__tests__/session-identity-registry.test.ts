import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskExecutionSessionPrincipal } from "../agents/task-execution-task-creation.js";
import {
  __clearFusionSessionIdentityRegistryForTests,
  registerFusionSessionIdentity,
  runWithFusionSessionIdentity,
  resolveFusionSessionPrincipal,
} from "../session-identity-registry.js";

/*
FNXC:SessionIdentity 2026-07-26-15:20:
The registry is the extension-side principal signal: absent registration means
human operator CLI; present means engine-owned agent session; two live
registrations on one cwd is ambiguous and must fail closed (agent). These
semantics are what the extension's destructive-tool withholding relies on.
*/

describe("session identity registry", () => {
  beforeEach(() => {
    __clearFusionSessionIdentityRegistryForTests();
  });

  it("unregistered cwd resolves to operator", () => {
    expect(resolveFusionSessionPrincipal("/tmp/nowhere-registered")).toEqual({ kind: "operator" });
  });

  it("registered cwd resolves to the agent identity", () => {
    const dispose = registerFusionSessionIdentity("/tmp/wt-a", { agentId: "executor-FN-1", taskId: "FN-1" });
    const principal = resolveFusionSessionPrincipal("/tmp/wt-a");
    expect(principal.kind).toBe("agent");
    if (principal.kind === "agent") {
      expect(principal.identity.agentId).toBe("executor-FN-1");
      expect(principal.identity.taskId).toBe("FN-1");
    }
    dispose();
    expect(resolveFusionSessionPrincipal("/tmp/wt-a")).toEqual({ kind: "operator" });
  });

  it("round-trips the task-execution marker and fails closed for ambiguity", () => {
    registerFusionSessionIdentity("/tmp/project-root", { agentId: "agent-1", taskExecutionSession: true });
    registerFusionSessionIdentity("/tmp/project-root", { agentId: "agent-2" });
    const principal = resolveFusionSessionPrincipal("/tmp/project-root");
    expect(principal.kind).toBe("ambiguous");
    expect(isTaskExecutionSessionPrincipal(principal)).toBe(true);
  });

  it("uses the invocation identity for concurrent sessions sharing a cwd", async () => {
    const cwd = "/tmp/project-root";
    const disposeA = registerFusionSessionIdentity(cwd, { agentId: "agent-a" });
    const disposeB = registerFusionSessionIdentity(cwd, { agentId: "agent-b" });
    try {
      const principals = await Promise.all([
        runWithFusionSessionIdentity([cwd], { agentId: "agent-a", purpose: "chat" }, async () => {
          await Promise.resolve();
          return resolveFusionSessionPrincipal(cwd);
        }),
        runWithFusionSessionIdentity([cwd], { agentId: "agent-b", purpose: "chat" }, async () => {
          await Promise.resolve();
          return resolveFusionSessionPrincipal(cwd);
        }),
      ]);
      expect(principals).toEqual([
        expect.objectContaining({ kind: "agent", identity: expect.objectContaining({ agentId: "agent-a" }) }),
        expect.objectContaining({ kind: "agent", identity: expect.objectContaining({ agentId: "agent-b" }) }),
      ]);
      expect(resolveFusionSessionPrincipal(cwd)).toEqual(expect.objectContaining({ kind: "ambiguous" }));
    } finally {
      disposeA();
      disposeB();
    }
  });

  it("uses marker-free ALS identity over a marker-bearing registry entry", async () => {
    const cwd = "/tmp/marker-precedence";
    registerFusionSessionIdentity(cwd, { agentId: "executor", taskExecutionSession: true });
    const principal = await runWithFusionSessionIdentity([cwd], { agentId: "heartbeat" }, async () => resolveFusionSessionPrincipal(cwd));
    expect(principal).toEqual(expect.objectContaining({ kind: "agent", identity: expect.objectContaining({ agentId: "heartbeat" }) }));
    expect(isTaskExecutionSessionPrincipal(principal)).toBe(false);
  });

  it("dispose is idempotent and only removes its own entry", () => {
    const disposeA = registerFusionSessionIdentity("/tmp/shared", { agentId: "agent-a" });
    registerFusionSessionIdentity("/tmp/shared", { agentId: "agent-b" });
    disposeA();
    disposeA();
    const principal = resolveFusionSessionPrincipal("/tmp/shared");
    expect(principal.kind).toBe("agent");
    if (principal.kind === "agent") {
      expect(principal.identity.agentId).toBe("agent-b");
    }
  });

  /*
  FNXC:SessionIdentity 2026-07-26-18:30:
  Review finding: the earlier version registered and resolved the SAME canonical
  string, which passes even if canonicalizeCwd stops resolving symlinks. Register
  through a genuine symlink alias and resolve through the real path (and vice
  versa) so the realpath folding is actually exercised. Cleanup removes both
  temporary artifacts.
  */
  it("resolves a symlink alias and its real path to one key", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "fusion-idreg-")));
    const alias = `${real}-alias`;
    symlinkSync(real, alias, "dir");
    try {
      const dispose = registerFusionSessionIdentity(alias, { agentId: "agent-real" });
      const viaReal = resolveFusionSessionPrincipal(real);
      expect(viaReal.kind).toBe("agent");
      if (viaReal.kind === "agent") {
        expect(viaReal.identity.agentId).toBe("agent-real");
      }
      const viaAlias = resolveFusionSessionPrincipal(alias);
      expect(viaAlias.kind).toBe("agent");
      dispose();
      expect(resolveFusionSessionPrincipal(real)).toEqual({ kind: "operator" });
      expect(resolveFusionSessionPrincipal(alias)).toEqual({ kind: "operator" });
    } finally {
      rmSync(alias, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

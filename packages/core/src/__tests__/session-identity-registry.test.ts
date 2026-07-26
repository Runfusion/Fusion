import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __clearFusionSessionIdentityRegistryForTests,
  registerFusionSessionIdentity,
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

  it("two live sessions on one cwd resolve to ambiguous (fail closed)", () => {
    registerFusionSessionIdentity("/tmp/project-root", { agentId: "agent-1" });
    registerFusionSessionIdentity("/tmp/project-root", { agentId: "agent-2" });
    const principal = resolveFusionSessionPrincipal("/tmp/project-root");
    expect(principal.kind).toBe("ambiguous");
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

  it("resolves symlinked/realpath spellings of the same directory to one key", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "fusion-idreg-")));
    registerFusionSessionIdentity(real, { agentId: "agent-real" });
    // macOS: tmpdir() often returns /var/... while realpath is /private/var/...
    const principal = resolveFusionSessionPrincipal(real);
    expect(principal.kind).toBe("agent");
  });
});

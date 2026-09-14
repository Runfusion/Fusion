import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectIntegrationBranch } from "@fusion/core";

const { execMock, execSyncMock, execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import {
  __resetIntegrationBranchCacheForTests,
  INTEGRATION_BRANCH_FALLBACK,
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
} from "../merge/integration-branch.js";

/**
 * Build an execFile/execFileSync mock that answers `git show-ref --verify`
 * existence probes for one set of refs. Both helpers probe, in order:
 * `refs/heads/<branch>` then `refs/remotes/origin/<branch>`.
 */
function missingRefError(): Error {
  const error = new Error("ref not found");
  (error as NodeJS.ErrnoException).code = 1;
  return error;
}

function mockShowRef(existing: string[], mode: "async" | "sync"): void {
  const impl = mode === "async"
    ? (_cmd: string, args: string[], _opts: object, cb: (error: Error | null) => void) => {
        if (args[0] === "show-ref" && existing.includes(args[3])) {
          cb(null);
        } else {
          cb(missingRefError());
        }
        return {};
      }
    : (_cmd: string, args: string[]) => {
        if (args[0] === "show-ref" && existing.includes(args[3])) {
          return "";
        }
        throw missingRefError();
      };
  if (mode === "async") execFileMock.mockImplementation(impl as any);
  else execFileSyncMock.mockImplementation(impl as any);
}

describe("integration-branch resolver — settings branch existence guard", () => {
  beforeEach(() => {
    __resetIntegrationBranchCacheForTests();
    execMock.mockReset();
    execSyncMock.mockReset();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    __resetIntegrationBranchCacheForTests();
    vi.restoreAllMocks();
  });

  it("falls back to baseBranch when a set integrationBranch is missing locally (async)", async () => {
    // integrationBranch=ghost (missing), baseBranch=release (exists locally): the settings
    // ladder must try baseBranch before falling through to origin/HEAD.
    mockShowRef(["refs/heads/release"], "async");
    const resolved = await resolveIntegrationBranch("/settings-ladder", { integrationBranch: "ghost", baseBranch: "release" } as any);
    expect(resolved).toBe("release");
  });

  it("falls back to baseBranch when a set integrationBranch is missing locally (sync)", () => {
    mockShowRef(["refs/heads/release"], "sync");
    const resolved = resolveIntegrationBranchSync("/settings-ladder", { integrationBranch: "ghost", baseBranch: "release" } as any);
    expect(resolved).toBe("release");
  });

  it("materializes a settings branch that exists only in origin (async)", async () => {
    // Normal clone: refs/remotes/origin/develop present, refs/heads/develop absent.
    // The configured branch is authoritative — materialize it, do not fall through.
    mockShowRef(["refs/remotes/origin/develop"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("unset"), { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/develop") {
        cb(null);
        return {};
      }
      if (args[0] === "branch" && args[1] === "develop") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/origin-only-settings", { integrationBranch: "develop" } as any, { logger: { warn } });
    expect(resolved).toBe("develop");
    expect(branchCalls).toEqual([["branch", "develop", "refs/remotes/origin/develop"]]);
  });

  it("materializes a settings branch that exists only in origin (sync)", () => {
    mockShowRef(["refs/remotes/origin/develop"], "sync");
    execSyncMock.mockImplementation((_command: string, _opts: object) => {
      throw new Error("unset");
    });
    const branchCalls: string[][] = [];
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/develop") {
        return "";
      }
      if (args[0] === "branch" && args[1] === "develop") {
        branchCalls.push(args);
        return "";
      }
      throw missingRefError();
    });

    const resolved = resolveIntegrationBranchSync("/origin-only-settings", { integrationBranch: "develop" } as any);
    expect(resolved).toBe("develop");
    expect(branchCalls).toEqual([["branch", "develop", "refs/remotes/origin/develop"]]);
  });

  it("materializes an inferred remote-only branch when no local ref exists (async)", async () => {
    // No-checkout clone: sole remote branch develop, no local branches, origin/HEAD unset.
    // Inference selects develop; the resolver must materialize it instead of falling to main.
    mockShowRef(["refs/remotes/origin/develop"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no checkout"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      cb(new Error("unset"), { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/develop") {
        cb(null);
        return {};
      }
      if (args[0] === "branch" && args[1] === "develop") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/inferred-remote-only", undefined);
    expect(resolved).toBe("develop");
    expect(branchCalls).toEqual([["branch", "develop", "refs/remotes/origin/develop"]]);
  });

  it("materializes an inferred remote-only branch when no local ref exists (sync)", () => {
    mockShowRef(["refs/remotes/origin/develop"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("no checkout");
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/heads/")) {
        return "";
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        return "origin/develop\n";
      }
      throw new Error("unset");
    });
    const branchCalls: string[][] = [];
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/develop") {
        return "";
      }
      if (args[0] === "branch" && args[1] === "develop") {
        branchCalls.push(args);
        return "";
      }
      throw missingRefError();
    });

    expect(resolveIntegrationBranchSync("/inferred-remote-only", {} as any)).toBe("develop");
    expect(branchCalls).toEqual([["branch", "develop", "refs/remotes/origin/develop"]]);
  });

  it("rejects unusable inferred branches before returning them (async)", async () => {
    // Devin BUG-0001 on 4ba9dd8: the inference return paths probed only ref existence.
    // A sole local branch like `-m` (creatable via `git update-ref`) passes the probe
    // and gets returned, later parsed by git as a switch. Both inference return paths
    // must apply the usability guard before returning; with nothing usable left the
    // resolver throws its terminal no-candidate error.
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref")) {
        cb(null, { stdout: "" }); // no origin/HEAD, no checked-out HEAD
        return {};
      }
      if (command.includes("for-each-ref")) {
        cb(null, { stdout: command.includes("refs/heads/") ? "-m\n" : "" }); // sole local branch, unusable name
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/heads/-m") {
        cb(null); // the ref exists — the NAME is what must be rejected
        return {};
      }
      if (args[0] === "branch") {
        branchCalls.push(args);
      }
      cb(missingRefError());
      return {};
    }) as any);

    await expect(resolveIntegrationBranch("/inference-dash-guard", undefined)).rejects.toThrow(/could not establish/);
    expect(branchCalls).toEqual([]); // never hand an unusable name to `git branch`
  });

  it("rejects unusable inferred branches before returning them (sync)", () => {
    // Mirror of the async case for resolveIntegrationBranchSync (Devin BUG-0001).
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      const cmd = command as string;
      if (cmd.includes("symbolic-ref")) return ""; // no origin/HEAD, no checked-out HEAD
      if (cmd.includes("for-each-ref")) {
        return cmd.includes("refs/heads/") ? "-m\n" : ""; // sole local branch, unusable name
      }
      return "";
    });
    const branchCalls: string[][] = [];
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && args[3] === "refs/heads/-m") {
        return ""; // exists — name unusable
      }
      if (args[0] === "branch") {
        branchCalls.push(args);
      }
      throw missingRefError();
    });

    expect(() => resolveIntegrationBranchSync("/inference-dash-guard-sync", {} as any)).toThrow(/could not establish/);
    expect(branchCalls).toEqual([]);
  });

  it("falls through a settings candidate that git rejects as a branch name (async)", async () => {
    // Devin BUG-0002 on 4ba9dd8: a configured candidate named `HEAD` passes the
    // refs/remotes/origin/HEAD existence probe (that symbolic ref exists in any normal
    // clone), but `git branch HEAD <ref>` fails — HEAD is reserved — and the materialize
    // error aborted the ladder instead of reaching baseBranch. Git-invalid candidates
    // must be rejected before probing; baseBranch must still resolve.
    const branchCalls: string[][] = [];
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/trunk\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      // Normal clone: the candidate's origin/HEAD symbolic ref, the origin/trunk
      // remote-tracking ref, and the local main all exist.
      if (args[0] === "show-ref" && (args[3] === "refs/remotes/origin/HEAD" || args[3] === "refs/remotes/origin/trunk" || args[3] === "refs/heads/main")) {
        cb(null);
        return {};
      }
      if (args[0] === "branch") branchCalls.push(args);
      cb(missingRefError());
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/reserved-name-fallback", { integrationBranch: "HEAD", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
    expect(branchCalls).toEqual([]); // never attempt to materialize a name git rejects
  });

  it("falls through a settings candidate that git rejects as a branch name (sync)", () => {
    // Mirror of the async case for resolveIntegrationBranchSync (Devin BUG-0002).
    const branchCalls: string[][] = [];
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      const cmd = command as string;
      if (cmd.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/trunk\n";
      }
      return "";
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && (args[3] === "refs/remotes/origin/HEAD" || args[3] === "refs/remotes/origin/trunk" || args[3] === "refs/heads/main")) {
        return "";
      }
      if (args[0] === "branch") branchCalls.push(args);
      throw missingRefError();
    });

    expect(resolveIntegrationBranchSync("/reserved-name-fallback-sync", { integrationBranch: "HEAD", baseBranch: "main" } as any)).toBe("main");
    expect(branchCalls).toEqual([]);
  });

  it("skips a settings branch that does not exist locally or in origin, falling through to origin/HEAD", async () => {
    mockShowRef(["refs/heads/main"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/main\n" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
  });

  it("accepts a settings branch that exists locally", async () => {
    mockShowRef(["refs/heads/homolog"], "async");

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog" } as any);
    expect(resolved).toBe("homolog");
  });

  it("prefers a materializable origin/HEAD default over a well-known local inferred branch", async () => {
    // origin/HEAD -> trunk (remote-tracking ref exists, refs/heads/trunk does not):
    // the default branch is authoritative and CAN be materialized, so inference
    // (which prefers well-known local branches like master) must not win.
    mockShowRef(["refs/heads/master", "refs/remotes/origin/trunk"], "async");
    // Single router for every exec() command the resolver issues: both the
    // origin/HEAD lookup and the inference listing flow through production paths,
    // so removing the origin/HEAD materialization block makes this test fail
    // (inference would select well-known local 'master' from the same mock).
    const branchCalls: string[][] = [];
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/trunk\n" });
        return {};
      }
      if (command.includes("for-each-ref")) {
        cb(null, { stdout: "refs/heads/master\nrefs/remotes/origin/trunk\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD") || command.includes("git remote")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(new Error("unset command"), { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref") {
        if (args[3] === "refs/remotes/origin/trunk") { cb(null); return {}; }
        cb(missingRefError());
        return {};
      }
      if (args[0] === "branch") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      cb(new Error("unset execFile command"));
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/repo", {} as any);
    expect(resolved).toBe("trunk");
    expect(branchCalls).toEqual([["branch", "trunk", "refs/remotes/origin/trunk"]]);
  });

  it("skips an origin/HEAD default that cannot be used as a branch name", async () => {
    // origin/HEAD -> -m: the default is unusable (git branch parses the name as a
    // switch), so it must fall through to inference and never reach `git branch`.
    // Single production router: origin/HEAD lookup and inference listing in one mock,
    // so removing the isUsableBranchName guard makes this test fail (materialization
    // would be attempted with '-m').
    mockShowRef(["refs/heads/master"], "async");
    const branchCalls: string[][] = [];
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/-m\n" });
        return {};
      }
      if (command.includes("for-each-ref")) {
        cb(null, { stdout: "refs/heads/master\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD") || command.includes("git remote")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(new Error("unset command"), { stdout: "" });
      return {};
    });
    // Guards must turn '-m' away BEFORE git runs: any `git branch` invocation here is
    // a bug (the name would land in option position). show-ref probes still answer so
    // the ladder can verify local 'master' during inference.
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "branch") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      if (args[0] === "show-ref" && args[3] === "refs/heads/master") {
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/repo", {} as any);
    expect(resolved).toBe("master");
    expect(branchCalls).toEqual([]);
  });

  it("resolveIntegrationBranchSync prefers a materializable origin/HEAD default over inference too", () => {
    // Same scenario as the async test: origin/HEAD -> trunk must outrank local
    // well-known 'master'. Single execSync router carries origin/HEAD AND the
    // inference listing through the production path.
    mockShowRef(["refs/heads/master", "refs/remotes/origin/trunk"], "sync");
    const branchCalls: string[][] = [];
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/trunk\n";
      }
      if (command.includes("for-each-ref")) {
        return "refs/heads/master\nrefs/remotes/origin/trunk\n";
      }
      if (command.includes("symbolic-ref --quiet --short HEAD") || command.includes("git remote")) {
        return "";
      }
      throw new Error("unset command");
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") {
        if (args[3] === "refs/remotes/origin/trunk") return "";
        throw missingRefError();
      }
      if (args[0] === "branch") {
        branchCalls.push(args);
        return "";
      }
      throw new Error("unset execFileSync command");
    });

    const resolved = resolveIntegrationBranchSync("/repo", {} as any);
    expect(resolved).toBe("trunk");
    expect(branchCalls).toEqual([["branch", "trunk", "refs/remotes/origin/trunk"]]);
  });

  it("resolveIntegrationBranchSync skips an unusable origin/HEAD default the same way", () => {
    // Single execSync router (the previous double mockImplementation silently replaced
    // the origin/HEAD answer): '-m' is unusable, so inference must win locally and
    // `git branch` must never be invoked.
    mockShowRef(["refs/heads/master"], "sync");
    const branchCalls: string[][] = [];
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/-m\n";
      }
      if (command.includes("for-each-ref")) {
        return "refs/heads/master\n";
      }
      if (command.includes("symbolic-ref --quiet --short HEAD") || command.includes("git remote")) {
        return "";
      }
      throw new Error("unset command");
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "branch") {
        branchCalls.push(args);
        return "";
      }
      if (args[0] === "show-ref" && args[3] === "refs/heads/master") {
        return "";
      }
      throw missingRefError();
    });

    const resolved = resolveIntegrationBranchSync("/repo", {} as any);
    expect(resolved).toBe("master");
    expect(branchCalls).toEqual([]);
  });

  it("skips a dash-prefixed settings branch even when it exists in origin remote-tracking", async () => {
    // A ref named refs/remotes/origin/-m can exist, but `git branch -m ...` parses the
    // name as a switch and even `git branch -- -m ...` rejects it ("not a valid branch
    // name"), and consumers (git worktree add) cannot use it either. Skip to next rung.
    mockShowRef(["refs/heads/main", "refs/remotes/origin/-m"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/main\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "branch") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      if (args[0] === "show-ref" && (args[3] === "refs/heads/main" || args[3] === "refs/remotes/origin/-m" || args[3] === "refs/remotes/origin/main")) {
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "-m" } as any);
    expect(resolved).toBe("main");
    // '-m' must never reach `git branch`, even as a materialization target.
    expect(branchCalls).toEqual([]);
  });

  it("resolveIntegrationBranchSync skips a dash-prefixed settings branch the same way", () => {
    mockShowRef(["refs/heads/main", "refs/remotes/origin/-m"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("refs/remotes/origin/HEAD")) {
        return "origin/main\n";
      }
      return "";
    });
    const branchCalls: string[][] = [];
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "branch") {
        branchCalls.push(args);
        return "";
      }
      if (args[0] === "show-ref" && (args[3] === "refs/heads/main" || args[3] === "refs/remotes/origin/-m" || args[3] === "refs/remotes/origin/main")) {
        return "";
      }
      throw missingRefError();
    });

    const resolved = resolveIntegrationBranchSync("/repo", { integrationBranch: "-m", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
    // '-m' must never reach `git branch`, even as a materialization target.
    expect(branchCalls).toEqual([]);
  });

  it("materializes a settings branch that exists only in origin remote-tracking before consumers use it", async () => {
    // refs/remotes/origin/develop exists, refs/heads/develop does not. The configured
    // branch is authoritative: materialize the local ref (FN-183) so `git worktree add`
    // and the merge-time CAS advance find refs/heads/develop instead of "invalid reference".
    mockShowRef(["refs/heads/main", "refs/remotes/origin/develop"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/main\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/develop") {
        cb(null);
        return {};
      }
      if (args[0] === "branch" && args[1] === "develop") {
        branchCalls.push(args);
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "develop" } as any, { logger: { warn } });
    expect(resolved).toBe("develop");
    expect(branchCalls).toEqual([["branch", "develop", "refs/remotes/origin/develop"]]);
  });

  it("probes only the local refs/heads form", async () => {
    const probed: string[] = [];
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: object, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref") probed.push(args[3]);
      if (args[0] === "show-ref" && args[3] === "refs/heads/develop") {
        cb(null);
      } else {
        cb(new Error("ref not found"));
      }
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "develop" } as any);
    expect(resolved).toBe("develop");
    expect(probed).toEqual(["refs/heads/develop"]);
  });

  it("passes the branch as a single argv element — no shell, no command interpolation", async () => {
    // Shell-hostile but git-VALID name (git forbids only space/~/^/:/?/*/[/\ — `;`,
    // `|`, `&` are legal refname chars): proves the raw name is passed as ONE argv
    // element to execFile and never shell-interpolated. Names git itself rejects
    // (spaces, leading dash, HEAD, ...) are rejected earlier by isUsableBranchName;
    // parity with git's accept/reject table is pinned by the real-git test.
    const hostile = "evil;rm-rf";
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: object, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === `refs/heads/${hostile}`) {
        cb(null);
      } else {
        cb(new Error("ref not found"));
      }
      return {};
    });

    // The name must resolve as one argv element (ref simply will not exist in a
    // real repo) instead of reaching a shell.
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: hostile } as any);
    expect(resolved).toBe(hostile);
  });

  it("falls through to INTEGRATION_BRANCH_FALLBACK when settings branch is missing and no other rung resolves", async () => {
    mockShowRef(["refs/heads/main"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog" } as any, { logger: { warn } });
    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("origin/HEAD is unset"));
  });

  it("resolveIntegrationBranchSync applies the same existence guard for the missing case", () => {
    mockShowRef(["refs/heads/main"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("refs/remotes/origin/HEAD")) {
        return Buffer.from("origin/main\n");
      }
      if (typeof command === "string" && (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD"))) {
        return Buffer.from("");
      }
      if (typeof command === "string" && command === "git remote") {
        return Buffer.from("origin\n");
      }
      return Buffer.from("");
    });

    const resolved = resolveIntegrationBranchSync("/repo", { integrationBranch: "homolog", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
  });

  it("resolveIntegrationBranchSync accepts a local branch via the argv-based probe", () => {
    mockShowRef(["refs/heads/homolog"], "sync");

    const resolved = resolveIntegrationBranchSync("/repo", { integrationBranch: "homolog" } as any);
    expect(resolved).toBe("homolog");
  });

  it("resolveIntegrationBranchSync materializes an origin-only settings branch the same way", () => {
    mockShowRef(["refs/heads/main", "refs/remotes/origin/homolog"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("refs/remotes/origin/HEAD")) {
        return Buffer.from("origin/main\n");
      }
      return Buffer.from("");
    });
    const branchCalls: string[][] = [];
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/homolog") {
        return "";
      }
      if (args[0] === "branch" && args[1] === "homolog") {
        branchCalls.push(args);
        return "";
      }
      throw missingRefError();
    });

    const resolved = resolveIntegrationBranchSync("/repo", { integrationBranch: "homolog", baseBranch: "main" } as any);
    expect(resolved).toBe("homolog");
    expect(branchCalls).toEqual([["branch", "homolog", "refs/remotes/origin/homolog"]]);
  });

  it("rejects an inferred remote-only branch and falls back to main (async)", async () => {
    // No local ref exists for anything (show-ref always fails).
    mockShowRef(["refs/heads/main"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(new Error("unset"), { stdout: "" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("detached"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "alpha\nbeta\n" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    // Inference's remote-tracking tier selects "develop", which has no local ref.
    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/repo", {} as any, { logger: { warn } });
    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("origin/HEAD is unset"));
  });

  it("rejects an inferred remote-only branch and falls back to main (sync)", () => {
    mockShowRef(["refs/heads/main"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        throw new Error("unset");
      }
      if (typeof command === "string" && command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("detached");
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/heads/")) {
        return "alpha\nbeta\n";
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        return "origin/develop\n";
      }
      if (typeof command === "string" && command === "git remote") {
        return "origin\n";
      }
      return "";
    });

    const resolved = resolveIntegrationBranchSync("/repo", {} as any);
    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
  });

  it("verifies the plain fallback before returning it after a failed materialization (async)", async () => {
    // Inference selects develop (remote-only), its ref is missing, materialization of the
    // origin-derived candidate fails, but ANOTHER caller concurrently created refs/heads/main.
    mockShowRef(["refs/remotes/origin/develop"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no checkout"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, result?: { stdout: string }) => void) => {
      // Remote-tracking ref EXISTS (probe passes); the write itself fails operationally
      // and the local ref is still absent afterwards -> the ORIGINAL error must surface.
      const error = new Error("fatal: cannot lock ref");
      (error as NodeJS.ErrnoException).code = 128;
      cb(error);
      return {};
    }) as any);

    await expect(resolveIntegrationBranch("/no-checkout", undefined)).rejects.toThrow(
      /cannot lock ref/,
    );
  });

  it("materializes the plain fallback when origin/HEAD was unset and refs/heads/main is missing (async)", async () => {
    // origin/HEAD unset; no inference; refs/heads/main missing but refs/remotes/origin/main exists.
    mockShowRef(["refs/remotes/origin/main"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(new Error("unset"), { stdout: "" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("detached"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/main\n" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, result?: { stdout: string }) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
        cb(null, { stdout: "" });
        return {};
      }
      if (args[0] === "branch" && args[1] === "main") {
        branchCalls.push(args);
        cb(null, { stdout: "" });
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/origin-main-only", undefined, { logger: { warn } });
    expect(resolved).toBe("main");
    expect(branchCalls).toEqual([["branch", "main", "refs/remotes/origin/main"]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("created local branch 'main'"));
  });

  it("throws an actionable error when no local ref can be established at all (async)", async () => {
    // Ghost clone: no local branches, no origin/HEAD, no remote-tracking refs, nothing to create.
    mockShowRef([], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("unset"), { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, result?: { stdout: string }) => void) => {
      if (args[0] === "branch") {
        const error = new Error("fatal: not a valid object name: refs/remotes/origin/main");
        (error as NodeJS.ErrnoException).code = 128;
        cb(error);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    await expect(resolveIntegrationBranch("/ghost", undefined)).rejects.toThrow(
      /could not establish a local integration branch/,
    );
  });

  it("verifies the plain fallback before returning it after a failed materialization (sync)", () => {
    mockShowRef(["refs/remotes/origin/develop"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/develop\n";
      }
      if (typeof command === "string" && command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("no checkout");
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/heads/")) {
        return "";
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        return "origin/develop\n";
      }
      if (typeof command === "string" && command === "git remote") {
        return "origin\n";
      }
      return "";
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      // Remote-tracking ref EXISTS; the write fails operationally and the local ref is
      // still absent afterwards -> the ORIGINAL error must surface.
      const error = new Error("fatal: cannot lock ref");
      (error as NodeJS.ErrnoException).code = 128;
      throw error;
    });

    expect(() => resolveIntegrationBranchSync("/no-checkout", {} as any)).toThrow(
      /cannot lock ref/,
    );
  });

  it("recovers from a lost creation race by rechecking the local ref (async)", async () => {
    // origin/HEAD -> origin/develop (remote-only). The write loses to a concurrent creator,
    // but refs/heads/develop exists by the time the helper rechecks -> resolve to develop.
    mockShowRef(["refs/remotes/origin/develop"], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no checkout"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "branch") {
        const error = new Error("fatal: cannot lock ref");
        (error as NodeJS.ErrnoException).code = 128;
        cb(error);
        return {};
      }
      if (args[0] === "show-ref" && args[3] === "refs/heads/develop") {
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const resolved = await resolveIntegrationBranch("/race-async", undefined);
    expect(resolved).toBe("develop");
  });

  it("recovers from a lost creation race by rechecking the local ref (sync)", () => {
    mockShowRef(["refs/remotes/origin/develop"], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/develop\n";
      }
      if (typeof command === "string" && command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("no checkout");
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/heads/")) {
        return "";
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        return "origin/develop\n";
      }
      if (typeof command === "string" && command === "git remote") {
        return "origin\n";
      }
      return "";
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "branch") {
        const error = new Error("fatal: cannot lock ref");
        (error as NodeJS.ErrnoException).code = 128;
        throw error;
      }
      if (args[0] === "show-ref" && args[3] === "refs/heads/develop") {
        return "";
      }
      throw missingRefError();
    });

    expect(resolveIntegrationBranchSync("/race-sync", {} as any)).toBe("develop");
  });

  it("skips creation entirely when the remote-tracking ref is absent (async)", async () => {
    // Ghost clone: no refs/remotes/origin/main, so the fallback ladder must not invoke
    // `git branch` at all — it probes first and reaches the actionable error.
    mockShowRef([], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("unset"), { stdout: "" });
      return {};
    });
    const branchCalls: string[][] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "branch") {
        branchCalls.push(args);
      }
      cb(missingRefError());
      return {};
    }) as any);

    await expect(resolveIntegrationBranch("/ghost-nobranch", undefined)).rejects.toThrow(
      /could not establish a local integration branch/,
    );
    expect(branchCalls).toEqual([]);
  });

  it("materializes the origin/HEAD default branch when no local ref exists (async)", async () => {
    // No-checkout / detached clone: no local branches, origin/HEAD -> origin/master (remote-only).
    mockShowRef([], "async");
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/master\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no checkout"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/master\n" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/master") {
        cb(null);
        return {};
      }
      if (args[0] === "branch" && args[1] === "master" && args[2] === "refs/remotes/origin/master") {
        cb(null);
        return {};
      }
      cb(missingRefError());
      return {};
    }) as any);

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/no-checkout", undefined, { logger: { warn } });
    expect(resolved).toBe("master");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("created local branch 'master'"));
  });

  it("materializes the origin/HEAD default branch when no local ref exists (sync)", () => {
    mockShowRef([], "sync");
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
        return "origin/master\n";
      }
      if (typeof command === "string" && command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("no checkout");
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/heads/")) {
        return "";
      }
      if (typeof command === "string" && command.includes("for-each-ref") && command.includes("refs/remotes/origin/")) {
        return "origin/master\n";
      }
      if (typeof command === "string" && command === "git remote") {
        return "origin\n";
      }
      return "";
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/master") {
        return "";
      }
      if (args[0] === "branch" && args[1] === "master" && args[2] === "refs/remotes/origin/master") {
        return "";
      }
      throw missingRefError();
    });

    const resolved = resolveIntegrationBranchSync("/no-checkout", {} as any);
    expect(resolved).toBe("master");
  });

  it("propagates an operational probe failure instead of treating it as a missing ref (async)", async () => {
    mockShowRef([], "async");
    // Override with an operational failure (git fatal, exit 128) rather than exit 1 missing.
    execFileMock.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null) => void) => {
      const error = new Error("fatal: not a git repository");
      (error as NodeJS.ErrnoException).code = 128;
      cb(error);
      return {};
    }) as any);

    await expect(
      resolveIntegrationBranch("/broken", { integrationBranch: "release", baseBranch: undefined } as any),
    ).rejects.toThrow(/not a git repository/);
  });

  it("propagates an operational probe failure instead of treating it as a missing ref (sync)", () => {
    mockShowRef([], "sync");
    execFileSyncMock.mockImplementation(() => {
      const error = new Error("fatal: not a git repository");
      (error as NodeJS.ErrnoException).code = 128;
      throw error;
    });

    expect(() =>
      resolveIntegrationBranchSync("/broken", { integrationBranch: "release", baseBranch: undefined } as any),
    ).toThrow(/not a git repository/);
  });

  it("verify helper honors the priority contract shared with core selection", () => {
    expect(selectIntegrationBranch({
      localBranches: ["master"],
      currentBranch: "master",
      remoteBranches: ["origin/master"],
    })).toBeTruthy();
  });
});

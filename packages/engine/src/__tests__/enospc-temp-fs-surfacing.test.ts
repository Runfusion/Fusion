import { describe, expect, it, vi } from "vitest";

import { guardCreationError, EngineAlreadyRunningError, EngineStartupEnvironmentError } from "../project/engine-singleton-lock.js";
import { verificationTempFsSuffix } from "../execution/run-verification-tool.js";
import type { TempFsStatfsLike } from "@fusion/core";

/*
FNXC:TempFsDiagnostics 2026-11-03-08:12 (RUFU-397):
Two failure records, one misdiagnosis. A verification spawn reports errno 28 and the operator reads
"out of disk" while `df -h` shows 56 G free; engine boot reports "another engine is already running"
when no second engine exists. The verification case is a wording problem, the boot case is a CONTROL
problem — `project-engine-manager.ts` treats `EngineAlreadyRunningError` as proof the engine is live
and skips the project silently — so the two need different assertions: the spawn case asserts the
class arrives in the recorded text, the boot case asserts the consumer's `instanceof` leg does NOT fire.
*/

/** Measured host shape: 0 of 1048576 inodes free while 52 G of bytes are free. */
const INODE_EXHAUSTED: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: (52 * 1024 ** 3) / 4096,
  files: 1048576,
  ffree: 0,
};

const ENOSPC_SPAWN = Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" });
/** The boot shape: a loopback bind refused by errno 28, naming the address it could not create. */
const ENOSPC_SOCKET = Object.assign(
  new Error("listen ENOSPC: no space left on device, /tmp/fusion-engine-abc.sock"),
  { code: "ENOSPC" },
);

describe("fn_run_verification names the temp-fs class on a recorded failure", () => {
  it("appends the class when the spawn error warning names ENOSPC", () => {
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "", warnings: [`Spawn error: ${ENOSPC_SPAWN.message}`] },
      [],
      { statfs: () => INODE_EXHAUSTED },
    );
    expect(suffix).toContain("inode-exhausted");
    expect(suffix).toContain("0 of 1048576 inodes free");
    expect(suffix).toContain("52G bytes free");
  });

  it("appends the class when the failure appears in captured stderr instead of the spawn warning", () => {
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "fatal: could not create temp dir: no space left on device", warnings: [] },
      [],
      { statfs: () => INODE_EXHAUSTED },
    );
    expect(suffix).toContain("inode-exhausted");
  });

  it("probes at most once per recorded failure", () => {
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    verificationTempFsSuffix({ stdout: "ENOSPC", stderr: "ENOSPC", warnings: ["ENOSPC"] }, ["ENOSPC"], { statfs });
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it("records nothing extra for a non-ENOSPC failure and never pays for a probe", () => {
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "Tests 3 failed", warnings: ["Command terminated (SIGTERM)."] },
      [],
      { statfs },
    );
    expect(suffix).toBe("");
    expect(statfs).not.toHaveBeenCalled();
  });

  it("records nothing extra when the probe has no opinion (degrade to the original text)", () => {
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "ENOSPC: no space left on device", warnings: [] },
      [],
      { statfs: () => { throw new Error("statfs unsupported"); } },
    );
    expect(suffix).toBe("");
  });

  it("keeps the ENOSPC token present so the honest-blocked classifier still matches", () => {
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "no space left on device", warnings: [] },
      [],
      { statfs: () => INODE_EXHAUSTED },
    );
    // The child's prose alone carries no `ENOSPC` token; the class line supplies it.
    expect(suffix).toMatch(/\bENOSPC\b/);
  });
});

describe("engine boot does not misread ENOSPC as an already-running engine", () => {
  it("throws a non-EngineAlreadyRunningError when guard creation fails with an inode-exhausted ENOSPC", () => {
    const err = guardCreationError(ENOSPC_SPAWN, "proj-1", "socket", "/tmp/fusion-engine-abc.sock", {
      statfs: () => INODE_EXHAUSTED,
    });

    // The consumer's leg: `result.reason instanceof EngineAlreadyRunningError` -> skip silently.
    expect(err).not.toBeInstanceOf(EngineAlreadyRunningError);
    expect(err).toBeInstanceOf(EngineStartupEnvironmentError);
    expect(err.name).toBe("EngineStartupEnvironmentError");
    expect(err.message).toContain("inode-exhausted");
    expect(err.message).toContain("0 of 1048576 inodes free");
    expect(err.message).toMatch(/\bENOSPC\b/);
  });

  /*
  FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
  The production shape of the boot failure, with a PATH-AWARE probe. `net.Server.listen()` is refused
  by bind() with errno 28 before the `.sock` file exists, so the literal target answers ENOENT and the
  capacity numbers live only on the containing tmpfs. The case above uses a path-blind fake that
  answers for every path, which is precisely why the first revision shipped a classification that
  could never fire in production while staying green. This is the non-vacuous lock for that defect.
  */
  it("still names the class when the socket path itself cannot be statfs'd (production shape)", () => {
    const statfs = vi.fn((path: string) => {
      if (path !== "/tmp") {
        throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${path}'`), { code: "ENOENT" });
      }
      return INODE_EXHAUSTED;
    });

    const err = guardCreationError(ENOSPC_SOCKET, "proj-1", "socket", "/tmp/fusion-engine-abc.sock", { statfs });

    expect(err).toBeInstanceOf(EngineStartupEnvironmentError);
    expect(err).not.toBeInstanceOf(EngineAlreadyRunningError);
    expect(err.message).toContain("inode-exhausted");
    // The record names the mount that refused, not the socket file that was never created.
    expect(err.message).toContain("on /tmp ");
    expect(statfs.mock.calls.map((call) => call[0])).toEqual([
      "/tmp/fusion-engine-abc.sock",
      "/tmp",
    ]);
  });

  it("keeps EngineAlreadyRunningError when a Windows named-pipe address yields no filesystem reading", () => {
    // A pipe is not a filesystem path: every probe fails, so the pre-existing leg must survive intact.
    const statfs = vi.fn(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    const pipeEnospc = Object.assign(
      new Error("listen ENOSPC: no space left on device, \\\\\\\\.\\\\pipe\\\\fusion-engine-abc"),
      { code: "ENOSPC" },
    );

    const err = guardCreationError(pipeEnospc, "proj-1", "socket", "\\\\.\\pipe\\fusion-engine-abc", { statfs });

    expect(err).toBeInstanceOf(EngineAlreadyRunningError);
    expect(err.message).not.toContain("temp-fs class");
  });

  it("keeps EngineAlreadyRunningError for a genuine already-bound address", () => {
    const eaddrinuse = Object.assign(
      new Error("listen EADDRINUSE: address already in use /tmp/fusion-engine-abc.sock"),
      { code: "EADDRINUSE" },
    );
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    const err = guardCreationError(eaddrinuse, "proj-1", "socket", "/tmp/fusion-engine-abc.sock", { statfs });

    expect(err).toBeInstanceOf(EngineAlreadyRunningError);
    expect(err.message).toBe("Another engine is already running for project proj-1 on this machine (blocked by socket)");
    expect((err as EngineAlreadyRunningError).reason).toBe("socket");
    expect(statfs).not.toHaveBeenCalled();
  });

  it("keeps EngineAlreadyRunningError for an ENOSPC the probe cannot classify (no opinion, no reclassification)", () => {
    const err = guardCreationError(ENOSPC_SPAWN, "proj-1", "lockfile", "/repo", {
      statfs: () => { throw new Error("statfs unsupported"); },
    });
    expect(err).toBeInstanceOf(EngineAlreadyRunningError);
    expect((err as EngineAlreadyRunningError).reason).toBe("lockfile");
  });

  it("carries the original error as cause so the underlying sentence is never lost", () => {
    const err = guardCreationError(ENOSPC_SPAWN, "proj-1", "lockfile", "/repo", {
      statfs: () => INODE_EXHAUSTED,
    }) as { cause?: unknown };
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain("ENOSPC");
  });
});

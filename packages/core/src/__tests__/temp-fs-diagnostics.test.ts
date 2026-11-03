import { describe, expect, it, vi } from "vitest";

import {
  annotateEnospcError,
  annotateEnospcFailure,
  classifyTempFs,
  isEnospcFailureText,
  type TempFsStatfsLike,
} from "../temp-fs-diagnostics.js";
import {
  annotateEnospcFailure as annotateEnospcFailureGate,
  classifyTempFs as classifyTempFsGate,
} from "../index.gate.js";

/*
FNXC:TempFsDiagnostics 2026-11-03-08:05 (RUFU-397):
The measured shape this exists for: on 2026-09-28 the operator host's tmpfs had 0 of 1048576 inodes
free while 52 G of bytes were free, and every tmpdir creation failed with `errno 28`. Node's sentence
for that is byte-identical to a genuinely full disk, so the class only becomes diagnosable once a
record names it. These tests are fake-based by contract — no real tmpfs, no polling, no host state —
because the host condition is operator-owned and cannot be reproduced on demand.
*/

/** Measured card shape: inode table exhausted, bytes plentiful (bavail * 4096 == 52 G exactly). */
const INODE_EXHAUSTED: TempFsStatfsLike = {
  type: 16914836,
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: (52 * 1024 ** 3) / 4096,
  files: 1048576,
  ffree: 0,
};

/** The opposite failure: the device is out of bytes while its inode table is nearly untouched. */
const BYTES_FULL: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 480431430,
  bfree: 0,
  bavail: 0,
  files: 122101760,
  ffree: 107969693,
};

/** A healthy filesystem: neither resource is exhausted, so the helper must stay silent. */
const HEALTHY: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: 14598829,
  files: 1048576,
  ffree: 586140,
};

const MKDMTEMP_ENOSPC = "ENOSPC: no space left on device, mkdtemp '/tmp/fusion-ai-merge-fn-1-abc'";

function throwingStatfs(message: string) {
  return vi.fn(() => {
    throw new Error(message);
  });
}

describe("classifyTempFs", () => {
  it("names the measured bytes-free / inodes-exhausted shape", () => {
    const verdict = classifyTempFs("/tmp", { statfs: () => INODE_EXHAUSTED });
    expect(verdict?.cls).toBe("inode-exhausted");
    expect(verdict?.freeInodes).toBe(0);
    expect(verdict?.totalInodes).toBe(1048576);
    expect(verdict?.freeBytes).toBe(52 * 1024 ** 3);
  });

  it("reports the byte-full class for a genuinely byte-full device, never inode-exhausted", () => {
    const verdict = classifyTempFs("/disk", { statfs: () => BYTES_FULL });
    expect(verdict?.cls).toBe("bytes-full");
    expect(verdict?.freeBytes).toBe(0);
  });

  it("degrades to no opinion when statfs throws (unsupported platform / vanished path)", () => {
    expect(classifyTempFs("/pipe-ish-address", { statfs: throwingStatfs("ENOSYS: function not implemented") })).toBeUndefined();
  });

  it("treats implausible shapes as unsupported rather than exhausted", () => {
    // Zero totals are what a filesystem that does not report an inode table returns.
    expect(classifyTempFs("/x", { statfs: () => ({ ...INODE_EXHAUSTED, files: 0, ffree: 0, blocks: 0 }) })).toBeUndefined();
    expect(classifyTempFs("/x", { statfs: () => ({ ...INODE_EXHAUSTED, ffree: -1 }) })).toBeUndefined();
    expect(classifyTempFs("/x", { statfs: () => ({ ...INODE_EXHAUSTED, ffree: 2_000_000 }) })).toBeUndefined();
    // Missing fields (a statfs implementation without inode accounting) are likewise no opinion.
    expect(classifyTempFs("/x", { statfs: () => ({ blocks: 100, bavail: 100 }) })).toBeUndefined();
  });

  it("returns unknown (not a verdict worth printing) for a healthy filesystem", () => {
    expect(classifyTempFs("/tmp", { statfs: () => HEALTHY })?.cls).toBe("unknown");
  });

  it("refuses to blame inodes when the disk is also close to byte-full", () => {
    // ffree === 0 but only ~256 MiB free: the byte pressure is the honest explanation.
    const nearFull: TempFsStatfsLike = { ...INODE_EXHAUSTED, bavail: (256 * 1024 ** 2) / 4096 };
    expect(classifyTempFs("/tmp", { statfs: () => nearFull })?.cls).toBe("unknown");
  });

  it("never throws for an empty or unresolvable target path", () => {
    expect(classifyTempFs("", { statfs: () => INODE_EXHAUSTED })).toBeUndefined();
  });

  /*
  FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
  These are the tests the first revision lacked. Every mandated site fails on a CREATION, so its
  target path was never created and `statfs` answers ENOENT on it — the literal-target probe was dead
  in production while a path-blind fake (`() => INODE_EXHAUSTED`, which answers for ANY path) kept the
  suite green. A fake that resolves paths is what makes this seam non-vacuous: it fails the old code
  and passes the new one.
  */
  it("reads the nearest existing ancestor when the failed creation's own target does not exist", () => {
    const statfs = vi.fn((path: string) => {
      if (path !== "/tmp") {
        throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${path}'`), { code: "ENOENT" });
      }
      return INODE_EXHAUSTED;
    });

    // The engine's boot socket: refused by bind() before the socket file ever existed.
    const verdict = classifyTempFs("/tmp/fusion-engine-abc123.sock", { statfs });
    expect(verdict?.cls).toBe("inode-exhausted");
    expect(verdict?.probedPath).toBe("/tmp");
    expect(statfs.mock.calls.map((call) => call[0])).toEqual([
      "/tmp/fusion-engine-abc123.sock",
      "/tmp",
    ]);
  });

  it("climbs more than one level when the whole tail of the path is missing", () => {
    // Merge clean room: the `.ai-merge` root itself could not be created either.
    const statfs = vi.fn((path: string) => {
      if (path !== "/repo/.worktrees") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return INODE_EXHAUSTED;
    });
    expect(classifyTempFs("/repo/.worktrees/.ai-merge/fusion-ai-merge-fn-1-ab", { statfs })?.cls)
      .toBe("inode-exhausted");
  });

  it("stops climbing at a bounded number of hops instead of walking the filesystem", () => {
    // Nothing on this chain exists, so the walk must terminate with no opinion rather than probing
    // toward the root indefinitely.
    const statfs = vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(classifyTempFs("/a/b/c/d/e/f/g/h/i/j/missing.sock", { statfs })).toBeUndefined();
    expect(statfs.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("never reports a phantom target as the filesystem that refused", () => {
    const statfs = vi.fn((path: string) => {
      if (path !== "/tmp") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return INODE_EXHAUSTED;
    });
    const annotated = annotateEnospcFailure(
      "listen ENOSPC: no space left on device, /tmp/fusion-engine-abc.sock",
      "/tmp/fusion-engine-abc.sock",
      { statfs },
    );
    expect(annotated).toContain("on /tmp ");
    expect(annotated).not.toContain("on /tmp/fusion-engine-abc.sock");
  });
});

describe("annotateEnospcFailure", () => {
  it("appends the class with both measured figures and no bare 'no space left' reading", () => {
    const annotated = annotateEnospcFailure(MKDMTEMP_ENOSPC, "/tmp", { statfs: () => INODE_EXHAUSTED });
    expect(annotated).toContain("inode-exhausted");
    expect(annotated).toContain("0 of 1048576 inodes free");
    expect(annotated).toContain("52G bytes free");
    expect(annotated).toContain("not a byte-full disk");
    // The original sentence is preserved verbatim ahead of the annotation.
    expect(annotated.startsWith(MKDMTEMP_ENOSPC)).toBe(true);
  });

  it("keeps the literal ENOSPC token in every annotated form (classifier compat)", () => {
    const proseOnly = "mkdir failed: no space left on device";
    for (const base of [MKDMTEMP_ENOSPC, proseOnly, "errno 28 while creating a scratch dir"]) {
      const annotated = annotateEnospcFailure(base, "/tmp", { statfs: () => INODE_EXHAUSTED });
      expect(annotated).toMatch(/\bENOSPC\b/);
    }
  });

  it("reports the byte-full class for a byte-full disk and never claims inode exhaustion", () => {
    const annotated = annotateEnospcFailure(MKDMTEMP_ENOSPC, "/disk", { statfs: () => BYTES_FULL });
    expect(annotated).toContain("bytes-full");
    expect(annotated).not.toContain("inode-exhausted");
  });

  it("returns the message unchanged when the probe fails (degrade, never lose the original)", () => {
    expect(annotateEnospcFailure(MKDMTEMP_ENOSPC, "/tmp", { statfs: throwingStatfs("statfs unsupported") })).toBe(MKDMTEMP_ENOSPC);
  });

  it("does not probe at all for a non-ENOSPC failure", () => {
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    const message = "ENOENT: no such file or directory, mkdir '/nope'";
    expect(annotateEnospcFailure(message, "/tmp", { statfs })).toBe(message);
    expect(statfs).not.toHaveBeenCalled();
  });

  it("passes through a message with neither a code nor an errno-28 sentence", () => {
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    expect(annotateEnospcFailure("command not found: pnpm", "/tmp", { statfs })).toBe("command not found: pnpm");
    expect(statfs).not.toHaveBeenCalled();
  });

  it("leaves a healthy-filesystem ENOSPC message unannotated rather than inventing a class", () => {
    expect(annotateEnospcFailure(MKDMTEMP_ENOSPC, "/tmp", { statfs: () => HEALTHY })).toBe(MKDMTEMP_ENOSPC);
  });

  it("judges only the path actually targeted, not some other path in the message", () => {
    // The message names a scratch path; the caller passes the real target, whose filesystem is fine.
    const statfs = vi.fn((path: string) => (path === "/disk" ? BYTES_FULL : HEALTHY));
    const annotated = annotateEnospcFailure(MKDMTEMP_ENOSPC, "/disk", { statfs });
    expect(statfs.mock.calls.map((call) => call[0])).toEqual(["/disk"]);
    expect(annotated).toContain("bytes-full");
    expect(annotated).not.toContain("on /tmp");
  });

  it("isEnospcFailureText recognises both the token and the prose forms", () => {
    expect(isEnospcFailureText(MKDMTEMP_ENOSPC)).toBe(true);
    expect(isEnospcFailureText("no space left on device")).toBe(true);
    expect(isEnospcFailureText("errno 28")).toBe(true);
    expect(isEnospcFailureText("EDQUOT: quota exceeded")).toBe(false);
  });
});

describe("annotateEnospcError", () => {
  it("wraps an errno-coded ENOSPC error, keeping the code and the cause", () => {
    const original = Object.assign(new Error("no space left on device, mkdtemp"), { code: "ENOSPC" });
    const wrapped = annotateEnospcError(original, "/tmp", { statfs: () => INODE_EXHAUSTED });
    expect(wrapped).not.toBe(original);
    expect((wrapped as Error).message).toContain("inode-exhausted");
    // The classifier keys on the token, and code-branching consumers need the code retained.
    expect((wrapped as Error).message).toMatch(/\bENOSPC\b/);
    expect((wrapped as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect((wrapped as { cause?: unknown }).cause).toBe(original);
  });

  it("is a provable no-op for a non-ENOSPC error (same object, no wrapper)", () => {
    const original = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    expect(annotateEnospcError(original, "/tmp", { statfs })).toBe(original);
    expect(statfs).not.toHaveBeenCalled();
  });

  it("returns the original error when the probe has no opinion", () => {
    const original = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    expect(annotateEnospcError(original, "/tmp", { statfs: throwingStatfs("unsupported") })).toBe(original);
    expect(annotateEnospcError(original, "/tmp", { statfs: () => HEALTHY })).toBe(original);
  });

  it("keeps a custom error name so instanceof-by-name consumers still match", () => {
    const original = Object.assign(new Error("no space left on device"), { code: "ENOSPC", name: "GitError" });
    const wrapped = annotateEnospcError(original, "/tmp", { statfs: () => INODE_EXHAUSTED }) as Error;
    expect(wrapped.name).toBe("GitError");
  });

  it("annotates a boot-socket ENOSPC whose own path was never created", () => {
    /*
    FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
    The production shape: `net.Server.listen(path)` is refused by bind() with errno 28 BEFORE any
    socket file exists, so the only statfs answer available for the literal target is ENOENT. This
    case is the regression lock for the dead-classification defect — it fails against a probe that
    reads only the literal target, and it is unobservable to a path-blind fake.
    */
    const statfs = vi.fn((path: string) => {
      if (path !== "/tmp") throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return INODE_EXHAUSTED;
    });
    const original = Object.assign(
      new Error("listen ENOSPC: no space left on device, /tmp/fusion-engine-abc123.sock"),
      { code: "ENOSPC" },
    );

    const wrapped = annotateEnospcError(original, "/tmp/fusion-engine-abc123.sock", { statfs }) as Error;
    expect(wrapped.message).toContain("inode-exhausted");
    expect(wrapped.message).toContain("on /tmp ");
    expect((wrapped as NodeJS.ErrnoException).code).toBe("ENOSPC");
  });
});

describe("core barrel publication (RUFU-397)", () => {
  /*
  FNXC:MergeGatePolicy 2026-11-03-08:05 (RUFU-397):
  Same both-barrels pin as `agent-log-read-guard.test.ts` establishes. This is load-bearing, not
  cosmetic: the `engine-core` merge-gate vitest project resolves `@fusion/core` to the bundle built
  from `index.gate.ts`, so a symbol exported only from `index.ts` resolves to `undefined` in that one
  lane and every consumer test there dies with a TypeError instead of an assertion failure.
  */
  it("is exposed from BOTH core barrels (index + index.gate stay in sync)", () => {
    expect(typeof annotateEnospcFailureGate).toBe("function");
    expect(typeof classifyTempFsGate).toBe("function");
    // Re-export of the same module instance → the same function, so both barrels cannot drift.
    expect(annotateEnospcFailureGate).toBe(annotateEnospcFailure);
    expect(classifyTempFsGate).toBe(classifyTempFs);
    expect(annotateEnospcFailureGate(MKDMTEMP_ENOSPC, "/tmp", { statfs: () => INODE_EXHAUSTED }))
      .toBe(annotateEnospcFailure(MKDMTEMP_ENOSPC, "/tmp", { statfs: () => INODE_EXHAUSTED }));
  });
});

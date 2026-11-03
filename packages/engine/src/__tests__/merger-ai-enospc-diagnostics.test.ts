import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings, TempFsStatfsLike } from "@fusion/core";

/*
 * Only `mkdtemp` is faked; the rest of `node:fs/promises` stays real so the huge merger-ai import
 * graph keeps working (the idiom `self-healing-tempdir-sweep.test.ts` already uses for fs).
 */
const mkdtempMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: mkdtempMock };
});

/*
FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
`resolveAiMergeRoot` is not a lookup — it `mkdirSync`s the clean-room root — so on an exhausted inode
 table the FIRST filesystem write of the merge lane is that mkdir, not `mkdtemp`. Called outside the
annotated guard, that failure recorded the bare errno-28 sentence and the whole card kept its
misleading text. A real ENOSPC cannot be conjured from `mkdirSync` without a tmpfs, so this seam lets
one named path refuse while every other call delegates to the real filesystem: the root-creation leg is
then exercised for real, guard and all.
*/
const mkdirRefusal = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: ((path: Parameters<typeof actual.mkdirSync>[0], ...rest: unknown[]) => {
      if (mkdirRefusal.token !== null && String(path).includes(mkdirRefusal.token)) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${path}'`), {
          code: "ENOSPC",
          errno: -28,
          path: String(path),
          syscall: "mkdir",
        });
      }
      return (actual.mkdirSync as (p: unknown, o?: unknown) => unknown)(path, rest[0]);
    }) as typeof actual.mkdirSync,
  };
});

import { createAiMergeScratchDir } from "../merge/merger-ai.js";

/*
FNXC:TempFsDiagnostics 2026-11-03-08:09 (RUFU-397):
The failure record this seam owns is the MERGE PARK: `project-engine.ts` derives its merge-retry log
line and merge park text from `err.message`, so an un-annotated ENOSPC from clean-room creation is
recorded as "no space left on device" on a host with 52 G free — the exact contradiction that made the
class undiagnosable. These tests pin that the class arrives in the message, that the errno code and
cause survive, and (the non-regression half) that every other creation failure rethrows the identical
error object so no existing merge leg changes shape.
*/

/** Measured card shape: 0 of 1048576 inodes free with 52 G of bytes free. */
const INODE_EXHAUSTED: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: (52 * 1024 ** 3) / 4096,
  files: 1048576,
  ffree: 0,
};

const cleanup: string[] = [];

function projectFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rufu397-merge-root-"));
  // `resolveAiMergeRoot` creates and git-inits nothing, but it does mkdir the clean-room root.
  mkdirSync(join(dir, ".git"), { recursive: true });
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  mkdtempMock.mockReset();
  mkdirRefusal.token = null;
  for (const dir of cleanup.splice(0, cleanup.length)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("AI-merge clean-room creation names the temp-fs class", () => {
  it("names inode-exhausted when clean-room mkdtemp fails with ENOSPC", async () => {
    mkdtempMock.mockRejectedValue(
      Object.assign(new Error("no space left on device, mkdtemp"), { code: "ENOSPC" }),
    );

    const error = await createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", {
      statfs: () => INODE_EXHAUSTED,
    }).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("inode-exhausted");
    expect(error.message).toContain("0 of 1048576 inodes free");
    expect(error.message).toContain("52G bytes free");
    // The literal token is what the honest-blocked classifier freezes on.
    expect(error.message).toMatch(/\bENOSPC\b/);
  });

  it("preserves the errno code and the original error as cause", async () => {
    const original = Object.assign(new Error("no space left on device, mkdtemp"), { code: "ENOSPC" });
    mkdtempMock.mockRejectedValue(original);

    const wrapped = await createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", {
      statfs: () => INODE_EXHAUSTED,
    }).catch((err: unknown) => err as NodeJS.ErrnoException & { cause?: unknown });

    expect(wrapped).not.toBe(original);
    expect(wrapped.code).toBe("ENOSPC");
    expect(wrapped.cause).toBe(original);
  });

  it("rethrows the IDENTICAL error object for a non-ENOSPC creation failure (no leg changes shape)", async () => {
    const original = Object.assign(new Error("permission denied, mkdtemp"), { code: "EACCES" });
    mkdtempMock.mockRejectedValue(original);
    const statfs = vi.fn(() => INODE_EXHAUSTED);

    let caught: unknown;
    try {
      await createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", { statfs });
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBe(original);
    // A non-ENOSPC failure must not even pay for a filesystem probe.
    expect(statfs).not.toHaveBeenCalled();
  });

  it("keeps the original ENOSPC sentence when the probe has no opinion", async () => {
    const original = Object.assign(new Error("no space left on device, mkdtemp"), { code: "ENOSPC" });
    mkdtempMock.mockRejectedValue(original);
    const statfs = vi.fn(() => {
      throw new Error("statfs unsupported");
    });

    const caught = await createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", {
      statfs,
    }).catch((err: unknown) => err as Error);

    expect(caught).toBe(original);
    expect(caught.message).toBe("no space left on device, mkdtemp");
  });

  it("returns the created directory untouched on the success leg", async () => {
    const created = "/fixture/fusion-ai-merge-fn-1-abc123";
    mkdtempMock.mockResolvedValue(created);
    await expect(
      createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", { statfs: () => INODE_EXHAUSTED }),
    ).resolves.toBe(created);
  });

  /*
  FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
  The secondary trace from code review: the clean-room ROOT is created before `mkdtemp` runs, so the
  first inode-table refusal of the merge lane lands there. It must be classified exactly like the
  `mkdtemp` refusal, and the record must still say which write failed.
  */
  it("names the class when creating the clean-room ROOT itself runs out of inodes", async () => {
    mkdirRefusal.token = ".ai-merge";
    const statfs = vi.fn(() => INODE_EXHAUSTED);

    const error = await createAiMergeScratchDir(projectFixture(), undefined, "fusion-ai-merge-fn-1-", {
      statfs,
    }).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("mkdir");
    expect(error.message).toContain("temp-fs class: inode-exhausted");
    expect(error.message).toContain("0 of 1048576 inodes free");
    expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
    // Proves the refusal came from the root creation, not from the mocked `mkdtemp`.
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it("rethrows the identical error object when the clean-room root itself cannot be created", async () => {
    // A regular file where the worktrees root must live: mkdir fails deterministically, with ENOTDIR.
    const projectRoot = projectFixture();
    const blocker = join(projectRoot, "blocked-by-file");
    writeFileSync(blocker, "not a directory");
    const statfs = vi.fn(() => INODE_EXHAUSTED);

    let caught: unknown;
    try {
      await createAiMergeScratchDir(
        projectRoot,
        { worktreesDir: join(blocker, "worktrees") } as unknown as Settings,
        "fusion-ai-merge-fn-1-",
        { statfs },
      );
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOTDIR");
    // A non-ENOSPC root-creation failure keeps its own identity and pays for no probe.
    expect(statfs).not.toHaveBeenCalled();
  });
});

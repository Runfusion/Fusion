import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { TempFsStatfsLike } from "@fusion/core";
import { createRunVerificationTool, verificationTempFsSuffix } from "../execution/run-verification-tool.js";

/*
FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
The unit-level helper tests prove the classification exists; they cannot prove the class reaches the
record. This file pins the ASSEMBLY: the same tool response an agent reads must carry the class in its
`Failure summary:` block, because that text is this lane's only failure record — nothing downstream
re-reads the raw capture. Without this assertion a refactor that dropped the annotation call at the
assembly site (or handed it only `result.stderr`, silently losing the `Spawn error:` warning leg) would
keep every other test green while the operator-facing record lost the class again.

The child is a real spawn (an ENOSPC line on stderr, exit 1) and the filesystem is a fake, matching the
card's contract: no real tmpfs, no polling, no dependence on the host's inode state.
*/

/** Measured host shape this class exists for: 0 of 1048576 inodes free with 52 G of bytes free. */
const INODE_EXHAUSTED: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: (52 * 1024 ** 3) / 4096,
  files: 1048576,
  ffree: 0,
};

const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

function createTool(tempFsDeps: Parameters<typeof verificationTempFsSuffix>[2]) {
  const worktreePath = mkdtempSync(join(tmpdir(), "fusion-rufu397-verify-"));
  const tool = createRunVerificationTool({
    worktreePath,
    rootDir: worktreePath,
    taskId: "RUFU-397",
    recordActivity: vi.fn(),
    onVerificationStart: vi.fn(),
    onVerificationEnd: vi.fn(),
    tempFsDeps,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { tool, worktreePath };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((entry) => ("text" in entry ? entry.text ?? "" : "")).join("\n");
}

describe("fn_run_verification carries the temp-fs class into the recorded failure", () => {
  itPosix("appends the inode-exhausted class to the assembled Failure summary", async () => {
    const { tool, worktreePath } = createTool({ statfs: () => INODE_EXHAUSTED });
    try {
      const script = [
        "console.error('FAIL src/widget.test.ts > Widget > cannot start');",
        "console.error(\"Error: ENOSPC: no space left on device, mkdtempSync '/tmp/fusion-test-workers-abc'\");",
        "process.exit(1);",
      ].join("");

      const result = await tool.execute!("call-enospc-failure", {
        command: `${process.execPath} -e ${JSON.stringify(script)}`,
        cwd: worktreePath,
        scope: "package",
      });

      const text = textOf(result);
      expect(text).toContain("Failure summary:");
      expect(text).toContain("temp-fs class: inode-exhausted");
      expect(text).toContain("0 of 1048576 inodes free");
      expect(text).toContain("52G bytes free");
      // The honest-blocked classifier keys on the literal token; the record must keep carrying it.
      expect(text).toMatch(/\bENOSPC\b/);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }, 30000);

  itPosix("records no class for an ordinary failing command and never probes the filesystem", async () => {
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    const { tool, worktreePath } = createTool({ statfs });
    try {
      const script = "console.error('AssertionError: expected 1 to be 2'); process.exit(1);";

      const result = await tool.execute!("call-plain-failure", {
        command: `${process.execPath} -e ${JSON.stringify(script)}`,
        cwd: worktreePath,
        scope: "package",
      });

      const text = textOf(result);
      expect(text).toContain("Failure summary:");
      expect(text).toContain("AssertionError: expected 1 to be 2");
      expect(text).not.toContain("temp-fs class");
      expect(statfs).not.toHaveBeenCalled();
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }, 30000);

  itPosix("degrades to the un-annotated summary when the probe cannot read the filesystem", async () => {
    const { tool, worktreePath } = createTool({
      statfs: () => {
        throw new Error("statfs unsupported");
      },
    });
    try {
      const script = "console.error('ENOSPC: no space left on device'); process.exit(1);";

      const result = await tool.execute!("call-enospc-no-probe", {
        command: `${process.execPath} -e ${JSON.stringify(script)}`,
        cwd: worktreePath,
        scope: "package",
      });

      const text = textOf(result);
      expect(text).toContain("Failure summary:");
      expect(text).toContain("ENOSPC");
      expect(text).not.toContain("temp-fs class");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }, 30000);

  it("detects the errno even when only the spawn warning carries it", () => {
    /*
    A spawn that never started reports `Spawn error: ENOSPC: …` in `result.warnings` and leaves both
    stdout and stderr empty. The assembly passes those warnings into the detector, so the class still
    reaches the record — this pins the input set the assembly is allowed to narrow no further.
    */
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "", warnings: ["Spawn error: ENOSPC: no space left on device, mkdir"] },
      [],
      { statfs: () => INODE_EXHAUSTED },
    );
    expect(suffix).toContain("temp-fs class: inode-exhausted");
  });

  it("detects the errno when the launch warning arrives as an extra warning instead", () => {
    const suffix = verificationTempFsSuffix(
      { stdout: "", stderr: "", warnings: [] },
      ["Spawn error: ENOSPC: no space left on device, mkdir"],
      { statfs: () => INODE_EXHAUSTED },
    );
    expect(suffix).toContain("temp-fs class: inode-exhausted");
  });
});

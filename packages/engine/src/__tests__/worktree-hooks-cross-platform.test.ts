import { mkdtempSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("node:child_process", () => ({ exec: execMock, execFile: vi.fn() }));

import { writeFileAtomic } from "../worktree/worktree-hooks.js";

describe("worktree-hooks cross-platform", () => {
  it("creates missing parent directories without shell mkdir", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hooks-xplat-"));
    const target = join(root, "nested", "hooks", "pre-commit");
    await writeFileAtomic(target, "#!/bin/sh\n");

    await expect(access(target)).resolves.toBeUndefined();
    expect(execMock.mock.calls.some((c) => typeof c[0] === "string" && c[0].startsWith("mkdir"))).toBe(false);
  });

  it("is idempotent when parent directory already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hooks-xplat-existing-"));
    const parent = join(root, "hooks");
    const target = join(parent, "commit-msg");

    await mkdir(parent, { recursive: true });
    await writeFileAtomic(target, "first\n");
    await writeFileAtomic(target, "first\n");

    expect(await readFile(target, "utf-8")).toBe("first\n");
  });
});

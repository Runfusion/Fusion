import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preserveGeneratedResidue } from "../worktree-generated-residue.js";

describe("preserveGeneratedResidue", () => {
  it("restores generated directories when removal is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    execFileSync("git", ["init", "-q", worktree]);
    writeFileSync(join(worktree, ".gitignore"), "node_modules/\ndist/\n");
    mkdirSync(join(worktree, "node_modules"));
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "node_modules", "marker"), "deps");
    writeFileSync(join(worktree, "dist", "marker"), "build");

    const restore = await preserveGeneratedResidue(worktree, root);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, "dist"))).toBe(false);

    await restore();
    expect(readFileSync(join(worktree, "node_modules", "marker"), "utf8")).toBe("deps");
    expect(readFileSync(join(worktree, "dist", "marker"), "utf8")).toBe("build");
    await rm(root, { recursive: true, force: true });
  });

  it("fails restoration when removal recreates a source and preserves both copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    execFileSync("git", ["init", "-q", worktree]);
    writeFileSync(join(worktree, ".gitignore"), "node_modules/\n");
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", "marker"), "deps");

    const restore = await preserveGeneratedResidue(worktree, root);
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", "new-marker"), "recreated");

    await expect(restore()).rejects.toThrow(/Failed to restore generated residue/);
    expect(readFileSync(join(worktree, "node_modules", "new-marker"), "utf8")).toBe("recreated");
    const recoveryRoot = join(root, ".fusion", "recovery", "worktrees");
    const preserved = await readdir(recoveryRoot);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(recoveryRoot, preserved[0], "marker"), "utf8")).toBe("deps");
    await rm(root, { recursive: true, force: true });
  });

  // Greptile: the restore loop threw on the FIRST conflicting/recreated source and
  // skipped the remaining moved entries, leaving the surviving worktree without its
  // other generated directory while it stayed stranded in recovery. Restoration must
  // attempt every moved entry and throw an aggregate error only after all are tried.
  it("restores the remaining generated dir even when one source was recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    execFileSync("git", ["init", "-q", worktree]);
    writeFileSync(join(worktree, ".gitignore"), "node_modules/\ndist/\n");
    mkdirSync(join(worktree, "node_modules"));
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "node_modules", "marker"), "deps");
    writeFileSync(join(worktree, "dist", "marker"), "build");

    const restore = await preserveGeneratedResidue(worktree, root);
    // dist is restored first (reverse order); recreate its source so it conflicts,
    // proving the conflict must not prevent node_modules from being restored too.
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "recreated"), "new-build");

    await expect(restore()).rejects.toThrow(/Failed to restore generated residue/);
    // The recreated source is preserved in place...
    expect(readFileSync(join(worktree, "dist", "recreated"), "utf8")).toBe("new-build");
    // ...and the OTHER moved dir was still restored despite the conflict.
    expect(readFileSync(join(worktree, "node_modules", "marker"), "utf8")).toBe("deps");
    await rm(root, { recursive: true, force: true });
  });
});

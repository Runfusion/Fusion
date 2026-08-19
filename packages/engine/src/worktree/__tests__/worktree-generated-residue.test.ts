import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { preserveCorruptRegisteredRoot, preserveGeneratedResidue } from "../worktree-generated-residue.js";

// Genuinely-generated fixtures: node_modules carries a package-manager marker
// and dist carries a sourcemap, so they are provably generated output rather
// than a merely generated-looking dir holding user content (Greptile: residue
// provenance).
function makeGeneratedNodeModules(worktree: string): void {
  mkdirSync(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", ".package-lock.json"), "{}");
  mkdirSync(join(worktree, "node_modules", "pkg"));
  writeFileSync(join(worktree, "node_modules", "pkg", "package.json"), "{}");
}

function makeGeneratedDist(worktree: string): void {
  mkdirSync(join(worktree, "dist"));
  writeFileSync(join(worktree, "dist", "bundle.js.map"), "{}");
}

function gitInit(worktree: string, gitignore: string): void {
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, ".gitignore"), gitignore);
}

describe("preserveGeneratedResidue", () => {
  it("restores generated directories when removal is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    gitInit(worktree, "node_modules/\ndist/\n");
    makeGeneratedNodeModules(worktree);
    makeGeneratedDist(worktree);
    writeFileSync(join(worktree, "node_modules", "pkg", "bundle.js"), "deps");
    writeFileSync(join(worktree, "dist", "bundle.js"), "build");

    const restore = await preserveGeneratedResidue(worktree, root);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, "dist"))).toBe(false);

    await restore();
    expect(readFileSync(join(worktree, "node_modules", "pkg", "bundle.js"), "utf8")).toBe("deps");
    expect(readFileSync(join(worktree, "dist", "bundle.js"), "utf8")).toBe("build");
    await rm(root, { recursive: true, force: true });
  });

  // Greptile (residue provenance): a git-ignored sibling must NOT be moved ahead
  // of the dirty probe merely because it carries a generated-looking name. Only
  // PROVABLY generated output is moved; anything ambiguous stays in the checkout
  // so the removal's dirty probe fails closed and the checkout keeps its content.
  it("does not move a generated-looking but not provably generated ignored dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    gitInit(worktree, "node_modules/\ndist/\n");
    // Hand-authored ignored content under generated-looking names, no install/build
    // provenance markers.
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", "user-notes.txt"), "keep me");
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "user-notes.txt"), "keep me");

    const restore = await preserveGeneratedResidue(worktree, root);

    // Neither ambiguous dir was moved — the checkout stays valid for restore.
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    expect(existsSync(join(worktree, "dist"))).toBe(true);
    expect(readFileSync(join(worktree, "node_modules", "user-notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(worktree, "dist", "user-notes.txt"), "utf8")).toBe("keep me");
    await restore();
    await rm(root, { recursive: true, force: true });
  });

  // Greptile (Issue 2, mixed residue): ONE recognized package-manager/build marker
  // beside user-authored ignored content must NOT let the whole node_modules/dist be
  // moved ahead of the dirty probe. Every entry must look generated; a mixed
  // directory stays in place so removal fails closed and the user's file survives.
  it("keeps a mixed node_modules/dist (marker + user file) in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    gitInit(worktree, "node_modules/\ndist/\n");
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", ".package-lock.json"), "{}");
    writeFileSync(join(worktree, "node_modules", "user-notes.txt"), "keep me");
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "bundle.js.map"), "{}");
    writeFileSync(join(worktree, "dist", "user-notes.txt"), "keep me");

    const restore = await preserveGeneratedResidue(worktree, root);

    // Neither mixed directory is provably generated, so neither is moved and the
    // user-authored files survive the removal's dirty probe.
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    expect(existsSync(join(worktree, "dist"))).toBe(true);
    expect(readFileSync(join(worktree, "node_modules", "user-notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(worktree, "dist", "user-notes.txt"), "utf8")).toBe("keep me");
    await restore();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps preserved generated directories in contained recovery after successful removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    gitInit(worktree, "node_modules/\n");
    makeGeneratedNodeModules(worktree);
    writeFileSync(join(worktree, "node_modules", "pkg", "marker.js"), "deps");

    const restore = await preserveGeneratedResidue(worktree, root);
    await restore(true);

    // Greptile: residue moved ahead of the dirty probe may hold user-authored ignored
    // content, so it is NEVER recursively deleted on success — it stays in the contained
    // recovery area for manual recovery instead of being discarded.
    const recoveryRoot = join(root, ".fusion", "recovery", "worktrees");
    const preserved = await readdir(recoveryRoot);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(recoveryRoot, preserved[0], "pkg", "marker.js"), "utf8")).toBe("deps");
    await rm(root, { recursive: true, force: true });
  });

  it("fails restoration when removal recreates a source and preserves both copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-residue-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    gitInit(worktree, "node_modules/\n");
    makeGeneratedNodeModules(worktree);
    writeFileSync(join(worktree, "node_modules", "pkg", "marker.js"), "deps");

    const restore = await preserveGeneratedResidue(worktree, root);
    mkdirSync(join(worktree, "node_modules"));
    writeFileSync(join(worktree, "node_modules", "new-marker"), "recreated");

    await expect(restore()).rejects.toThrow(/Failed to restore generated residue/);
    expect(readFileSync(join(worktree, "node_modules", "new-marker"), "utf8")).toBe("recreated");
    const recoveryRoot = join(root, ".fusion", "recovery", "worktrees");
    const preserved = await readdir(recoveryRoot);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(recoveryRoot, preserved[0], "pkg", "marker.js"), "utf8")).toBe("deps");
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
    gitInit(worktree, "node_modules/\ndist/\n");
    makeGeneratedNodeModules(worktree);
    makeGeneratedDist(worktree);
    writeFileSync(join(worktree, "node_modules", "pkg", "marker.js"), "deps");
    writeFileSync(join(worktree, "dist", "bundle.js"), "build");

    const restore = await preserveGeneratedResidue(worktree, root);
    // dist is restored first (reverse order); recreate its source so it conflicts,
    // proving the conflict must not prevent node_modules from being restored too.
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "recreated"), "new-build");

    await expect(restore()).rejects.toThrow(/Failed to restore generated residue/);
    // The recreated source is preserved in place...
    expect(readFileSync(join(worktree, "dist", "recreated"), "utf8")).toBe("new-build");
    // ...and the OTHER moved dir was still restored despite the conflict.
    expect(readFileSync(join(worktree, "node_modules", "pkg", "marker.js"), "utf8")).toBe("deps");
    await rm(root, { recursive: true, force: true });
  });

  it("falls back beside the worktrees root when project recovery is cross-device", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-corrupt-"));
    const worktrees = await mkdtemp(join(tmpdir(), "fusion-worktrees-"));
    const worktree = join(worktrees, "broken");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "marker"), "keep");
    const actualRename = (await import("node:fs/promises")).rename;
    const renameFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }))
      .mockImplementation(actualRename);

    const preserved = await preserveCorruptRegisteredRoot(worktree, root, worktrees, renameFile);

    expect(preserved).toContain(join(worktrees, ".fusion-recovery", "worktrees"));
    expect(readFileSync(join(preserved, "marker"), "utf8")).toBe("keep");
    expect(renameFile).toHaveBeenCalledTimes(2);
    await rm(root, { recursive: true, force: true });
    await rm(worktrees, { recursive: true, force: true });
  });
});
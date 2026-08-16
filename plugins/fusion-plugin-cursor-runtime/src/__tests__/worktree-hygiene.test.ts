import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCursorConfigExcluded, resolveGitShape } from "../worktree-hygiene.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "fusion-cursor-hygiene-"));
  roots.push(value);
  return value;
};
afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("Cursor worktree hygiene", () => {
  it("does not reclaim a fresh bootstrap lock before its owner is published", () => {
    const repository = root();
    git(repository, "init");
    const shape = resolveGitShape(repository)!;
    const lock = join(shape.gitDir, "fusion-cursor-exclude.lock");
    mkdirSync(lock);
    expect(() => ensureCursorConfigExcluded(repository)).toThrow(/exclude lock unavailable/);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(repository, ".cursor"))).toBe(false);
  });

  it("uses Git's absolute linked-worktree exclude path instead of nesting it below the worktree", () => {
    const repository = root();
    git(repository, "init");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "user.name", "Cursor test");
    writeFileSync(join(repository, "README.md"), "seed\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "seed");
    const linked = join(repository, "linked");
    git(repository, "worktree", "add", "-b", "cursor-hygiene-test", linked);

    const shape = resolveGitShape(linked);
    expect(shape).toBeDefined();
    expect(shape!.excludePath).toBe(git(linked, "rev-parse", "--git-path", "info/exclude"));
    ensureCursorConfigExcluded(linked);

    expect(readFileSync(shape!.excludePath, "utf8")).toContain("# >>> fusion cursor-runtime >>>");
    expect(readFileSync(shape!.excludePath, "utf8")).toContain("/.cursor/mcp.json");
    mkdirSync(join(linked, ".cursor"));
    writeFileSync(join(linked, ".cursor", "mcp.json"), "{}\n");
    // A regression joined the absolute Git path under `linked`, creating this bogus tree.
    expect(existsSync(join(linked, shape!.excludePath.replace(/^[/\\]+/, "")))).toBe(false);
  });
});

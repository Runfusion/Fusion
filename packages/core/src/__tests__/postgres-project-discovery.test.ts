// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirstRunDetector } from "../central/migration.js";
import {
  assertNotLinkedWorktreeOfExistingProject,
  LinkedWorktreeBootstrapRefusedError,
} from "../central/project-root-guard.js";
import { writeProjectIdentity } from "../central/project-identity.js";

const cleanupPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(() => {
  delete process.env.FUSION_TEST_LINKED_WORKTREE_GUARD;
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("PostgreSQL project discovery", () => {
  /**
   * FNXC:PostgresProjectDiscovery 2026-07-14-17:30:
   * Current project discovery must work with only the filesystem identity
   * marker; creating a SQLite database is neither required nor expected.
   */
  it("discovers a project.json-only project while walking up from a child", async () => {
    const projectRoot = temporaryDirectory("fusion-project-marker-");
    const child = join(projectRoot, "src", "nested");
    mkdirSync(child, { recursive: true });
    writeProjectIdentity(join(projectRoot, ".fusion"), {
      id: "proj_0123456789abcdef",
      createdAt: "2026-07-14T17:30:00.000Z",
    });

    const detected = await new FirstRunDetector(join(projectRoot, "global")).detectExistingProjects(child);

    expect(detected).toEqual([
      expect.objectContaining({
        path: projectRoot,
        hasDb: true,
        identityId: "proj_0123456789abcdef",
      }),
    ]);
  });

  it("derives first-run state from the central project registry", async () => {
    const detector = new FirstRunDetector(temporaryDirectory("fusion-central-state-"));
    const central = {
      listProjects: async () => [{ id: "proj_0123456789abcdef" }],
    };

    await expect(detector.detectFirstRunState(central as never)).resolves.toBe("normal-operation");
    expect(detector.hasCentralDb()).toBe(true);
  });

  it("refuses nested initialization in a linked worktree when the parent has only project.json", () => {
    const parent = temporaryDirectory("fusion-parent-project-");
    const worktree = `${parent}-worktree`;
    cleanupPaths.push(worktree);
    execFileSync("git", ["init", "-q"], { cwd: parent });
    execFileSync("git", ["config", "user.email", "fusion-test@example.invalid"], { cwd: parent });
    execFileSync("git", ["config", "user.name", "Fusion Test"], { cwd: parent });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: parent });
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "marker-guard-test"], { cwd: parent });
    writeProjectIdentity(join(parent, ".fusion"), {
      id: "proj_fedcba9876543210",
      createdAt: "2026-07-14T17:30:00.000Z",
    });
    process.env.FUSION_TEST_LINKED_WORKTREE_GUARD = "1";

    expect(() => assertNotLinkedWorktreeOfExistingProject(worktree, "test"))
      .toThrow(LinkedWorktreeBootstrapRefusedError);
  });
});

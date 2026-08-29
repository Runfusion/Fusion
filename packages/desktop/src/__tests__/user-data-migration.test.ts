import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migratePreviousUserData } from "../user-data-migration.js";

/*
FNXC:DesktopUserDataMigration 2026-07-03-15:10:
Verify the one-time profile copy that keeps an upgrading operator's window
geometry/session when userData relocates to ~/.fusion (field report Issue 8):
it copies a populated previous profile into an absent/empty new dir exactly once,
and never overwrites an already-migrated profile, an empty source, or the same path.
*/
describe("migratePreviousUserData", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fusion-userdata-mig-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed = (dir: string, file: string, contents: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), contents);
  };

  it("copies a populated previous profile into an absent new dir", () => {
    const previous = join(root, "old");
    const next = join(root, "new");
    seed(previous, "window-state.json", "{\"x\":10}");

    expect(migratePreviousUserData(previous, next)).toBe(true);
    expect(readFileSync(join(next, "window-state.json"), "utf-8")).toBe("{\"x\":10}");
    // Copy, not move: the source is left intact for downgrades/partial failures.
    expect(readFileSync(join(previous, "window-state.json"), "utf-8")).toBe("{\"x\":10}");
  });

  it("does not overwrite a new dir that already has data", () => {
    const previous = join(root, "old");
    const next = join(root, "new");
    seed(previous, "session.json", "old");
    seed(next, "session.json", "already-migrated");

    expect(migratePreviousUserData(previous, next)).toBe(false);
    expect(readFileSync(join(next, "session.json"), "utf-8")).toBe("already-migrated");
  });

  it("treats an empty new dir as eligible for migration", () => {
    const previous = join(root, "old");
    const next = join(root, "new");
    seed(previous, "session.json", "restore-me");
    mkdirSync(next, { recursive: true }); // exists but empty

    expect(migratePreviousUserData(previous, next)).toBe(true);
    expect(readFileSync(join(next, "session.json"), "utf-8")).toBe("restore-me");
  });

  it("no-ops when there is no previous profile", () => {
    const previous = join(root, "missing");
    const next = join(root, "new");

    expect(migratePreviousUserData(previous, next)).toBe(false);
  });

  it("no-ops when the previous profile exists but is empty", () => {
    const previous = join(root, "old");
    const next = join(root, "new");
    mkdirSync(previous, { recursive: true });

    expect(migratePreviousUserData(previous, next)).toBe(false);
  });

  it("no-ops when previous and new paths are identical", () => {
    const same = join(root, "same");
    seed(same, "session.json", "keep");

    expect(migratePreviousUserData(same, same)).toBe(false);
    expect(readFileSync(join(same, "session.json"), "utf-8")).toBe("keep");
  });
});

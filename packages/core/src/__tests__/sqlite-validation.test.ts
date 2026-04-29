import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidSqliteDatabaseFile } from "../sqlite-validation.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-sqlite-validation-"));
}

describe("isValidSqliteDatabaseFile", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the file does not exist", () => {
    const dir = makeTempDir();
    dirs.push(dir);

    expect(isValidSqliteDatabaseFile(join(dir, "missing.db"))).toBe(false);
  });

  it("returns true for a zero-byte bootstrap database", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dbPath = join(dir, "fusion.db");
    writeFileSync(dbPath, "");

    expect(isValidSqliteDatabaseFile(dbPath)).toBe(true);
  });

  it("returns false for plain text files", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dbPath = join(dir, "fusion.db");
    writeFileSync(dbPath, "not a sqlite database");

    expect(isValidSqliteDatabaseFile(dbPath)).toBe(false);
  });

  it("returns false for a header-only file", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dbPath = join(dir, "fusion.db");
    writeFileSync(dbPath, "SQLite format 3\x00");

    expect(isValidSqliteDatabaseFile(dbPath)).toBe(false);
  });
});

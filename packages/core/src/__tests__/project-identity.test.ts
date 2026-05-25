import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectIdentityMismatchError,
  readProjectIdentity,
  writeProjectIdentity,
} from "../project-identity.js";
import { DatabaseSync } from "../sqlite-adapter.js";

describe("project identity", () => {
  it("returns null for missing db", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    mkdirSync(join(dir, ".fusion"));
    expect(readProjectIdentity(join(dir, ".fusion"))).toBeNull();
  });

  it("writes and reads identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    const fusionDir = join(dir, ".fusion");
    mkdirSync(fusionDir);
    writeProjectIdentity(fusionDir, { id: "proj_0123456789abcdef", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(readProjectIdentity(fusionDir)?.id).toBe("proj_0123456789abcdef");
  });

  it("throws mismatch on different id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    const fusionDir = join(dir, ".fusion");
    mkdirSync(fusionDir);
    writeProjectIdentity(fusionDir, { id: "proj_0123456789abcdef", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(() =>
      writeProjectIdentity(fusionDir, { id: "proj_fedcba9876543210", createdAt: "2026-01-01T00:00:00.000Z" }),
    ).toThrow(ProjectIdentityMismatchError);
  });

  it("returns null for corrupted db", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    const fusionDir = join(dir, ".fusion");
    mkdirSync(fusionDir);
    writeFileSync(join(fusionDir, "fusion.db"), "not sqlite");
    expect(readProjectIdentity(fusionDir)).toBeNull();
  });

  it("rejects malformed id on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    const fusionDir = join(dir, ".fusion");
    mkdirSync(fusionDir);
    expect(() => writeProjectIdentity(fusionDir, { id: "bad", createdAt: "x" })).toThrow(TypeError);
  });

  it("returns null and logs for malformed stored id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    const fusionDir = join(dir, ".fusion");
    mkdirSync(fusionDir);
    writeProjectIdentity(fusionDir, { id: "proj_0123456789abcdef", createdAt: "2026-01-01T00:00:00.000Z" });
    const db = new DatabaseSync(join(fusionDir, "fusion.db"));
    db.prepare("UPDATE __meta SET value = 'bad' WHERE key = 'projectId'").run();
    db.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readProjectIdentity(fusionDir)).toBeNull();
    warn.mockRestore();
  });
});

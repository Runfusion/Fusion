import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectIdentityMismatchError,
  readProjectIdentity,
  writeProjectIdentity,
} from "../central/project-identity.js";

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
    expect(JSON.parse(readFileSync(join(fusionDir, "project.json"), "utf8"))).toMatchObject({
      id: "proj_0123456789abcdef",
    });
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
    writeFileSync(join(fusionDir, "project.json"), JSON.stringify({ id: "bad", createdAt: "2026-01-01T00:00:00.000Z" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readProjectIdentity(fusionDir)).toBeNull();
    warn.mockRestore();
  });
});

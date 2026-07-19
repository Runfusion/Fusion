import { describe, expect, it } from "vitest";
import {
  isQualityPresetId,
  isSafeFilePathToken,
  resolvePresetCommand,
} from "../runner/command-presets.js";

describe("command-presets", () => {
  it("accepts known preset ids only", () => {
    expect(isQualityPresetId("verify-fast")).toBe(true);
    expect(isQualityPresetId("evil")).toBe(false);
  });

  it("resolves verify-fast and test-gate", () => {
    expect(resolvePresetCommand({ preset: "verify-fast", projectRoot: "/repo" })).toEqual({
      ok: true,
      command: "pnpm verify:fast",
      label: "Verify fast (test-free)",
    });
    expect(resolvePresetCommand({ preset: "test-gate", projectRoot: "/repo" }).ok).toBe(true);
  });

  it("disables project-test without testCommand", () => {
    const r = resolvePresetCommand({ preset: "project-test", projectRoot: "/repo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("disabled");
  });

  it("requires confirm for full-suite", () => {
    const denied = resolvePresetCommand({ preset: "full-suite", projectRoot: "/repo" });
    expect(denied.ok).toBe(false);
    const ok = resolvePresetCommand({
      preset: "full-suite",
      projectRoot: "/repo",
      confirmFullSuite: true,
    });
    expect(ok.ok).toBe(true);
  });

  it("builds file-scoped command from safe paths only", () => {
    const r = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot: "/repo",
      filePaths: ["src/a.ts", "../etc/passwd", "src/b.ts"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toContain("vitest run");
      expect(r.command).toContain("src/a.ts");
      expect(r.command).not.toContain("passwd");
    }
  });

  it("rejects empty file-scoped", () => {
    const r = resolvePresetCommand({ preset: "file-scoped", projectRoot: "/repo", filePaths: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects unsafe path tokens", () => {
    expect(isSafeFilePathToken("../x")).toBe(false);
    expect(isSafeFilePathToken("a;rm -rf /")).toBe(false);
    expect(isSafeFilePathToken("src/ok.ts")).toBe(true);
  });
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeCodebaseMetrics, countPreTokenPieces, estimateTextTokens, resetCodebaseMetricsCache } from "../codebase-metrics";
import counts from "./fixtures/token-corpus/reference-counts.json";

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "fn8133-metrics-")); roots.push(value); return value; }
afterEach(async () => { resetCodebaseMetricsCache(); await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("codebase metrics", () => {
  it("beats chars/4 on the disjoint frozen cl100k_base holdout", async () => {
    const fixture = join(process.cwd(), "src/lib/__tests__/fixtures/token-corpus");
    let estimateError = 0; let charsError = 0;
    for (const [file, reference] of Object.entries(counts.counts)) {
      const text = await (await import("node:fs/promises")).readFile(join(fixture, file), "utf8");
      expect(Math.abs(estimateTextTokens(text) - reference)).toBeLessThan(Math.abs(text.length / 4 - reference));
      estimateError += Math.abs(estimateTextTokens(text) - reference); charsError += Math.abs(text.length / 4 - reference);
    }
    expect(estimateError).toBeLessThan(charsError);
  });

  it("segments long letter and digit runs rather than collapsing them", () => {
    expect(countPreTokenPieces("x")).toBe(1);
    expect(countPreTokenPieces("x".repeat(10_000))).toBeGreaterThan(1);
    expect(countPreTokenPieces("1".repeat(10_000))).toBeGreaterThan(1);
  });

  it("uses fallback exclusions, skips binary source, and keeps source and disk domains separate", async () => {
    const dir = await root();
    await mkdir(join(dir, "src")); await mkdir(join(dir, ".cache")); await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src", "source.ts"), "export const local = true;");
    await writeFile(join(dir, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(dir, ".cache", "ignored.ts"), "outside"); await writeFile(join(dir, "node_modules", "ignored.ts"), "outside");
    const result = await computeCodebaseMetrics(dir, { now: () => 0 });
    expect(result.sourceFileCount).toBe(1); expect(result.sourceByteCount).toBeGreaterThan(0);
    expect(result.diskFileCount).toBeGreaterThan(result.sourceFileCount); expect(result.diskBytes).toBeGreaterThan(result.sourceByteCount);
  });

  it("does not follow source or disk symlinks", async () => {
    const dir = await root(); const outside = await root();
    await writeFile(join(dir, "safe.ts"), "export const safe = true;"); await writeFile(join(outside, "secret.ts"), "SECRET_SENTINEL");
    await symlink(join(outside, "secret.ts"), join(dir, "escape.ts")); await symlink(outside, join(dir, "outside-dir"));
    const result = await computeCodebaseMetrics(dir, { now: () => 0 });
    expect(result.sourceFileCount).toBe(1); expect(result.diskFileCount).toBe(3); expect(result.tokenEstimate).not.toBe(estimateTextTokens("SECRET_SENTINEL"));
  });

  it("marks entry, byte, and time caps partial without throwing", async () => {
    const dir = await root(); await writeFile(join(dir, "a.ts"), "const a = 1;"); await writeFile(join(dir, "b.ts"), "const b = 2;");
    expect((await computeCodebaseMetrics(dir, { maxSourceEntries: 1, now: () => 0 })).truncated).toBe(true);
    expect((await computeCodebaseMetrics(dir, { maxScanBytes: 1, now: () => 0 })).truncated).toBe(true);
    expect((await computeCodebaseMetrics(dir, { maxFileBytes: 1, now: () => 0 })).truncated).toBe(true);
    let tick = 0; expect((await computeCodebaseMetrics(dir, { maxWalkMs: 1, now: () => ++tick * 2 })).truncated).toBe(true);
  });

  it("caches default calls", async () => {
    const dir = await root(); await writeFile(join(dir, "a.ts"), "const a = 1;");
    const first = await computeCodebaseMetrics(dir); await writeFile(join(dir, "b.ts"), "const b = 2;");
    expect(await computeCodebaseMetrics(dir)).toEqual(first);
  });
});

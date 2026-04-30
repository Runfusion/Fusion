import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDocsProvider } from "../local-docs-provider.js";

describe("LocalDocsProvider", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function makeProject() {
    const root = mkdtempSync(join(os.tmpdir(), "fn-test-research-"));
    tempDirs.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "Fusion research provider docs");
    writeFileSync(join(root, "docs", "guide.md"), "This guide covers provider architecture and confidence scoring");
    return root;
  }

  it("searches keywords across docs", async () => {
    const root = makeProject();
    const provider = new LocalDocsProvider({ projectRoot: root });

    const results = await provider.search("provider confidence", {});
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.reference).toContain("docs/guide.md");
  });

  it("fetches local file content", async () => {
    const root = makeProject();
    const provider = new LocalDocsProvider({ projectRoot: root });

    const result = await provider.fetchContent("README.md", {});
    expect(result.content).toContain("Fusion research");
    expect(result.metadata).toMatchObject({ extension: ".md" });
  });

  it("prevents path traversal", async () => {
    const root = makeProject();
    const provider = new LocalDocsProvider({ projectRoot: root });
    await expect(provider.fetchContent("../../etc/passwd", {})).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("skips binary files during search", async () => {
    const root = makeProject();
    writeFileSync(join(root, "docs", "binary.dat"), Buffer.from([0, 1, 2, 3, 4]));
    const provider = new LocalDocsProvider({ projectRoot: root });

    const results = await provider.search("binary", {});
    expect(results.find((entry) => String(entry.reference).includes("binary.dat"))).toBeUndefined();
  });

  it("skips oversized files during search", async () => {
    const root = makeProject();
    writeFileSync(join(root, "docs", "large.md"), "x".repeat(1024 * 1024 + 128));
    const provider = new LocalDocsProvider({ projectRoot: root });

    const results = await provider.search("xxxx", {});
    expect(results.find((entry) => String(entry.reference).includes("large.md"))).toBeUndefined();
  });

  it("supports abort signal", async () => {
    const root = makeProject();
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(root, "docs", `doc-${i}.md`), `line ${i}`);
    }

    const provider = new LocalDocsProvider({ projectRoot: root });
    const controller = new AbortController();
    const promise = provider.search("line", {}, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "abort" });
  });
});

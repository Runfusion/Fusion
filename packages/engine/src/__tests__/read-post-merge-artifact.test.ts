import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readPostMergeArtifact } from "../executor/read-post-merge-artifact.js";

const input = { repository: "Runfusion/Fusion", artifactId: 42, cwd: "/repo" };

describe("bounded post-merge artifact inspection", () => {
  it("reads fixed GitHub artifact content with stdout-only unzip and removes its temporary archive", async () => {
    let archivePath = "";
    const run = vi.fn(async (binary: string, args: string[], options: { maxBuffer: number; timeout: number }) => {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(30_000);
      if (binary === "gh") {
        expect(args).toEqual(["api", "--method", "GET", "repos/Runfusion/Fusion/actions/artifacts/42/zip"]);
        return { stdout: Buffer.from("archive") };
      }
      archivePath = args[1];
      expect(await readFile(archivePath, "utf8")).toBe("archive");
      if (args[0] === "-Z1") return { stdout: Buffer.from("evidence.json\n") };
      expect(args).toEqual(["-p", archivePath, "evidence.json"]);
      expect(options.maxBuffer).toBeLessThan(2 * 1024 * 1024);
      return { stdout: Buffer.from('{"failedJobs":[]}') };
    });
    await expect(readPostMergeArtifact(input, run)).resolves.toContain('{"failedJobs":[]}');
    await expect(access(dirname(archivePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../escape.json", "/absolute.json", "-option", "*.json"])("rejects unsafe archive entry %s and cleans up", async (entry) => {
    let archivePath = "";
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "gh") return { stdout: Buffer.from("archive") };
      archivePath = args[1];
      return { stdout: Buffer.from(`${entry}\n`) };
    });
    await expect(readPostMergeArtifact(input, run)).rejects.toThrow("unsupported entry name");
    expect(run).toHaveBeenCalledTimes(2);
    await expect(access(dirname(archivePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up when decompression exceeds the aggregate budget", async () => {
    let archivePath = "";
    const run = vi.fn(async (binary: string, args: string[], options: { maxBuffer: number }) => {
      if (binary === "gh") return { stdout: Buffer.from("archive") };
      archivePath = args[1];
      if (args[0] === "-Z1") return { stdout: Buffer.from("evidence.json\n") };
      return { stdout: Buffer.alloc(options.maxBuffer + 1) };
    });
    await expect(readPostMergeArtifact(input, run)).rejects.toThrow("size limit");
    await expect(access(dirname(archivePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects arbitrary endpoints before executing commands", async () => {
    const run = vi.fn();
    await expect(readPostMergeArtifact({ ...input, repository: "https://example.org" }, run)).rejects.toThrow("owner/repository");
    await expect(readPostMergeArtifact({ ...input, artifactId: -1 }, run)).rejects.toThrow("artifact ID");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an oversized compressed download before invoking unzip", async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.alloc(2 * 1024 * 1024 + 1) }));
    await expect(readPostMergeArtifact(input, run)).rejects.toThrow("size limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps archive entry count and cleans up before reading contents", async () => {
    let archivePath = "";
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "gh") return { stdout: Buffer.from("archive") };
      archivePath = args[1];
      return { stdout: Buffer.from(Array.from({ length: 33 }, (_, index) => `${index}.json`).join("\n")) };
    });
    await expect(readPostMergeArtifact(input, run)).rejects.toThrow("too many entries");
    expect(run).toHaveBeenCalledTimes(2);
    await expect(access(dirname(archivePath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

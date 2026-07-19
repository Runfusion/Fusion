import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifierPath = path.resolve(
  import.meta.dirname,
  "../../../../scripts/verify-desktop-linux-pg-packaging.mjs",
);
const verifier = await import(verifierPath);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Linux AppImage Postgres packaging verifier", () => {
  it("matches normalized ASAR paths exactly", () => {
    // FNXC:DesktopEmbeddedPostgres 2026-07-15-11:55:
    // Runtime entrypoints must be actual ASAR files, not source maps whose
    // names merely contain the required path.
    const listing = "/dist/main-bootstrap.cjs.map\nnode_modules/pkg/dist/index.js.map\n/dist/main-bootstrap.cjs\n";

    expect(verifier.listIncludesAsarPath(listing, "/dist/main-bootstrap.cjs")).toBe(true);
    expect(verifier.listIncludesAsarPath(listing, "/node_modules/pkg/dist/index.js")).toBe(false);
  });

  it("derives the matching platform package and requires executable regular files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fusion-pg-verifier-"));
    tempDirs.push(tempDir);
    const executable = path.join(tempDir, "postgres");
    const notExecutable = path.join(tempDir, "initdb");
    const x64Elf = path.join(tempDir, "x64-elf");
    const arm64Elf = path.join(tempDir, "arm64-elf");
    await writeFile(executable, "#!/bin/sh\n");
    await writeFile(notExecutable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    await chmod(notExecutable, 0o644);
    const elfHeader = (machine: number) => {
      const header = Buffer.alloc(20);
      header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      header.writeUInt16LE(machine, 18);
      return header;
    };
    await writeFile(x64Elf, elfHeader(62));
    await writeFile(arm64Elf, elfHeader(183));

    expect(verifier.expectedLinuxPlatform("/tmp/linux-unpacked")).toBe("linux-x64");
    expect(verifier.expectedLinuxPlatform("/tmp/linux-arm64-unpacked")).toBe("linux-arm64");
    expect(verifier.isRegularExecutable(executable)).toBe(true);
    expect(verifier.isRegularExecutable(notExecutable)).toBe(false);
    expect(verifier.isRegularExecutable(tempDir)).toBe(false);
    expect(verifier.hasExpectedElfArchitecture(x64Elf, "linux-x64")).toBe(true);
    expect(verifier.hasExpectedElfArchitecture(x64Elf, "linux-arm64")).toBe(false);
    expect(verifier.hasExpectedElfArchitecture(arm64Elf, "linux-arm64")).toBe(true);
  });

  it("accepts complete SONAME metadata and rejects malformed package fixtures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fusion-pg-verifier-"));
    tempDirs.push(tempDir);
    const platform = "linux-x64";
    const nativeRoot = path.join(tempDir, platform, "native");
    await mkdir(path.join(nativeRoot, "lib"), { recursive: true });
    await writeFile(path.join(nativeRoot, "lib", "libpq.so.1"), "source");
    await writeFile(path.join(nativeRoot, "lib", "libpq.so"), "target");
    await writeFile(
      path.join(nativeRoot, "pg-symlinks.json"),
      JSON.stringify([{ source: "native/lib/libpq.so.1", target: "native/lib/libpq.so" }]),
    );

    // FNXC:DesktopEmbeddedPostgres 2026-07-15-11:55:
    // Exercise real manifest fixtures: valid links pass while malformed data
    // must fail the verifier rather than silently skipping a broken payload.
    process.exitCode = undefined;
    verifier.assertPlatformSonameLinks("fixture", tempDir, platform);
    expect(process.exitCode).toBeUndefined();

    await writeFile(path.join(nativeRoot, "pg-symlinks.json"), JSON.stringify([{}]));
    verifier.assertPlatformSonameLinks("fixture", tempDir, platform);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

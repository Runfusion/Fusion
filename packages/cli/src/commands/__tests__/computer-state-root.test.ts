import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveComputerStateRoot } from "../computer/state-root.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "computer-state-root-"));
  roots.push(root);
  return root;
}

async function markProject(root: string): Promise<void> {
  await mkdir(join(root, ".fusion"), { recursive: true });
  await writeFile(join(root, ".fusion", "project.json"), JSON.stringify({ id: "proj_0123456789abcdef", createdAt: "2026-08-13T00:00:00.000Z" }));
}

describe("resolveComputerStateRoot", () => {
  it("uses a project marker at the start directory", async () => {
    const root = await fixture();
    await markProject(root);
    expect(resolveComputerStateRoot(root)).toBe(root);
  });

  it("walks to a project marker above a nested directory", async () => {
    const root = await fixture();
    const nested = join(root, "packages", "cli");
    await markProject(root);
    await mkdir(nested, { recursive: true });
    expect(resolveComputerStateRoot(nested)).toBe(root);
  });

  it("falls back to the resolved start path when no marker exists", async () => {
    const root = await fixture();
    const nested = join(root, "unmarked");
    await mkdir(nested);
    expect(resolveComputerStateRoot(nested)).toBe(nested);
  });

  it("normalizes a relative start path to an absolute path", async () => {
    const root = await fixture();
    const relative = relativePath(process.cwd(), root);
    expect(isAbsolute(relative)).toBe(false);
    expect(resolveComputerStateRoot(relative)).toBe(resolve(relative));
  });
});

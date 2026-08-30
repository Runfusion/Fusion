import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsAdapter } from "../skills-adapter.js";

async function writeSkill(root: string, directory: string, name: string): Promise<string> {
  const path = join(root, directory, "skills", name, "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `# ${name}`);
  return path;
}

describe("createSkillsAdapter project-scoped discovery", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("keeps project-local disk skills isolated, prioritizes Fusion skills, and never installs while resolving", async () => {
    const projectA = await mkdtemp(join(tmpdir(), "fn-skills-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "fn-skills-b-"));
    roots.push(projectA, projectB);
    const aPi = await writeSkill(projectA, ".pi", "using-superpowers");
    await writeSkill(projectA, ".fusion", "local-a");
    await writeSkill(projectA, ".pi", "local-a");
    const aAgents = await writeSkill(projectA, ".agents", "agent-a");
    const bPi = await writeSkill(projectB, ".pi", "only-b");
    const shared = join(tmpdir(), "shared-skill", "SKILL.md");
    const calls: Array<(source: string) => Promise<unknown> | undefined> = [];
    const adapter = createSkillsAdapter({
      getPackageManager: (root) => ({ resolve: vi.fn(async (onMissing) => {
        calls.push(onMissing);
        const local = root === projectA ? [aPi, aAgents] : root === projectB ? [bPi] : [];
        return { skills: [...local, shared].map((path) => ({
          path,
          enabled: true,
          metadata: {
            source: path.startsWith(join(root, ".pi")) ? "auto" : "*",
            scope: "project" as const,
            origin: "top-level" as const,
            baseDir: join(root, ".pi"),
          },
        })) };
      }) }),
      getSettingsPath: (root) => join(root, ".fusion", "settings.json"),
    });

    const a = await adapter.discoverSkills(projectA);
    const b = await adapter.discoverSkills(projectB);
    const missing = await adapter.discoverSkills(join(projectA, "missing"));

    expect(a.map((skill) => skill.name)).toEqual(expect.arrayContaining(["using-superpowers/SKILL.md", "local-a/SKILL.md", "agent-a/SKILL.md"]));
    expect(a.map((skill) => skill.name)).not.toContain("only-b/SKILL.md");
    expect(b.map((skill) => skill.name)).toContain("only-b/SKILL.md");
    expect(b.map((skill) => skill.name)).not.toEqual(expect.arrayContaining(["using-superpowers/SKILL.md", "local-a/SKILL.md"]));
    expect(missing.map((skill) => skill.path)).toContain(shared);
    expect(a.filter((skill) => skill.name === "local-a/SKILL.md")).toHaveLength(1);
    expect(a.find((skill) => skill.name === "local-a/SKILL.md")?.path).toContain(".fusion");
    await expect(calls[0]!("ignored")).resolves.toBe("skip");
  });

  it("marks catalog entries installed only for the requesting project", async () => {
    const projectA = await mkdtemp(join(tmpdir(), "fn-skills-catalog-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "fn-skills-catalog-b-"));
    roots.push(projectA, projectB);
    const installed = await writeSkill(projectA, ".pi", "using-superpowers");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ skills: [
        { id: "using-superpowers", name: "using-superpowers" },
        { id: "unrelated", name: "unrelated" },
      ] }),
    }) as unknown as typeof fetch;
    try {
      const adapter = createSkillsAdapter({
        getPackageManager: (root) => ({ resolve: vi.fn().mockResolvedValue({
          skills: root === projectA
            ? [{ path: installed, enabled: true, metadata: { source: "*", scope: "project", origin: "top-level", baseDir: join(root, ".pi") } }]
            : [],
        }) }),
        getSettingsPath: (root) => join(root, ".fusion", "settings.json"),
      });
      const a = await adapter.fetchCatalog({ limit: 20, query: "superpowers", rootDir: projectA });
      const b = await adapter.fetchCatalog({ limit: 20, query: "superpowers", rootDir: projectB });
      expect("entries" in a && a.entries[0]?.installation).toMatchObject({ installed: true, matchingSkillIds: [expect.any(String)] });
      expect("entries" in a && a.entries[1]?.installation.installed).toBe(false);
      expect("entries" in b && b.entries[0]?.installation.installed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCli } from "../generation/generator.js";
import { createDraftStore, getArtifactDir } from "../storage/draft-store.js";
import type { ServiceDraft } from "../wizard/types.js";

function makeDraft(id = "d-1"): ServiceDraft {
  const now = new Date().toISOString();
  return {
    id,
    name: "Demo",
    slug: "demo",
    description: "",
    baseUrl: "https://example.com",
    transport: "http",
    endpoints: [{ id: "ep-1", name: "Ping", method: "GET", path: "/ping", params: "id" }],
    credential: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("generateCli", () => {
  it("creates an executable file in artifact dir", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "clipp-gen-"));
    const draft = makeDraft();
    const artifact = await generateCli({ draft, outDir: getArtifactDir(draft.id, rootDir) });

    await access(artifact.binPath);
    const contents = await readFile(artifact.binPath, "utf8");
    expect(contents).toContain("const draft =");

    if (process.platform !== "win32") {
      const mode = (await stat(artifact.binPath)).mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });

  it("supports persisting generatedAt on rerun", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "clipp-gen-store-"));
    const store = createDraftStore({ rootDir });
    const created = await store.create(makeDraft("d-2"));

    const first = await generateCli({ draft: created, outDir: getArtifactDir(created.id, rootDir) });
    const updated = await store.update(created.id, { generatedAt: first.generatedAt, artifactPath: first.binPath });
    const second = await generateCli({ draft: updated, outDir: getArtifactDir(updated.id, rootDir) });
    const updatedAgain = await store.update(created.id, { generatedAt: second.generatedAt, artifactPath: second.binPath });

    expect(updatedAgain.generatedAt).toBe(second.generatedAt);
    expect(updatedAgain.generatedAt).not.toBe(first.generatedAt);
  });
});

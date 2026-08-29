import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDraftStore, NotFoundError } from "../storage/draft-store";
import type { ServiceDraft } from "../wizard/types";

function makeDraft(): ServiceDraft {
  const now = new Date().toISOString();
  return { id: "", name: "Demo", slug: "demo", description: "", baseUrl: "https://example.com", transport: "http", endpoints: [{ id: "e1", name: "Ping", method: "GET", path: "/ping" }], credential: { kind: "none" }, createdAt: now, updatedAt: now };
}

describe("draft store", () => {
  it("creates, lists, gets, and deletes drafts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-"));
    const store = createDraftStore({ rootDir });
    const created = await store.create(makeDraft());
    expect(created.id).toBeTruthy();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(await store.get(created.id)).toMatchObject({ id: created.id, slug: "demo" });
    await store.delete(created.id);
    expect(await store.get(created.id)).toBeNull();
  });

  it("updates an existing draft and replaces endpoints", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-"));
    const store = createDraftStore({ rootDir });
    const created = await store.create(makeDraft());

    const updated = await store.update(created.id, {
      name: "Renamed",
      endpoints: [{ id: "e2", name: "Health", method: "GET", path: "/health" }],
    });

    expect(updated.name).toBe("Renamed");
    expect(updated.endpoints).toHaveLength(1);
    expect(updated.endpoints[0]?.id).toBe("e2");
    expect(updated.updatedAt).not.toBe(created.updatedAt);

    const draftFiles = await readdir(join(rootDir, ".fusion", "plugins", "cli-printing-press", "drafts"));
    expect(draftFiles.some((entry) => entry.includes(".tmp-"))).toBe(false);
  });

  it("throws NotFoundError on update for unknown ids", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-"));
    const store = createDraftStore({ rootDir });
    await expect(store.update("missing", { name: "Nope" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

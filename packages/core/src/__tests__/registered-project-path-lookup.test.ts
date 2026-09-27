import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupRegisteredProjectIdByPath } from "../postgres/migration-stamping.js";

/*
FNXC:CentralProjectIdentity 2026-09-27-01:01:
A booting process looks its directory up by the real path, while the registry keeps the spelling the project
was registered with. These cases pin that a symlinked spelling still resolves to the registered id, and that
an ambiguous or missing match stays unresolved rather than guessing.
*/
type Row = { id: string; path: string };
function fakeDb(rows: Row[], opts: { fail?: boolean } = {}) {
  const queries: string[] = [];
  const db = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      if (opts.fail) throw new Error("database unavailable");
      // drizzle's sql`` keeps literal chunks and params; recover the literal text and the bound path.
      const chunks = query.queryChunks ?? [];
      const text = chunks.map(c => typeof c === "object" && c && "value" in c ? (c as { value: string[] }).value.join("") : "?").join("");
      queries.push(text);
      if (text.includes("WHERE path =")) {
        const bound = chunks.find(c => typeof c === "string") as string | undefined;
        return rows.filter(r => r.path === bound).map(r => ({ id: r.id }));
      }
      return rows;
    },
  };
  return { db: db as never, queries };
}

let root: string;
let real: string;
let link: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fusion-registry-lookup-"));
  real = join(root, "real-project"); mkdirSync(real);
  link = join(root, "linked-project"); symlinkSync(real, link);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("registered project lookup by path", () => {
  it("returns an exact match without scanning the registry", async () => {
    const { db, queries } = fakeDb([{ id: "proj_exact", path: real }]);
    expect(await lookupRegisteredProjectIdByPath(db, real)).toBe("proj_exact");
    expect(queries).toHaveLength(1);
  });

  it("resolves a project registered under a symlink when booted from its real path, and the reverse", async () => {
    expect(await lookupRegisteredProjectIdByPath(fakeDb([{ id: "proj_linked", path: link }]).db, realpathSync(real))).toBe("proj_linked");
    expect(await lookupRegisteredProjectIdByPath(fakeDb([{ id: "proj_real", path: real }]).db, link)).toBe("proj_real");
  });

  it("refuses to pick when two registrations resolve to the same directory", async () => {
    const { db } = fakeDb([{ id: "proj_a", path: real }, { id: "proj_b", path: link }]);
    // A third spelling (a second symlink) matches neither exactly, so only the real-path fallback could answer.
    const third = join(root, "third-spelling"); symlinkSync(real, third);
    expect(await lookupRegisteredProjectIdByPath(db, third)).toBeUndefined();
  });

  it("leaves unregistered, missing and unreadable lookups unresolved", async () => {
    const other = join(root, "other"); mkdirSync(other);
    expect(await lookupRegisteredProjectIdByPath(fakeDb([{ id: "proj_real", path: real }]).db, other)).toBeUndefined();
    expect(await lookupRegisteredProjectIdByPath(fakeDb([{ id: "proj_gone", path: join(root, "gone") }]).db, join(root, "gone"))).toBe("proj_gone");
    expect(await lookupRegisteredProjectIdByPath(fakeDb([{ id: "proj_gone", path: join(root, "gone") }]).db, join(root, "also-gone"))).toBeUndefined();
    expect(await lookupRegisteredProjectIdByPath(fakeDb([], { fail: true }).db, real)).toBeUndefined();
    expect(await lookupRegisteredProjectIdByPath(fakeDb([]).db, "")).toBeUndefined();
  });
});

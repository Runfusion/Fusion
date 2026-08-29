import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
FNXC:KnowledgeGraph 2026-08-12-14:26:
Knowledge-graph artifacts are regenerable, hand-editable cache files. Keep them ignored so recovery
validation, rather than source control, determines whether a local artifact is reused or rebuilt.
*/
describe("ignored knowledge graph artifact", () => {
  it("is covered by the repository ignore rules", async () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain(".fusion-knowledge");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".fusion-knowledge/graph/nodes.json"], { cwd: root, stdio: "ignore" })).not.toThrow();
    expect(() => execFileSync("git", ["check-ignore", "-q", ".fusion/x.json"], { cwd: root, stdio: "ignore" })).not.toThrow();
  });
});

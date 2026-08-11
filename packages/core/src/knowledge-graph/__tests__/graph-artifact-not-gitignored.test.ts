import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("tracked knowledge graph artifact", () => {
  it("is not covered by the repository ignore rules", async () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignored).not.toContain(".fusion-knowledge");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".fusion-knowledge/graph/nodes.json"], { cwd: root, stdio: "ignore" })).toThrow();
    expect(() => execFileSync("git", ["check-ignore", "-q", ".fusion/x.json"], { cwd: root, stdio: "ignore" })).not.toThrow();
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasLocalProjectMigrationInput } from "../lib/start-local-project.mjs";

test("local startup recognizes project identity and legacy migration input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fusion-start-local-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".fusion"));

  assert.equal(hasLocalProjectMigrationInput(root), false);

  await writeFile(join(root, ".fusion", "fusion.db"), "legacy migration input");
  assert.equal(hasLocalProjectMigrationInput(root), true);

  await rm(join(root, ".fusion", "fusion.db"));
  await writeFile(join(root, ".fusion", "project.json"), "{}");
  assert.equal(hasLocalProjectMigrationInput(root), true);
});

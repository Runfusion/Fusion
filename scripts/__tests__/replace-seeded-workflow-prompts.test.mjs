import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const scriptPath = join(root, "scripts/replace-seeded-workflow-prompts.mjs");
const coreDistPath = join(root, "packages/core/dist/types.js");

function ensureCoreDist() {
  try {
    execFileSync("node", ["-e", `import(${JSON.stringify(coreDistPath)})`], { stdio: "pipe" });
  } catch {
    execFileSync("pnpm", ["--filter", "@fusion/core", "build"], { cwd: root, stdio: "pipe" });
  }
}

function runSql(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function createDb(pathname, rows = []) {
  runSql(pathname, "CREATE TABLE workflow_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT, updatedAt TEXT);");
  for (const row of rows) {
    const prompt = String(row.prompt ?? "").replace(/'/g, "''");
    const name = String(row.name ?? "").replace(/'/g, "''");
    const updatedAt = String(row.updatedAt ?? "2026-01-01T00:00:00.000Z").replace(/'/g, "''");
    runSql(
      pathname,
      `INSERT INTO workflow_steps (id, name, prompt, updatedAt) VALUES ('${row.id}','${name}','${prompt}','${updatedAt}');`,
    );
  }
}

test("replaces seeded workflow prompts and remains idempotent", async () => {
  ensureCoreDist();
  const { WORKFLOW_STEP_TEMPLATES } = await import(coreDistPath);
  const browserPrompt = WORKFLOW_STEP_TEMPLATES.find((entry) => entry.id === "browser-verification")?.prompt;
  assert.ok(browserPrompt);

  const tempDir = mkdtempSync(join(tmpdir(), "fn4493-script-"));
  const dbPath = join(tempDir, "fusion.db");
  try {
    createDb(dbPath, [
      {
        id: "WS-004",
        name: "Browser Verification",
        prompt: "legacy browser prompt",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const run1 = spawnSync("node", [scriptPath, `--db=${dbPath}`], { encoding: "utf8", cwd: root });
    assert.equal(run1.status, 0);
    assert.match(run1.stdout, /WS-004: updated/);

    const promptValue = runSql(dbPath, "SELECT prompt FROM workflow_steps WHERE id='WS-004';").trimEnd();
    const updatedAtValue = runSql(dbPath, "SELECT updatedAt FROM workflow_steps WHERE id='WS-004';").trim();
    assert.equal(promptValue, browserPrompt);
    assert.notEqual(updatedAtValue, "2026-01-01T00:00:00.000Z");

    const run2 = spawnSync("node", [scriptPath, `--db=${dbPath}`], { encoding: "utf8", cwd: root });
    assert.equal(run2.status, 0);
    assert.match(run2.stdout, /WS-004: no-op, already up to date/);

    const runCheck = spawnSync("node", [scriptPath, `--db=${dbPath}`, "--check"], { encoding: "utf8", cwd: root });
    assert.equal(runCheck.status, 0);
    assert.match(runCheck.stdout, /no-op/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reports skipped when seeded rows are absent", () => {
  ensureCoreDist();
  const tempDir = mkdtempSync(join(tmpdir(), "fn4493-script-empty-"));
  const dbPath = join(tempDir, "fusion.db");
  try {
    createDb(dbPath, []);
    const run = spawnSync("node", [scriptPath, `--db=${dbPath}`], { encoding: "utf8", cwd: root });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /WS-004: not present, skipping/);
    assert.match(run.stdout, /WS-006: not present, skipping/);
    assert.match(run.stdout, /Updated 0 row\(s\), skipped 2, no-op 0/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

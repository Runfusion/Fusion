import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scanFileContent,
  scanTrackedFiles,
  validateAllowlistEntries,
} from "../check-no-getdatabase.mjs";

const file = "plugins/example/src/route.ts";
const line = "  return ctx.taskStore.getDatabase();";
const pinned = { file, line: 2, snippet: line.trim(), reason: "FN-9999: temporary backend-guarded shim; remove during migration.", allowlistedAt: "2026-07-16" };

function invocations(content, entries = []) {
  return scanFileContent(content, file, { allowlistEntries: entries }).filter((match) => match.type === "invocation");
}

describe("check-no-getdatabase", () => {
  it("flags executable invocations and exempts only the exact pinned occurrence", () => {
    const content = `const ignored = 1;\n${line}`;
    assert.equal(invocations(content).length, 1);
    assert.equal(scanFileContent(content, file, { allowlistEntries: [pinned] }).length, 0);
  });

  it("does not turn an invocation pin into a file-level exemption", () => {
    const content = `const ignored = 1;\n${line}\n  return ctx.taskStore.getDatabase();`;
    assert.equal(invocations(content, [pinned]).length, 1);
  });

  it("does not exempt identical source text on a different line", () => {
    const content = `const ignored = 1;\n${line}\n${line}`;
    assert.equal(invocations(content, [pinned]).length, 1);
  });

  it("flags a moved call and reports the former pin as stale", () => {
    const content = `\n\n${line}`;
    const matches = scanFileContent(content, file, { allowlistEntries: [pinned] });
    assert.equal(matches.filter((match) => match.type === "invocation").length, 1);
    assert.equal(matches.filter((match) => match.type === "stale-allowlist").length, 1);
  });

  it("fails stale allowlist fingerprints", () => {
    const content = `const ignored = 1;\n  return ctx.taskStore.getDatabase ( );`;
    const matches = scanFileContent(content, file, { allowlistEntries: [pinned] });
    assert.equal(matches.some((match) => match.type === "stale-allowlist"), true);
    assert.equal(matches.some((match) => match.type === "invocation"), true);
  });

  it("ignores comments, strings, literal templates, declarations, and near-misses", () => {
    const content = [
      "// getDatabase()",
      "/** getDatabase( */",
      "const quoted = 'getDatabase('; const double = \"call getDatabase()\";",
      "const literal = `call getDatabase() only`;",
      "getDatabase(): Database { return database; }",
      "public getDatabase(): Database { return database; }",
      "async getDatabase ( ) { return database; }",
      "interface Store { getDatabase(): Database; }",
      "const testDouble = { getDatabase() { return database; } };",
      "getDatabaseHealth(); getDatabasePath(); refreshDatabaseHealth();",
    ].join("\n");
    assert.deepEqual(invocations(content), []);
  });

  it("scans template interpolation expressions but not template literal text", () => {
    assert.equal(invocations("const text = `literal getDatabase()`;").length, 0);
    assert.equal(invocations("const text = `${ctx.taskStore.getDatabase()}`;").length, 1);
    assert.equal(invocations("const text = `${`nested ${ctx.taskStore.getDatabase()}`}`;").length, 1);
  });

  it("allows explicit backend-guarded legacy pins", () => {
    const core = "packages/core/src/store.ts";
    const legacyLine = "    await this.getDatabase().runPluginSchemaInits(";
    const entry = { file: core, line: 1, snippet: legacyLine.trim(), reason: "FN-8104: remove legacy SQLite fallback.", allowlistedAt: "2026-07-16" };
    assert.deepEqual(scanFileContent(legacyLine, core, { allowlistEntries: [entry] }), []);
  });

  it("skips deleted tracked files and rethrows non-ENOENT read failures", () => {
    const matches = scanTrackedFiles(["deleted.ts"], { allowlistEntries: [], readFile: () => { const error = new Error("gone"); error.code = "ENOENT"; throw error; } });
    assert.deepEqual(matches, []);
    assert.throws(() => scanTrackedFiles(["denied.ts"], { allowlistEntries: [], readFile: () => { throw new Error("denied"); } }), /denied/);
  });

  it("validates every required allowlist field", () => {
    for (const key of ["file", "line", "snippet", "reason", "allowlistedAt"]) {
      const candidate = { ...pinned };
      delete candidate[key];
      assert.throws(() => validateAllowlistEntries([candidate]));
    }
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
FNXC:QualityPostgres 2026-07-16-09:03:
Guardrail: QA runtime modules must not call TaskStore.getDatabase() / SQLite.
Production Fusion is PostgreSQL-only; backend mode throws if getDatabase is used.
*/

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

/** Strip block/line comments so FNXC docs mentioning getDatabase do not fail the guard. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Quality runtime has no SQLite TaskStore access", () => {
  it("routes never call getDatabase", () => {
    const src = codeOnly(readSrc("routes/create-routes.ts"));
    expect(src).not.toMatch(/getDatabase\s*\(/);
    expect(src).toMatch(/getQualityStore/);
  });

  it("store provider requires AsyncDataLayer", () => {
    const src = codeOnly(readSrc("store/quality-store-provider.ts"));
    expect(src).toMatch(/getAsyncLayer/);
    expect(src).toMatch(/AsyncQualityStore/);
    expect(src).not.toMatch(/getDatabase\s*\(/);
    expect(src).not.toMatch(/new QualityStore/);
  });

  it("command runner uses async QualityStoreApi only", () => {
    const src = codeOnly(readSrc("runner/command-runner.ts"));
    expect(src).toMatch(/QualityStoreApi/);
    expect(src).not.toMatch(/getDatabase/);
  });
});

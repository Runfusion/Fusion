import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PG_TEST_URL_BASE } from "@fusion/test-utils/pg-test-harness";

const harnessSourcePath = fileURLToPath(new URL("./_harness.ts", import.meta.url));
const pipelineStoreSourcePath = fileURLToPath(new URL("./pipeline-store.pg.test.ts", import.meta.url));

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

/*
FNXC:PgTestAuthFix 2026-07-18-07:40:
CE PostgreSQL tests must use the core harness's configured connection, rather
than introducing a postgres:postgres local fallback. This source guard runs
without PostgreSQL so embedded-database and CI credential regressions fail
before the PG-gated integration suites are reached.
*/
describe("CE PostgreSQL test base URL derivation", () => {
  it("uses the shared configured base URL and its credential-free local default", () => {
    expect(PG_TEST_URL_BASE).toBe(
      process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432",
    );

    if (process.env.FUSION_PG_TEST_URL_BASE === undefined) {
      expect(PG_TEST_URL_BASE).not.toContain("postgres:postgres@");
    }
  });

  it.each([
    ["shared CE harness", harnessSourcePath],
    ["pipeline-store PG integration test", pipelineStoreSourcePath],
  ])("keeps %s on the shared configured connection", (_name, sourcePath) => {
    const source = readSource(sourcePath);

    expect(source).toMatch(
      /import\s*\{[^}]*\bPG_TEST_URL_BASE\b[^}]*\}\s*from\s*["']@fusion\/test-utils\/pg-test-harness["']/s,
    );
    expect(source).not.toContain("postgres:postgres@localhost");
  });
});

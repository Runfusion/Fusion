/*
FNXC:Lifecycle 2026-07-16-22:40:
Migration wiring integrity — the class guard for the FN-8141 crash. Migrations are
registered EXPLICITLY in schema-applier.ts (not auto-discovered), so a new .sql
file that is not wired through a version constant + bookkeeping check silently
never runs (documented hazard). PR #2260 tripped the adjacent trap: it added a
column to the model + 0000 baseline and bumped nothing, so existing DBs never got
it.

FNXC:ReviewConvergence 2026-08-22-18:58:
These assertions used to live inside src/__tests__/postgres/schema-applier.test.ts, whose comment
claimed they "run in the merge gate" — they did not: the gate runs four named files via
`test:unit-gate` plus two *.pg.test.ts files, and that PostgreSQL-integration file is in neither.
The drift it was meant to catch then landed twice (0064, then FN-149's 0065 with the ceiling left
at 0064), and the second one made every Fusion startup fail: the binary applied 0065, recorded it,
then rejected its own database through assertBinaryNotOlderThanDatabase.

They are moved here — a file with no PostgreSQL dependency, no fixtures and no timers, reading only
the migrations directory and the applier source — precisely so `test:unit-gate` can run them
deterministically in milliseconds. Gate admission evidence: a bootable `main` is the cheapest thing
this repository can verify, and this exact drift broke it. Keep this file DB-free; anything needing
a live database belongs in the PostgreSQL suite instead.
*/

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCHEMA_BASELINE_VERSION } from "../postgres/schema-applier.js";

describe("schema-applier: migration wiring integrity", () => {
  const migrationsDir = fileURLToPath(new URL("../postgres/migrations", import.meta.url));
  const applierSource = readFileSync(
    fileURLToPath(new URL("../postgres/schema-applier.ts", import.meta.url)),
    "utf8",
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  it("advances SCHEMA_BASELINE_VERSION to the highest-numbered migration file", () => {
    const highest = migrationFiles[migrationFiles.length - 1]!.slice(0, 4);
    // A new column that ships a migration file must also bump the baseline marker
    // (else the "all markers recorded" fast-path and upgrade bookkeeping drift, and
    // the stale-binary guard rejects the database this very binary just migrated).
    expect(SCHEMA_BASELINE_VERSION).toBe(highest);
  });

  it("wires every migration .sql file into the applier so none silently never runs", () => {
    // The applier references each migration by its exact basename in a path
    // constant. A file present on disk but absent from the source is unwired.
    const unwired = migrationFiles.filter((f) => !applierSource.includes(f));
    expect(unwired).toEqual([]);
  });
});

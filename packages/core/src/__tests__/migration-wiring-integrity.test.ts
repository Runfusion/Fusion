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
import * as schemaApplier from "../postgres/schema-applier.js";

const applierSource = readFileSync(
  fileURLToPath(new URL("../postgres/schema-applier.ts", import.meta.url)),
  "utf8",
);

describe("schema-applier: migration wiring integrity", () => {
  const migrationsDir = fileURLToPath(new URL("../postgres/migrations", import.meta.url));
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

  /*
  FNXC:MigrationRestack 2026-10-12-18:24 (RUFU-615):
  The bookkeeping identity is a BARE NUMBER (`fusion_schema_migrations.version`, and the skip test is
  `applied.includes(version)`), so three things must agree on every migration: the number in the .sql
  basename, the marker written for it, and — across the fork line — which migration owns that number at all.
  The two scans above catch an unwired file and a stale ceiling; neither could catch the drift this encodes.
  Measured before the restack: files at 0086/0087/0088 were upstream's, while the markers written for them
  were 0089/0090/0091, because this line resolved every upstream collision by renumbering the INCOMING file
  instead of moving its own. Every production database therefore recorded 0087/0088/0089 for the fork's
  migrations, and the files that legitimately own those slots were skipped there permanently — silently, with
  green lint, typecheck, build and gate. A number may name exactly one migration per database; these two
  scans are what keep that true from now on.
  */
  const pathConstToFile = new Map<string, string>();
  // Path constants are named `*_MIGRATION_PATH`; three early ones omit `MIGRATION`, so the scan keys on
  // `_PATH` and on the join shape rather than on the name — a missed constant would hide a migration.
  for (const match of applierSource.matchAll(
    /const ([A-Z0-9_]+_PATH) = join\(\s*MIGRATIONS_DIR,\s*"([^"]+)"\s*,?\s*\)/g,
  )) {
    pathConstToFile.set(match[1]!, match[2]!);
  }

  /** Each `readFile(X_MIGRATION_PATH)` immediately followed by the marker its block records. */
  const recordedMarkers: Array<{ file: string; markerConst: string; marker: string }> = [];
  for (const match of applierSource.matchAll(
    /readFile\(([A-Z0-9_]+_PATH)[^)]*\)[\s\S]{0,80}?sql\.raw\([A-Za-z]+\)\)[\s\S]{0,240}?VALUES \(\$\{([A-Z0-9_]+)\}\)/g,
  )) {
    const file = pathConstToFile.get(match[1]!);
    if (!file) continue; // A path constant built outside the `join(MIGRATIONS_DIR, ...)` shape; nothing to pair.
    const markerConst = match[2]!;
    const marker = (schemaApplier as Record<string, unknown>)[markerConst];
    if (typeof marker !== "string") {
      recordedMarkers.push({ file, markerConst, marker: `<unresolved:${markerConst}>` });
      continue;
    }
    recordedMarkers.push({ file, markerConst, marker });
  }

  it("records every wired migration under the number its own file carries", () => {
    // Coverage doubles as liveness: the 0000 baseline is recorded as the ceiling rather than as 0000, and
    // every other numeric migration is written by an apply block that pairs `readFile(X_MIGRATION_PATH)` with
    // its marker. If the idiom is ever refactored away, the pairing stops matching, files fall into
    // `uncovered`, and this fails — it cannot go vacuously clean.
    const covered = new Set(recordedMarkers.map(({ file }) => file));
    const uncovered = migrationFiles.filter((f) => !/^0000_/.test(f) && !covered.has(f));
    expect(uncovered).toEqual([]);
    const mismatches = recordedMarkers
      .filter(({ file }) => /^\d{4}_/.test(file))
      .filter(({ file, marker }) => file.slice(0, 4) !== marker)
      .map(({ file, markerConst, marker }) => `${file} recorded as ${marker} (${markerConst})`);
    expect(mismatches).toEqual([]);
  });

  /*
  FNXC:MigrationRestack 2026-10-12-18:24 (RUFU-615): the same identity rule applies to a marker a migration
  writes for ITSELF. Most blocks are marked by the applier's parameterized INSERT, but a migration may
  self-mark inside its own transaction (the review-lane ledger does, so the marker rolls back with the DDL).
  Measured at the restack: that file had been renumbered twice by comment archaeology while its own literal
  still recorded the slot from its first move, so the ledger stamped 0088 — which after the restack is
  upstream FN-9512's disposition migration. A re-apply of the ledger's drift probe would then have told a
  database that a column migration had run when only the ledger had, and no read path reports that.
  */
  it("lets a self-marking migration write only its own number", () => {
    const offenders: string[] = [];
    let literalsSeen = 0;
    for (const file of migrationFiles) {
      const sql = readFileSync(`${migrationsDir}/${file}`, "utf8");
      for (const match of sql.matchAll(
        /INSERT INTO\s+(?:public\.)?fusion_schema_migrations\s*\(version\)\s*\n?\s*VALUES\s*\('([^']+)'\)/gi,
      )) {
        literalsSeen += 1;
        const written = match[1]!;
        // A non-numeric literal is a deliberate product row (e.g. the legacy-adoption-drained marker), not a
        // self-marker, and the stale-binary guard ignores non-numeric rows by contract.
        if (!/^\d{4}$/.test(written)) continue;
        if (written !== file.slice(0, 4)) offenders.push(`${file} records ${written}`);
      }
    }
    // Liveness: two migrations self-mark today (0032's drained marker and the review-lane ledger). If the
    // scan ever stops matching the statement shape at all, it would otherwise report a clean repository.
    expect(literalsSeen).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it("never lets one migration number name two migrations", () => {
    const byMarker = new Map<string, string[]>();
    for (const { file, marker } of recordedMarkers) {
      if (!/^\d{4}_/.test(file)) continue; // `local_repair_*` is intentionally outside the numeric namespace.
      byMarker.set(marker, [...(byMarker.get(marker) ?? []), file]);
    }
    const collisions = [...byMarker.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([marker, files]) => `${marker}: ${files.join(", ")}`);
    expect(collisions).toEqual([]);

    // The same rule across every exported identity, not just wired pairs: two constants holding one number is
    // how upstream FN-9429's receipts and this fork's ledger came to share a slot. The ceiling is the one
    // documented alias — it equals the highest migration by the scan above.
    const exportedVersions = Object.entries(schemaApplier)
      .filter(([, value]) => typeof value === "string" && /^\d{4}$/.test(value as string))
      .map(([name, value]) => [name, value as string] as const);
    const seen = new Map<string, string[]>();
    for (const [name, value] of exportedVersions) {
      seen.set(value, [...(seen.get(value) ?? []), name]);
    }
    const aliased = [...seen.entries()].filter(([, names]) => names.length > 1);
    for (const [value, names] of aliased) {
      expect(names, `${value} is held by more than one exported identity`).toContain("SCHEMA_BASELINE_VERSION");
      expect(names.length, `${value} is held by more than the ceiling alias`).toBe(2);
    }
  });
});

/*
FNXC:PostgresSchema 2026-09-15-22:37:
Drift probes run on databases sitting at any upgrade point, so a probe that asks whether a relation exists and
reads that same relation in the same statement is a boot crash rather than a repair. PostgreSQL resolves every
relation name in a statement at ANALYSIS time, before any branch is evaluated, so guarding a range-table read
with `CASE WHEN to_regclass(...) IS NULL THEN false ELSE ... END` in the same statement still raises 42P01
when the relation is absent, and a throw inside applySchemaBaseline means the project cannot boot at all.
RUFU-239 removed the one live instance; these scans keep the class from returning, because the failure it
prevents is every project failing to start rather than one query answering wrongly.

Scan A encodes the defect itself: no SQL fragment may test a relation for existence AND reference that same
relation as a range table entry. Deciding presence and reading the relation must be separate statements, so
the read only reaches the server when it can succeed.

Scan B bounds the blast radius: every schema-qualified range reference in the applier must be consciously
allowlisted, whether or not it carries an existence test, because a statement written against a relation a
real database may lack fails the same way either way. A new unlisted reference therefore has to be looked at
instead of shipping.

Comments are stripped before scanning — the same convention as the engine's tombstone guard — so prose can
never satisfy a structural scan, and each scan asserts its own pattern is still live, because a scanner whose
regular expressions stopped matching anything would report a clean repository.
*/
describe("schema-applier: drift probes stay analysis-safe on absent relations", () => {
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  /** Every backtick-quoted fragment: `sql` templates and sql.raw(...) bodies alike. */
  const sqlFragments = (source: string): string[] => source.match(/`[^`]*`/g) ?? [];

  const RELATION_RE = /to_regclass\(\s*'(project|central|archive)\.([^']+)'\s*\)/gi;
  const RANGE_REF_RE = /\b(from|join|update|insert\s+into|delete\s+from)\s+(project|central|archive)\.([A-Za-z0-9_"]+)/gi;
  const normalizeRelation = (schema: string, relation: string): string => `${schema}.${relation}`.toLowerCase();
  const normalizeRef = (keyword: string, schema: string, relation: string): string =>
    `${keyword.replace(/\s+/g, " ").toLowerCase()} ${normalizeRelation(schema, relation)}`;
  const describeFragment = (fragment: string): string => fragment.replace(/\s+/g, " ").trim().slice(0, 140);

  const fragments = sqlFragments(stripComments(applierSource));

  it("does not test a relation for existence in the same statement that reads it", () => {
    let existenceTests = 0;
    const violations: string[] = [];
    for (const fragment of fragments) {
      const existenceTested = new Set<string>();
      for (const match of fragment.matchAll(RELATION_RE)) {
        existenceTests += 1;
        existenceTested.add(normalizeRelation(match[1]!, match[2]!));
      }
      for (const match of fragment.matchAll(RANGE_REF_RE)) {
        const relation = normalizeRelation(match[2]!, match[3]!);
        if (existenceTested.has(relation)) {
          violations.push(`${relation} in: ${describeFragment(fragment)}`);
        }
      }
    }
    // Liveness: if the existence-test pattern ever stops matching, the scan below is vacuously clean.
    expect(existenceTests).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("keeps every schema-qualified range reference inside an explicit allowlist", () => {
    /*
    FNXC:OverlapWaitSynchronization 2026-09-15-22:37:
    The single approved reference is migration 0078's retired-phase row probe. It is safe only because a
    separate to_regclass statement decides presence first and the applier issues this fragment when that probe
    reported the relation present — the two-step shape RUFU-239 introduced. Adding a relation here means
    promising the same discipline; the alternative, and the default for any probe, is a catalog-only predicate
    over pg_class/pg_namespace. Matching is lowercase because PostgreSQL folds unquoted identifiers.
    */
    const approvedRangeRefs = new Set(["from project.task_overlap_waits"]);

    const observed: string[] = [];
    const unapproved: string[] = [];
    for (const fragment of fragments) {
      for (const match of fragment.matchAll(RANGE_REF_RE)) {
        const ref = normalizeRef(match[1]!, match[2]!, match[3]!);
        observed.push(ref);
        if (!approvedRangeRefs.has(ref)) {
          unapproved.push(`${ref} in: ${describeFragment(fragment)}`);
        }
      }
    }
    expect(unapproved).toEqual([]);
    // A stale allowlist is how the next writer re-adds a reference nobody reviewed.
    for (const approved of approvedRangeRefs) {
      expect(observed).toContain(approved);
    }
  });
});

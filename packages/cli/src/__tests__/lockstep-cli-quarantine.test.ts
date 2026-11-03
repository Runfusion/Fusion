import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type QuarantineEntry = {
  file: string;
  reason: string;
  quarantinedAt: string;
};

const repoRoot = resolve(import.meta.dirname!, "../../../..");
const configPath = resolve(repoRoot, "packages/cli/vitest.config.ts");
const ledgerPath = resolve(repoRoot, "scripts/lib/test-quarantine.json");
const cliPathPrefix = "packages/cli/";
const iso8601Timestamp = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function parseQuarantinedCliTests(configSource: string): string[] {
  const declaration = configSource.match(/const quarantinedCliTests: string\[\] = \[([\s\S]*?)\n\];/);
  expect(declaration, "quarantinedCliTests declaration must remain statically parseable").not.toBeNull();

  return [...declaration![1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function countByPath(paths: string[]): Map<string, number> {
  return paths.reduce((counts, path) => counts.set(path, (counts.get(path) ?? 0) + 1), new Map<string, number>());
}

function normalizeConfigPath(path: string): string {
  return `${cliPathPrefix}${path}`;
}

describe("CLI quarantine ledger lockstep", () => {
  /*
  FNXC:CliTests 2026-07-17-10:45:
  FN-8223 widens this guard to the full CLI quarantine surface after FN-8219
  deleted its five expired paths and FN-8210 rescued package-config.test.ts.
  Every package-relative Vitest exclude and repo-relative packages/cli ledger
  row must now match exactly once, preventing future one-sided quarantine drift.
  */
  it("keeps all CLI config excludes and ledger rows in bidirectional lockstep", () => {
    const configPaths = parseQuarantinedCliTests(readFileSync(configPath, "utf8")).map(normalizeConfigPath);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: QuarantineEntry[] };
    const ledgerEntries = ledger.entries.filter((entry) => entry.file.startsWith(cliPathPrefix));
    const ledgerPaths = ledgerEntries.map((entry) => entry.file);
    const configCounts = countByPath(configPaths);
    const ledgerCounts = countByPath(ledgerPaths);

    for (const count of configCounts.values()) {
      expect(count).toBe(1);
    }
    for (const count of ledgerCounts.values()) {
      expect(count).toBe(1);
    }
    expect(configCounts).toEqual(ledgerCounts);

    for (const entry of ledgerEntries) {
      expect(entry.reason.trim()).not.toBe("");
      expect(entry.quarantinedAt).toMatch(iso8601Timestamp);
      expect(Number.isNaN(Date.parse(entry.quarantinedAt))).toBe(false);
    }
  });

  /*
  FNXC:TestQuarantineLockstep 2026-11-03-14:31:
  FN-9425 quarantined skills-get.test.ts on 2026-09-29 for Full Suite timeouts. The quarantine expired at the
  14-day deletion clock, and `check-quarantine-ledger.mjs --strict` fails on any expired entry - that, not eslint,
  was what made CI's Lint job red. Measured on a built tree the file passes 7/7 with no assertion defect, so the
  correct ratchet outcome is RESCUE (quarantine lifted, coverage kept), not deletion.
  This guard therefore pins the rescue in lockstep: neither the vitest exclude nor the ledger row may reference
  the file again, and the file itself must still exist so a later "cleanup" cannot quietly turn the rescue back
  into a deletion. Both sides move together or this test fails, which is the whole point of the guard.
  */
  it("rescued the FN-9425 skills-get quarantine in lockstep", () => {
    const rescuedFile = "src/commands/__tests__/skills-get.test.ts";
    const configPaths = parseQuarantinedCliTests(readFileSync(configPath, "utf8"));
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: QuarantineEntry[] };
    const entries = ledger.entries.filter((entry) => entry.file === `${cliPathPrefix}${rescuedFile}`);

    expect(configPaths.filter((path) => path === rescuedFile)).toHaveLength(0);
    expect(entries).toHaveLength(0);
    // Rescued means kept and running, so the file must still be on disk.
    expect(() => readFileSync(resolve(repoRoot, "packages/cli", rescuedFile))).not.toThrow();
  });
});

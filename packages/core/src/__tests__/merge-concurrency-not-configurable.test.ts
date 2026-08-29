import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTraitRegistry } from "../workflows/trait-registry.js";
import { registerBuiltinTraits } from "../builtin-traits.js";
import { DEFAULT_SETTINGS } from "../config/settings-schema.js";

/*
FNXC:CapacityModel 2026-07-28-10:15:
MERGE CONCURRENCY MUST NEVER BECOME A SETTING.

The capacity model is two CONFIGURABLE numbers per project (total agents,
maxWorktrees) plus one FIXED invariant: exactly one merge in flight per project.
The enforcement lives in the engine's merge pump and is ratcheted by
`packages/engine/src/__tests__/merge-single-flight-invariant.test.ts`.

THIS file guards the other direction — that no one makes the fixed number
configurable. A merge-concurrency knob would not fail the pump ratchet: it would
sit unread for a release (like `maxTriageConcurrent`, which shipped in the schema,
the Settings UI and i18n while being read by ZERO enforcement sites) and then get
wired up by someone who assumed a setting that exists must mean something. Merge
is where the irreversible work happens; every merge-safety guard assumes one.
*/

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_SOURCES = [
  join(HERE, "..", "config", "settings-schema.ts"),
  join(HERE, "..", "types", "settings", "settings-scope.ts"),
  join(HERE, "..", "types", "merge", "merge-policy.ts"),
];

/**
 * An identifier is a merge-concurrency knob when it names BOTH merge and a
 * capacity concept. Requiring both halves keeps `maxConcurrentVerifications`
 * (capacity, not merge) and `mergeIntegrationWorktree` (merge, not capacity) out
 * of the net, which is what makes a hit here meaningful rather than noise.
 */
const MERGE_CONCURRENCY_IDENTIFIER =
  /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
const NAMES_MERGE = /merge/i;
const NAMES_CAPACITY = /(concurren|parallel|lane|slot|worker|simultaneous|inflight|in_flight)/i;

function findMergeConcurrencyIdentifiers(source: string): string[] {
  const hits = new Set<string>();
  for (const ident of source.match(MERGE_CONCURRENCY_IDENTIFIER) ?? []) {
    if (NAMES_MERGE.test(ident) && NAMES_CAPACITY.test(ident)) hits.add(ident);
  }
  return [...hits];
}

describe("merge concurrency is fixed at 1 and cannot be made configurable", () => {
  /*
  SELF-CHECK FIRST. A source-scanning guard that silently reads nothing, or whose
  pattern no longer matches its own defect, reports success while checking
  nothing — the failure mode this program has hit repeatedly (the pool-id sentinel
  that never matched, the ratchet whose regex missed its own case). Prove the
  detector works on a known positive and a known negative BEFORE trusting a pass.
  */
  it("the detector actually detects (positive and negative controls)", () => {
    expect(findMergeConcurrencyIdentifiers("maxConcurrentMerges: 2,")).toEqual(["maxConcurrentMerges"]);
    expect(findMergeConcurrencyIdentifiers("mergeLanes: 3,")).toEqual(["mergeLanes"]);
    expect(findMergeConcurrencyIdentifiers("parallelMergeWorkers?: number;")).toEqual(["parallelMergeWorkers"]);
    // Negative controls: capacity-but-not-merge, and merge-but-not-capacity.
    expect(findMergeConcurrencyIdentifiers("maxConcurrentVerifications: 1,")).toEqual([]);
    expect(findMergeConcurrencyIdentifiers("mergeIntegrationWorktree: 'reuse-task-worktree',")).toEqual([]);
  });

  it("no settings key expresses a merge concurrency", () => {
    for (const file of SETTINGS_SOURCES) {
      const source = readFileSync(file, "utf8");
      // FAIL CLOSED: an empty/moved file means we checked nothing.
      expect(source.length, `${file} is empty or unreadable — the guard checked nothing`).toBeGreaterThan(500);
      expect(findMergeConcurrencyIdentifiers(source), `${file} declares a merge-concurrency knob`).toEqual([]);
    }
  });

  it("the merge trait exposes no concurrency/limit configuration", () => {
    registerBuiltinTraits();
    const mergeTrait = getTraitRegistry().getTrait("merge");
    expect(mergeTrait, "the `merge` trait must exist for this guard to mean anything").toBeDefined();

    const fieldKeys = (mergeTrait!.configSchema?.fields ?? []).map((f) => f.key);
    expect(fieldKeys.length, "merge trait has no config fields — guard is vacuous").toBeGreaterThan(0);

    const offenders = fieldKeys.filter((k) => NAMES_CAPACITY.test(k) || /^limit/i.test(k));
    expect(offenders, "the merge trait must not let a workflow configure merge concurrency").toEqual([]);
  });

  /*
  FNXC:CapacityModel 2026-07-28-14:30:
  TOMBSTONE. `maxTriageConcurrent` shipped as a settings default, a Settings
  section key, a /config response field and six i18n catalogs while being read by
  ZERO enforcement sites — FN-8453 removed the pool it gated and left the knob
  behind. It is deleted; this keeps it deleted. A knob that no longer does anything
  is worse than a deleted one: the next person to find it wires it up.
  */
  it("maxTriageConcurrent stays deleted (dead-knob tombstone)", () => {
    for (const file of SETTINGS_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source.length, `${file} is empty or unreadable — the guard checked nothing`).toBeGreaterThan(500);
      expect(source).not.toContain("maxTriageConcurrent");
    }
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("maxTriageConcurrent");
  });

  it("the merge trait carries no wip/capacity flag", () => {
    registerBuiltinTraits();
    const mergeTrait = getTraitRegistry().getTrait("merge");
    // `countsTowardWip` on the merge trait would pool merge into the WIP budget and
    // make merge concurrency follow the agent count instead of being fixed at 1.
    expect(mergeTrait!.flags.countsTowardWip ?? false).toBe(false);
  });
});

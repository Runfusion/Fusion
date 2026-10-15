import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractLeadingStaticGateChecks,
  readStaticGateChecks,
  runStaticGateChecks,
} from "../run-static-gate-checks.mjs";

const check = (name) => `scripts/check-${name}.mjs`;
/*
FNXC:TestInfrastructure 2026-08-16-10:52:
FN-8991, FN-8994, and FN-9096 added runtime-skill-loader-drift,
workspace-package-graph, and cli-runtime-routing validators to the production
chains. Those chains are authoritative; retain their exact order here so this
mirror reports future declaration drift rather than preserving a stale list.

FNXC:TestInfrastructure 2026-08-25-12:13:
Commit 12c292ea6b added the 16th validator, check-no-comment-assertions-in-tests,
to the production gate:static chain without updating this mirror. RUFU-148
restores lockstep at the live position (between no-test-timeout-appeasement and
changeset-format); the chain in package.json remains the source of truth.

FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
RUFU-265 appends the 17th validator, check-fusion-skill-sync, at the end of the
chain so the contiguous validator prefix is preserved. It is the enforcement
point for the generated skill catalog: builds no longer regenerate those tracked
docs, so drift in the committed file must fail the blocking gate instead of
being silently rewritten by CI's earlier build step.

FNXC:LockfileDriftGate 2026-09-22-19:20:
RUFU-266 adds the 18th validator, check-lockfile-importers, beside
check-workspace-package-graph — both answer "does the workspace's declared
dependency graph actually match what is committed?", one against the workspace
globs and one against pnpm-lock.yaml. It belongs in the blocking chain because a
drifted committed lockfile is not discoverable from a task worktree: the dependency
auto-heal silently repairs it locally, and the resulting out-of-scope diff fails
unrelated cards' squash merges.

FNXC:RetentionCensus 2026-09-23-10:20 (RUFU-257):
RUFU-257 appends the 19th validator, check-retention-coverage, at the end of the chain. A dashboard
killed by its own heap looks like an infrastructure failure and costs hours of forensics, which is how
RUFU-249's death was finally explained; the census only prevents a recurrence while the ratchet that
forces every new module-scope cache to declare its bound stays in the BLOCKING chain. It runs there
rather than as an extra Lint step because `pnpm test:gate` already invokes every `check-*.mjs` in this
list through `run-static-gate-checks.mjs`, and Gate is one of the four required checks.
*/
const EXPECTED_GATE_CHECKS = [
  check(["no-", ["no", "hup"].join("")].join("")),
  check("no-cwd-relative-dashboard-test-reads"),
  check(["no-", "kill-", "40" + "40"].join("")),
  check("no-getdatabase"),
  check("prerebase-inert"),
  check("capacity-pool-id"),
  check("cli-runtime-routing"),
  check("no-node-only-core-imports-in-dashboard"),
  check("pi-versions-pinned"),
  check("workspace-package-graph"),
  check("lockfile-importers"),
  check("no-test-timeout-appeasement"),
  check("no-comment-assertions-in-tests"),
  check("changeset-format"),
  check("mock-completeness"),
  check("inert-sync-lane-conversions"),
  check("runtime-skill-loader-drift"),
  check("fusion-skill-sync"),
  check("retention-coverage"),
  /*
  FNXC:TestInfrastructure 2026-10-08-05:06 (RUFU-324):
  check-changeset-migration-references was already the 20th validator in the production chain but was
  missing from this mirror, which is why this test was red before RUFU-324 touched anything (proved at
  base 89c2b53510: `node --test scripts/__tests__/run-static-gate-checks.test.mjs` -> 1 failure, plus 2
  in verify-fast.test.mjs). Repaired in the same commit that appends the 21st validator, because a
  permanently-red drift guard cannot report the drift it exists to catch.
  */
  check("changeset-migration-references"),
  /*
  FNXC:OperatorLanguageIntegrity 2026-10-08-05:06 (RUFU-324):
  Appends the 21st validator, check-nonlatin-tracked-text, at the end of the blocking chain. Model
  code-switch contamination in stored cards, PROMPT.md contracts, docs, and shipped source has been
  observed three times (RUFU-266 Cyrillic board cards, FNXC:FleetClaims' CJK comment, and a CJK
  insertion inside a shipped type contract's JSDoc) and no blocking chain could see any of it: lint,
  typecheck, build, and the gate ignore non-ASCII text entirely. Membership is pinned on its own below
  for the same reason RUFU-257/266 pinned theirs — the mirror list above would be updated by the very
  reshuffle that dropped the validator.
  */
  check("nonlatin-tracked-text"),
  /*
  FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
  Appends the 22nd validator, check-prompt-volatility, at the end of the blocking chain. Appending keeps
  the contiguous validator prefix in the same order package.json declares it, which the deep-equal mirror
  below compares positionally.
  */
  check("prompt-volatility"),
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "static-gate-checks-"));
  mkdirSync(join(root, "scripts"));
  return root;
}

function writeFixtureCheck(root, name, source) {
  writeFileSync(join(root, "scripts", `${name}.mjs`), source);
}

test("extractLeadingStaticGateChecks keeps only the blocking validator prefix", () => {
  assert.deepEqual(
    extractLeadingStaticGateChecks("node scripts/check-one.mjs && node scripts/check-two.mjs && sh -c 'test lanes'"),
    ["scripts/check-one.mjs", "scripts/check-two.mjs"],
  );
  assert.throws(
    () => extractLeadingStaticGateChecks("pnpm --filter @fusion/engine test:core"),
    /must contain one or more canonical static validators/,
  );
});

test("production gate inventory contains each canonical validator exactly once", () => {
  const checks = readStaticGateChecks();
  assert.deepEqual(checks, EXPECTED_GATE_CHECKS);
  assert.equal(new Set(checks).size, checks.length);
});

/*
FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
RUFU-265: the generated skill catalog has no build-time writer anymore, so the
drift check is the only thing standing between a stale committed catalog and
shipping it. Pin its membership in the blocking chain explicitly — the deep-equal
mirror above would also pass if someone dropped the entry and this list with it.
*/
test("blocking gate chain enforces the generated skill catalog drift check", () => {
  const checks = readStaticGateChecks();
  assert.ok(
    checks.includes(check("fusion-skill-sync")),
    "scripts/check-fusion-skill-sync.mjs must stay in the contiguous blocking validator prefix of test:gate:static",
  );
});

/*
FNXC:LockfileDriftGate 2026-09-22-19:20:
RUFU-266: mirror membership alone does not prove the validator is required, so pin
its blocking-chain membership explicitly the way RUFU-265 pinned fusion-skill-sync.
*/
test("blocking gate chain enforces lockfile/importer parity", () => {
  const checks = readStaticGateChecks();
  assert.ok(
    checks.includes(check("lockfile-importers")),
    "scripts/check-lockfile-importers.mjs must stay in the contiguous blocking validator prefix of test:gate:static",
  );
});

/*
FNXC:RetentionCensus 2026-09-23-12:15 (RUFU-257):
Same reasoning RUFU-266 applied to lockfile parity: the mirror list above would be updated by the very
refactor that dropped the validator, so membership in the blocking prefix is pinned on its own. This is
the check that keeps a future chain reshuffle from quietly downgrading the retention ratchet to a
non-blocking step, which is the failure mode that let seven heap deaths accumulate before RUFU-249 was
explained.
*/
test("blocking gate chain enforces module-scope retention coverage", () => {
  const checks = readStaticGateChecks();
  assert.ok(
    checks.includes(check("retention-coverage")),
    "scripts/check-retention-coverage.mjs must stay in the contiguous blocking validator prefix of test:gate:static",
  );
});

/*
FNXC:OperatorLanguageIntegrity 2026-10-08-05:06 (RUFU-324):
Same reasoning as RUFU-257/RUFU-266 above: pin membership directly so a chain reshuffle cannot
quietly downgrade the operator-language ratchet to a non-blocking step. Contamination that reaches
main is invisible to every other required check, so a gate that stops running it is the same as no
ratchet at all.
*/
test("blocking gate chain enforces non-Latin script contamination detection", () => {
  const checks = readStaticGateChecks();
  assert.ok(
    checks.includes(check("nonlatin-tracked-text")),
    "scripts/check-nonlatin-tracked-text.mjs must stay in the contiguous blocking validator prefix of test:gate:static",
  );
});

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
Same reasoning as the retention and lockfile pins: the mirror list above is updated by the very refactor
that would drop a validator, so blocking membership is asserted on its own. A prompt-volatility guard that
silently left the blocking chain would be decoration — the volatile-creep defect it prevents is invisible
to every other gate (a lane that re-adds runtime state to a system prompt keeps lint, typecheck, build and
tests green; only provider-side cache behaviour notices).
*/
test("blocking gate chain enforces serialized-prompt volatility scanning", () => {
  const checks = readStaticGateChecks();
  assert.ok(
    checks.includes(check("prompt-volatility")),
    "scripts/check-prompt-volatility.mjs must stay in the contiguous blocking validator prefix of test:gate:static",
  );
});

test("runStaticGateChecks runs clean fixture validators and waits for all", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-first", 'console.log("first passed");');
    writeFixtureCheck(root, "check-second", 'console.log("second passed");');
    const messages = [];
    const results = await runStaticGateChecks(
      ["scripts/check-first.mjs", "scripts/check-second.mjs"],
      { root, log: (message) => messages.push(message) },
    );

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.deepEqual(messages, ["[static-gate] 2 validators passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStaticGateChecks reports every violating fixture validator before failing closed", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-clean", 'process.exit(0);');
    writeFixtureCheck(root, "check-first-violation", 'console.error("first violation"); process.exit(1);');
    writeFixtureCheck(root, "check-second-violation", 'console.error("second violation"); process.exit(2);');
    const errors = [];

    await assert.rejects(
      () => runStaticGateChecks(
        [
          "scripts/check-clean.mjs",
          "scripts/check-first-violation.mjs",
          "scripts/check-second-violation.mjs",
        ],
        { root, errorLog: (message) => errors.push(message) },
      ),
      /2 static merge-gate validators failed/,
    );

    assert.deepEqual(errors, [
      "[static-gate] validator failed: scripts/check-first-violation.mjs (exit 1)",
      "[static-gate] validator failed: scripts/check-second-violation.mjs (exit 2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

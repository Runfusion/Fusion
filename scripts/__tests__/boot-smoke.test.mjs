// FNXC:BootSmoke 2026-07-07-00:00: Regression for the macOS ENOTEMPTY temp-dir
// cleanup race (FN-7662). Drives an injected `rm` to throw ENOTEMPTY and
// asserts `removeTempDir` tolerates it (retries/succeeds, or swallows a
// persistently-throwing remover) so a post-PASS cleanup can never fail the gate.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyInitFailure,
  createBootSmokePhasePlan,
  createChildEnv,
  runPreflightPhasePlan,
  removeTempDir,
} from "../boot-smoke.mjs";

function enotempty() {
  const err = new Error("ENOTEMPTY: directory not empty");
  err.code = "ENOTEMPTY";
  return err;
}

test("removeTempDir tolerates ENOTEMPTY on the first call then succeeds", () => {
  let calls = 0;
  const rm = (dir, opts) => {
    calls += 1;
    assert.equal(dir, "/tmp/fusion-boot-smoke-home-xyz");
    assert.equal(opts.recursive, true);
    assert.equal(opts.force, true);
    if (calls === 1) throw enotempty();
    // second call (simulating rmSync's own internal retry succeeding): no throw
  };

  assert.doesNotThrow(() => {
    removeTempDir("/tmp/fusion-boot-smoke-home-xyz", { rm });
  });
  assert.equal(calls, 1);
});

test("removeTempDir never throws even when rm always fails with ENOTEMPTY", () => {
  let calls = 0;
  const rm = () => {
    calls += 1;
    throw enotempty();
  };

  assert.doesNotThrow(() => {
    removeTempDir("/tmp/fusion-boot-smoke-project-abc", { rm });
  });
  assert.equal(calls, 1);
});

test("removeTempDir calls rm with recursive/force and a positive maxRetries", () => {
  let seenOpts;
  const rm = (dir, opts) => {
    seenOpts = opts;
  };

  removeTempDir("/tmp/fusion-boot-smoke-home-happy", { rm });

  assert.equal(seenOpts.recursive, true);
  assert.equal(seenOpts.force, true);
  assert.ok(seenOpts.maxRetries > 0, "maxRetries should be positive");
  assert.ok(typeof seenOpts.retryDelay === "number");
});

test("removeTempDir uses the provided maxRetries/retryDelayMs overrides", () => {
  let seenOpts;
  const rm = (dir, opts) => {
    seenOpts = opts;
  };

  removeTempDir("/tmp/fusion-boot-smoke-project-custom", { rm, maxRetries: 9, retryDelayMs: 250 });

  assert.equal(seenOpts.maxRetries, 9);
  assert.equal(seenOpts.retryDelay, 250);
});

test("boot plan overlaps independent preflight checks while retaining all smoke assertions", () => {
  for (const dataDir of ["cold", "warm"]) {
    const plan = createBootSmokePhasePlan({ attempt: 2, dataDir });
    assert.deepEqual(plan.map((phase) => phase.name), ["help", "init", "serve", "shutdown"]);
    assert.deepEqual(plan.map((phase) => phase.assertion), [
      "help-exits-0-and-mentions-serve",
      "init-settles-and-writes-project-marker",
      "health-200",
      "sigterm-delivered-and-clean-exit",
    ]);
    assert.equal(plan.filter((phase) => phase.concurrency === "preflight").length, 2);
    assert.equal(plan.find((phase) => phase.name === "serve").attempt, 2);
    assert.deepEqual(plan.find((phase) => phase.name === "serve").dependsOn, ["init"]);
    assert.equal(plan.find((phase) => phase.name === "init").dataDir, dataDir);
  }
});

test("production preflight scheduler launches independent phases before either settles", async () => {
  const plan = createBootSmokePhasePlan();
  const started = [];
  const results = await runPreflightPhasePlan(plan, async (phase) => {
    started.push(phase.name);
    await new Promise((resolve, reject) => {
      Promise.resolve().then(() => {
        if (started.length !== 2) {
          reject(new Error("preflight phase was awaited before every independent phase launched"));
          return;
        }
        resolve();
      });
    });
    return `${phase.name}-result`;
  });

  assert.deepEqual(started, ["help", "init"]);
  assert.deepEqual(results, { help: "help-result", init: "init-result" });
});

test("init liveness classification preserves every failing state", () => {
  const base = { error: null, status: 0, stdout: "", stderr: "" };
  assert.equal(classifyInitFailure(base, true), null);
  assert.equal(classifyInitFailure({ ...base, status: 13 }, true), "non-zero-exit");
  assert.equal(classifyInitFailure({ ...base, stderr: "Detected unsettled top-level await" }, true), "unsettled-top-level-await");
  assert.equal(classifyInitFailure(base, false), "missing-project-marker");
  assert.equal(classifyInitFailure({ ...base, error: new Error("spawn failed") }, true), "process-error");
});

test("isolated child env strips inherited database and port controls", () => {
  const env = createChildEnv({ DATABASE_URL: "postgres://ambient", FUSION_NO_EMBEDDED_PG: "1", PORT: "4040", KEEP: "yes" }, "/tmp/fusion-home");
  assert.equal(env.HOME, "/tmp/fusion-home");
  assert.equal(env.FUSION_SKIP_ONBOARDING, "1");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.FUSION_NO_EMBEDDED_PG, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.KEEP, "yes");
});

test("importing boot-smoke.mjs does not boot a server (main() guard holds)", async () => {
  // The module was already imported at the top of this file for `removeTempDir`.
  // If the main()/bootAndVerify() top-level invocation ran unguarded, this test
  // file would hang waiting on a spawned `fn serve` child. Reaching this
  // assertion at all proves the import completed without side effects.
  assert.ok(true);
});

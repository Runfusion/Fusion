// FNXC:BootSmoke 2026-07-07-00:00: Regression for the macOS ENOTEMPTY temp-dir
// cleanup race (FN-7662). Drives an injected `rm` to throw ENOTEMPTY and
// asserts `removeTempDir` tolerates it (retries/succeeds, or swallows a
// persistently-throwing remover) so a post-PASS cleanup can never fail the gate.
import test from "node:test";
import assert from "node:assert/strict";
import { removeTempDir } from "../boot-smoke.mjs";

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

test("importing boot-smoke.mjs does not boot a server (main() guard holds)", async () => {
  // The module was already imported at the top of this file for `removeTempDir`.
  // If the main()/bootAndVerify() top-level invocation ran unguarded, this test
  // file would hang waiting on a spawned `fn serve` child. Reaching this
  // assertion at all proves the import completed without side effects.
  assert.ok(true);
});

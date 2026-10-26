/*
FNXC:HeapFloorProbe 2026-10-26-01:37 (RUFU-627 Step 6):
The in-proc lane for the heap-floor probe. It exercises the probe's MEASUREMENT and its VERDICT against
an injected store, which is what makes it CI-legal: no backend, no seconds-long soak, no heap claim.

What this file does NOT prove: that the real store coalesces. `list-tasks-inflight-coalescing.pg.test.ts`
owns that claim against a real database. Here the store is a fake, so the assertion under test is the
probe's — that Leg A genuinely overlaps its readers, that the read-count rule accepts a coalescing store
and rejects a non-coalescing one, and that the retained rule reports itself as gated rather than passing
when `--expose-gc` is absent. A probe whose verdict cannot be made to fail is worse than no probe, because
its PASS line is what an operator quotes.

The retained leg is driven with an injected heap sampler rather than a real one: whether GC is available
is a property of the runner, and the probe must be testable on a runner where it is not.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_READERS_PER_GROUP,
  evaluateSamples,
  parsedBytesOf,
  planLegs,
  probeReadShape,
  runProbe,
} from "../lib/heap-floor-probe.mjs";

const CARDS = 40;
const DESCRIPTION_BYTES = 512;

function makeBoard() {
  return Array.from({ length: CARDS }, (_, i) => ({
    id: `RUFU-${1000 + i}`,
    title: `card ${i}`,
    description: "d".repeat(DESCRIPTION_BYTES),
    column: "todo",
    steps: [],
    attachments: [],
    log: [],
  }));
}

/**
 * A store stand-in that counts UNDERLYING fetches, the way the production attribution seam does, and
 * shares one in-flight fetch per identical option bag while `coalescing` is true. `maxConcurrent` is
 * observed at the fetch site, so a probe that quietly serialized its readers would be caught by it.
 */
function fakeStore({ coalescing = true } = {}) {
  const board = Object.freeze(makeBoard());
  let fetches = 0;
  let inFlight = 0;
  let allocated = 0;
  let maxConcurrent = 0;
  const inflightByKey = new Map();

  return {
    fetches: () => fetches,
    allocated: () => allocated,
    maxConcurrentFetches: () => maxConcurrent,
    listTasks(options) {
      const key = JSON.stringify(options);
      if (coalescing && options.coalesce !== false && inflightByKey.has(key)) return inflightByKey.get(key);

      const promise = (async () => {
        fetches += 1;
        // Every underlying fetch materializes one board's worth of bytes; nothing else allocates.
        allocated += BOARD_BYTES;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 4));
        inFlight -= 1;
        return board;
      })().finally(() => inflightByKey.delete(key));

      inflightByKey.set(key, promise);
      return promise;
    },
  };
}

/**
 * The heap samplers are injected, and they are scripted off a physical quantity rather than a literal:
 * the fake store charges `BOARD_BYTES` of allocation to every underlying FETCH it performs. So Leg A's
 * peak is one board (one fetch served four readers), the uncoalesced control's peak is four boards, and
 * the sequential leg's peak is one board — which is precisely the "one materialization measured in this
 * same run" the peak bound is expressed against. A scripted constant per leg would have tested nothing
 * but my own ordering assumptions.
 */
const BOARD_BYTES = 1_000_000;

function contextFor(store) {
  return {
    listTasks: (options) => store.listTasks(options),
    listReadCalls: () => store.fetches(),
    sampleHeap: () => store.allocated(),
    samplePeak: () => store.allocated(),
    collectAndSampleHeap: () => null,
  };
}

test("Leg A overlaps its readers and one fetch serves the group", async () => {
  const store = fakeStore();
  let outstanding = 0;
  let maxOutstanding = 0;
  const context = {
    listTasks: async (options) => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      try {
        return await store.listTasks(options);
      } finally {
        outstanding -= 1;
      }
    },
    listReadCalls: () => store.fetches(),
    sampleHeap: () => store.allocated(),
    samplePeak: () => store.allocated(),
    collectAndSampleHeap: () => null,
  };

  // Run Leg A on its own so every counter belongs to it; a plan that mixes legs cannot attribute
  // concurrency to one leg, and an earlier draft of this test passed on the CONTROL leg's concurrency.
  await runProbe(context, [{ leg: "A-overlap", groups: 2, readersPerGroup: 4, overlapping: true }]);

  // The sequential-loop trap: a leg that awaits one read before starting the next cannot show
  // coalescing, and a probe that measured that would report a flat curve as a fix working.
  assert.equal(maxOutstanding, 4, "Leg A must hold every reader outstanding at once");
  assert.equal(store.maxConcurrentFetches(), 1, "a coalescing store must serve the group from one fetch");
  assert.equal(store.fetches(), 2, "two groups, two fetches");
});

test("the same overlap on a non-coalescing store costs one fetch per reader", async () => {
  const store = fakeStore({ coalescing: false });
  await runProbe(contextFor(store), [
    { leg: "A-overlap-control-uncoalesced", groups: 2, readersPerGroup: 4, overlapping: true, coalesce: false },
  ]);

  // This pair with the test above is what makes the probe able to distinguish before from after: the
  // reader pattern is identical, only the coalescing differs, and the fetch count moves 2 -> 8.
  assert.equal(store.maxConcurrentFetches(), 4, "the control must overlap the same way Leg A does");
  assert.equal(store.fetches(), 8);
});

test("Leg B stays a control: it never overlaps", async () => {
  const store = fakeStore();
  const samples = await runProbe(contextFor(store), [
    { leg: "B-sequential", groups: 4, readersPerGroup: 1, overlapping: false },
  ]);

  assert.equal(store.maxConcurrentFetches(), 1);
  assert.equal(samples.length, 4);
  assert.ok(samples.every((s) => s.readers === 1 && s.listReads === 1));
});

test("a coalescing store passes the bounded overlap read-count assertion", async () => {
  const store = fakeStore();
  const samples = await runProbe(contextFor(store), planLegs({ groups: 3, readersPerGroup: 4 }));
  const verdict = evaluateSamples(samples);

  assert.deepEqual(verdict.failures, [], `unexpected failures: ${verdict.failures.join("; ")}`);
  const legA = samples.filter((s) => s.leg === "A-overlap");
  assert.equal(legA.length, 3);
  assert.ok(legA.every((s) => s.listReads === 1), "N overlapping same-shape readers must cost one fetch");
  assert.ok(legA.every((s) => s.sharedArrayIdentity === true), "the readers must be handed one shared array");
  const control = samples.filter((s) => s.leg === "A-overlap-control-uncoalesced");
  assert.ok(control.every((s) => s.listReads === s.readers), "the control must cost one fetch per reader");
});

test("a non-coalescing store FAILS the same assertion — the verdict is not vacuous", async () => {
  const store = fakeStore({ coalescing: false });
  const samples = await runProbe(contextFor(store), planLegs({ groups: 3, readersPerGroup: 4 }));
  const verdict = evaluateSamples(samples);

  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.failures.some((f) => f.includes("Leg A group") && f.includes("expected 1")),
    `expected a Leg A read-count failure, got: ${verdict.failures.join("; ")}`,
  );
});

test("a coalescing store stays inside the peak factor of one materialization", async () => {
  const store = fakeStore();
  const samples = await runProbe(contextFor(store), planLegs({ groups: 3, readersPerGroup: 4 }));

  const legA = samples.filter((s) => s.leg === "A-overlap");
  const control = samples.filter((s) => s.leg === "A-overlap-control-uncoalesced");
  const sequential = samples.filter((s) => s.leg === "B-sequential");
  assert.ok(legA.every((s) => s.peakBytes === BOARD_BYTES), "one fetch must materialize one board");
  assert.ok(control.every((s) => s.peakBytes === 4 * BOARD_BYTES), "the control must materialize one per reader");
  assert.ok(sequential.every((s) => s.peakBytes === BOARD_BYTES));
  assert.deepEqual(evaluateSamples(samples).failures, []);
});

test("an uncoalescing store blows BOTH the read count and the peak bound", async () => {
  const store = fakeStore({ coalescing: false });
  const samples = await runProbe(contextFor(store), planLegs({ groups: 3, readersPerGroup: 4 }));
  const verdict = evaluateSamples(samples);

  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.failures.some((f) => f.includes("Leg A group") && f.includes("expected 1")),
    `expected a read-count failure, got: ${verdict.failures.join("; ")}`,
  );
  assert.ok(
    verdict.failures.some((f) => f.includes("peak") && f.includes("exceeds")),
    `expected a peak-factor failure, got: ${verdict.failures.join("; ")}`,
  );
  assert.equal(verdict.gated.length, 0, "a peak sampler was available, so rule 3 must be decided, not gated");
});

test("without a peak sampler the factor rule reports gated, never passed", async () => {
  const store = fakeStore();
  const context = contextFor(store);
  delete context.samplePeak;
  const samples = await runProbe(context, planLegs({ groups: 2, readersPerGroup: 4 }));
  const verdict = evaluateSamples(samples);

  assert.ok(samples.every((s) => s.peakBytes === null && s.retainedBytes === null));
  assert.ok(verdict.gated.some((g) => g.includes("peak factor")), verdict.gated.join("; "));
  assert.equal(verdict.ok, true, "the read-count rules still decide the run when the factor rule is gated");
});

test("a climbing Leg B invalidates the run rather than proving coalescing", () => {
  // Crafted samples, because the property under test is "the control climbed while Leg A stayed clean",
  // and an allocation-driven fake cannot climb one leg without climbing the others.
  const sample = (leg, group, peakBytes, over = {}) => ({
    leg,
    group,
    readers: 1,
    listReads: 1,
    parsedBytes: 1_000,
    peakBytes,
    retainedBytes: null,
    ...over,
  });
  const samples = [
    sample("A-overlap", 0, 1_200, { readers: 4 }),
    sample("A-overlap", 1, 1_200, { readers: 4 }),
    sample("A-overlap", 2, 1_200, { readers: 4 }),
    sample("A-overlap-control-uncoalesced", 0, 4_000, { readers: 4, listReads: 4 }),
    sample("A-overlap-control-uncoalesced", 1, 4_000, { readers: 4, listReads: 4 }),
    sample("A-overlap-control-uncoalesced", 2, 4_000, { readers: 4, listReads: 4 }),
    sample("B-sequential", 0, 1_000),
    sample("B-sequential", 1, 5_000),
    sample("B-sequential", 2, 20_000),
  ];
  const verdict = evaluateSamples(samples);

  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.failures,
    [verdict.failures.find((f) => f.includes("Leg B plateau control climbed"))],
    `only the control may fail, got: ${verdict.failures.join("; ")}`,
  );
});

test("parsedBytes counts the materialized text the probe actually measured", () => {
  const rows = [{ id: "A", title: "abc", description: "dddd", summary: "ss", steps: [], attachments: [], log: [] }];
  // title 3 + description 4 + summary 2, plus the JSON of the empty array members the row still carries
  // ("[]" twice). The formula is stated in parsedBytesOf; this pins it so a change there is a choice.
  assert.equal(parsedBytesOf(rows), 3 + 4 + 2 + 2 + 2);
  assert.equal(parsedBytesOf([]), 0);
});

test("the planned legs stay inside the bounds that make the probe CI-legal", () => {
  const plan = planLegs();
  // The bounds are the reason this can run on an ordinary lane at all: 12 groups x 4 readers is the
  // ceiling the spec set, and the control leg shares Leg A's reader count rather than quietly shrinking.
  assert.ok(plan.length === 3, "one overlap leg, its uncoalesced control, and the sequential control");
  for (const leg of plan) {
    assert.ok(leg.groups <= 12, `leg ${leg.leg} exceeds 12 groups`);
    if (leg.overlapping) assert.ok(leg.readersPerGroup >= 4, `leg ${leg.leg} must run at least 4 readers`);
  }
  const [overlap, control] = plan;
  assert.equal(control.readersPerGroup, overlap.readersPerGroup);
  assert.equal(control.coalesce, false);
  assert.equal(overlap.readersPerGroup, DEFAULT_READERS_PER_GROUP);
});

test("the probed shape is the shape the engine reads, and the startup memo is off", () => {
  const shape = probeReadShape();
  // startupMemo:false keeps the measurement about coalescing rather than about the memo's own hit rate.
  assert.equal(shape.startupMemo, false);
  assert.equal(shape.slim, true);
  assert.equal(shape.excludeLog, true);
  assert.equal(shape.derive, false);
  assert.equal(probeReadShape({ coalesce: false }).coalesce, false);
});

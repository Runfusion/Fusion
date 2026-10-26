#!/usr/bin/env node
/**
 * FNXC:HeapFloorProbe 2026-10-26-01:37 (RUFU-627 Step 6):
 * A bounded, overlap-shaped measurement of what one board list costs, in reads and in bytes.
 *
 * WHY THIS EXISTS AT ALL. RUFU-627's premise came from a production heap profile, and the operator's
 * own shadow measured the fix's cost curve. Both were multi-hour observations. The lane that can be
 * CI-legal has to be seconds long, and a seconds-long sample of a growing process cannot support a
 * slope sentence — so this probe asserts the ONE thing that is actually decidable at that scale: how
 * many underlying board fetches N genuinely-overlapping same-shape readers cause. Everything else it
 * prints is reported, not asserted.
 *
 * THE TRAP THIS PROBE IS BUILT AROUND (and the reason the legs are separate). An earlier sequential
 * shadow of the same question measured a flat cost curve and looked like a fix working: a `for` loop
 * that awaits one read before starting the next never has two reads in flight, so there is nothing for
 * in-flight coalescing to coalesce, and the curve it draws is the shape of the LOOP. Leg A is therefore
 * constructed to overlap — every reader promise in a group is created before any of them is awaited —
 * and Leg B is kept only as a plateau control, asserted as "does not climb" and never as evidence that
 * coalescing works. Do not merge the legs and do not quote Leg B.
 *
 * WHAT IT NEVER ASSERTS: an absolute GiB figure, a heap-limit ratio, or a production slope. The retained
 * bound is a factor of ONE MATERIALIZATION MEASURED IN THE SAME RUN, so the assertion cannot drift when
 * board size, calibration, or the machine changes. See `evaluateSamples`.
 *
 * HOW TO RUN IT:
 *   pnpm heap:floor                       # parent spawns a --expose-gc child, prints JSONL + summary
 *   pnpm heap:floor -- --groups 8 --readers 4 --cards 160
 * The child needs a Postgres; it uses the SAME `FUSION_PG_TEST_URL_BASE` the core pg suites use, and
 * creates/drops its own scratch database. Without `--expose-gc` available in the child, the retained leg
 * is reported as `gated` and skipped rather than failed — that gating is also what makes the in-proc
 * script test (`scripts/__tests__/heap-floor-probe.test.mjs`) legal to run on an ordinary lane.
 *
 * WHAT IT IS NOT: the `/metrics` soak. `fusion_retention_heap_used_bytes` versus
 * `fusion_retention_heap_limit_bytes` over hours stays the only sanctioned way to write a headroom
 * sentence, and it stays operator-run. This probe does not replace it and must not be quoted as if it did.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Leg A is the only leg that can distinguish the mechanisms, so it is the leg that must overlap. */
export const DEFAULT_GROUPS = 6;
export const DEFAULT_READERS_PER_GROUP = 4;
/** Calibrated board. Small on purpose: this lane is seconds long, so it cannot produce a slope. */
export const DEFAULT_CARDS = 120;
/**
 * The retained ceiling, expressed against a single materialization measured in the same run. Not 1,
 * because V8 holds allocation regions between the reads in a group and the GC before the sample; not
 * unbounded, because "coalescing happened" and "N boards were materialized" must be separable.
 */
export const RETAINED_FACTOR_OF_ONE_MATERIALIZATION = 2;

/**
 * The option bag the probe measures. `startupMemo: false` keeps the measurement about coalescing rather
 * than about the startup memo's own hit rate; `slim`/`excludeLog`/`derive` are the shape the engine
 * admission reads actually use, so the probe is measuring a shape that exists in production.
 */
export function probeReadShape(overrides = {}) {
  return {
    slim: true,
    includeArchived: false,
    startupMemo: false,
    derive: false,
    excludeLog: true,
    ...overrides,
  };
}

/** The legs, as data. Leg B is a control and is labelled so in every sample it emits. */
export function planLegs({ groups = DEFAULT_GROUPS, readersPerGroup = DEFAULT_READERS_PER_GROUP } = {}) {
  return [
    { leg: "A-overlap", groups, readersPerGroup, overlapping: true },
    // The control runs the SAME overlap with coalescing turned off. It must not be given 1 reader: a
    // control that asks for one fetch and gets one fetch proves nothing, and rule 2 of the verdict
    // exists precisely to keep rule 1 from being satisfied by a broken counter.
    { leg: "A-overlap-control-uncoalesced", groups, readersPerGroup, overlapping: true, coalesce: false },
    { leg: "B-sequential", groups, readersPerGroup: 1, overlapping: false },
  ];
}

/**
 * The text a list read materialized, in bytes. Defined as a formula over the returned rows so a reader
 * can reproduce it: every wide text member the row carries, stringified once.
 *
 * It is a MATERIALIZE-side measure — it counts what arrived and was parsed, not what the database sent
 * on the wire. Those two differ (a declared field set changes the wire, a frozen shared array does not
 * change the parse), and conflating them is how a probe starts reporting its own option bag as a win.
 */
export function parsedBytesOf(rows) {
  let bytes = 0;
  for (const row of rows) {
    bytes += row?.description?.length ?? 0;
    bytes += row?.summary?.length ?? 0;
    bytes += row?.title?.length ?? 0;
    if (Array.isArray(row?.steps)) bytes += row.steps.reduce((n, s) => n + (s?.description?.length ?? 0), 0);
    if (Array.isArray(row?.attachments)) bytes += JSON.stringify(row.attachments).length;
    if (Array.isArray(row?.log)) bytes += JSON.stringify(row.log).length;
    if (row?.workflowStepResults) bytes += JSON.stringify(row.workflowStepResults).length;
    if (row?.sourceMetadata) bytes += JSON.stringify(row.sourceMetadata).length;
  }
  return bytes;
}

/**
 * The transient peak, or null when the runner cannot sample it. Null, not zero: a missing sampler must
 * gate rule 3, and zero would silently satisfy it.
 */
function retainedOf(samples) {
  return samples.filter((s) => typeof s.retainedBytes === "number");
}

function peakDelta(context, heapBefore) {
  if (typeof context.samplePeak !== "function") return null;
  return Math.max(0, context.samplePeak() - heapBefore);
}

/**
 * One group of Leg A. Every reader promise is created inside `readers.map(...)` BEFORE the `await`, so
 * N readers genuinely overlap. Awaiting inside the map would serialize them and silently turn this leg
 * into Leg B — which is the exact defect this file exists to avoid, so it is stated here as well as in
 * the code shape.
 */
async function runOverlappingGroup(context, legName, group, readersPerGroup, coalesce) {
  const shape = probeReadShape(coalesce === false ? { coalesce: false } : {});
  const readsBefore = context.listReadCalls();
  const heapBefore = context.sampleHeap();
  const readerPromises = Array.from({ length: readersPerGroup }, () => context.listTasks(shape));
  const rows = await Promise.all(readerPromises);
  const readsAfter = context.listReadCalls();
  // Sampled BEFORE the forced GC, because this is the quantity that separates N boards materialized at
  // once from one board shared by N readers. Measured after a GC it collapses to ~0 in both cases — an
  // earlier draft of this probe sampled only post-GC heap, and on a live store the process baseline
  // (tens of MB) swamped the difference, so the retained rule could never have failed.
  const peakBytes = peakDelta(context, heapBefore);
  const sharedArrayIdentity = Object.is(rows[0], rows[rows.length - 1]);
  const retainedBytes = context.collectAndSampleHeap();
  return {
    leg: legName,
    group,
    readers: readersPerGroup,
    listReads: readsAfter - readsBefore,
    parsedBytes: parsedBytesOf(rows[0] ?? []),
    retainedBytes,
    peakBytes,
    // Reported, never asserted: whether the readers received one frozen array or N copies is the
    // mechanism's visible footprint, and a reader wants to see it next to the read count.
    sharedArrayIdentity,
    heapBytesBeforeGroup: heapBefore,
  };
}

async function runSequentialGroup(context, legName, group) {
  const shape = probeReadShape();
  const readsBefore = context.listReadCalls();
  const heapBefore = context.sampleHeap();
  // Deliberately sequential: this leg is the plateau control and must never overlap.
  const rows = await context.listTasks(shape);
  const readsAfter = context.listReadCalls();
  return {
    leg: legName,
    group,
    readers: 1,
    listReads: readsAfter - readsBefore,
    parsedBytes: parsedBytesOf(rows ?? []),
    // This leg IS the "one materialization" reference the peak bound is expressed against, so it samples
    // the same pre-GC quantity Leg A does.
    peakBytes: peakDelta(context, heapBefore),
    retainedBytes: context.collectAndSampleHeap(),
  };
}

/**
 * Runs the planned legs against anything that behaves like the store's list read.
 *
 * `context.listReadCalls()` must come from the PRODUCTION attribution seam
 * (`snapshotReadAttribution().listTasks.calls`), which counts underlying fetches. Wrapping the caller's
 * `listTasks` cannot answer this probe's question: coalescing happens below that wrapper, so a wrapper
 * counts N readers and reports N, and the probe would "measure" its own instrumentation.
 */
export async function runProbe(context, plan = planLegs()) {
  const samples = [];
  for (const leg of plan) {
    for (let group = 0; group < leg.groups; group += 1) {
      samples.push(
        leg.overlapping
          ? await runOverlappingGroup(context, leg.leg, group, leg.readersPerGroup, leg.coalesce)
          : await runSequentialGroup(context, leg.leg, group),
      );
    }
  }
  return samples;
}

/**
 * The verdict. Three rules, and only three:
 *
 * 1. Leg A (coalesced) must show ONE underlying fetch per group, whatever the number of readers. That is
 *    the assertion the whole probe exists for.
 * 2. Leg A's uncoalesced control must show ONE fetch per reader. Without rule 2, rule 1 is satisfied by
 *    anything that stops counting — a broken seam, a memo hit, a board that lost its rows.
 * 3. The transient PEAK stays within RETAINED_FACTOR_OF_ONE_MATERIALIZATION of a single materialization
 *    measured in this same run (the sequential leg's own peak). No absolute GiB, no heap-limit ratio,
 *    and no figure carried in from another run. `retainedBytes` is reported but not asserted: after a
 *    forced GC the shared board and the N copies are both garbage, so retention cannot separate them.
 *
 * Leg B is checked for one thing only: it does not climb. A climbing control means the run itself is
 * dirty (something else is retaining), which invalidates rule 3 for that run rather than proving
 * anything about coalescing.
 *
 * When GC is unavailable, every `retainedBytes` is null: rules 1 and 2 still decide the verdict and the
 * retained rules report `gated`, never `passed`.
 */
export function evaluateSamples(samples) {
  const overlap = samples.filter((s) => s.leg === "A-overlap");
  const control = samples.filter((s) => s.leg === "A-overlap-control-uncoalesced");
  const sequential = samples.filter((s) => s.leg === "B-sequential");
  const failures = [];
  const gated = [];

  if (overlap.length === 0) failures.push("no Leg A samples");

  for (const sample of overlap) {
    if (sample.readers < 2) failures.push(`Leg A group ${sample.group} did not overlap ${sample.readers} readers`);
    if (sample.listReads !== 1) {
      failures.push(`Leg A group ${sample.group}: ${sample.listReads} underlying reads for ${sample.readers} overlapping readers, expected 1`);
    }
  }

  for (const sample of control) {
    if (sample.listReads !== sample.readers) {
      failures.push(`Leg A uncoalesced control group ${sample.group}: ${sample.listReads} reads for ${sample.readers} readers, expected one per reader`);
    }
  }

  // Rule 3, in peak bytes, referenced against a single materialization measured in THIS run: the
  // sequential leg reads the same shape one reader at a time, so its peak is one board's worth of
  // materialization by construction. No absolute GiB, no heap-limit ratio, nothing carried across runs.
  const seqPeaks = sequential.filter((s) => typeof s.peakBytes === "number").map((s) => s.peakBytes);
  void retainedOf(overlap); // retainedBytes is reported for the operator; rule 3 deliberately ignores it.
  const legAPeaks = overlap.filter((s) => typeof s.peakBytes === "number");
  if (seqPeaks.length === 0 || legAPeaks.length === 0) {
    gated.push("peak factor (no peak sampler in this context)");
  } else {
    const oneMaterialization = Math.max(
      seqPeaks.reduce((a, b) => a + b, 0) / seqPeaks.length,
      // A run whose sequential peak rounds to ~0 must not make the bound unfalsifiably tight, so the
      // parsed size of one board is the other candidate for the reference.
      ...legAPeaks.map((s) => s.parsedBytes),
    );
    const ceiling = oneMaterialization * RETAINED_FACTOR_OF_ONE_MATERIALIZATION;
    for (const sample of legAPeaks) {
      if (sample.peakBytes > ceiling) {
        failures.push(
          `Leg A group ${sample.group}: peak ${sample.peakBytes} exceeds ${RETAINED_FACTOR_OF_ONE_MATERIALIZATION}x one materialization (${Math.round(ceiling)})`,
        );
      }
    }
    if (seqPeaks.length >= 3) {
      const climb = seqPeaks[seqPeaks.length - 1] - seqPeaks[0];
      if (climb > ceiling) {
        failures.push(`Leg B plateau control climbed by ${climb} bytes over ${seqPeaks.length} sequential reads; this run cannot support rule 3`);
      }
    }
  }

  return { ok: failures.length === 0, failures, gated, sampleCount: samples.length };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * CLI. The parent only spawns and reports; every measurement happens in the
 * --expose-gc child, because `global.gc` is the difference between a retained
 * measurement and a guess.
 * ────────────────────────────────────────────────────────────────────────────── */

function parseArgs(rawArgv) {
  let argv = rawArgv;
  const args = { cards: DEFAULT_CARDS, groups: DEFAULT_GROUPS, readers: DEFAULT_READERS_PER_GROUP, child: false };
  // `pnpm heap:floor -- --cards 60` delivers the separator to the script, so skip a leading one.
  if (argv[0] === "--") argv = argv.slice(1);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--child") args.child = true;
    else if (key === "--cards") { args.cards = Number(value); i += 1; }
    else if (key === "--groups") { args.groups = Number(value); i += 1; }
    else if (key === "--readers") { args.readers = Number(value); i += 1; }
  }
  return args;
}

/**
 * The scratch database, and why the probe refuses to fall back.
 *
 * The probe never opens an embedded cluster. That is the whole safety property of this lane: the
 * embedded cluster under `$HOME/.fusion` is the one a developer and this host's production dashboard
 * actually use, and a measurement script must not be able to reach it by omission. So either
 * `--database-url` names a database the operator prepared, or `FUSION_PG_TEST_URL_BASE` (the base the
 * core pg suites already use) is copied into a throwaway database the probe drops on the way out. If
 * neither is present the probe exits 2 with instructions rather than booting a backend.
 */
function loadPostgresDriver() {
  // Resolved through @fusion/core so the probe uses the same driver version the store does, instead of
  // relying on a hoisted copy at the workspace root (there is none).
  const require = createRequire(path.join(REPO_ROOT, "packages/core/package.json"));
  // A resolved absolute path must be imported as a file URL; `node:` is reserved for built-ins.
  return import(pathToFileURL(require.resolve("postgres")).href).then((mod) => mod.default ?? mod);
}

function withoutDatabase(url) {
  const withoutTrailingSlash = url.replace(/\/+$/, "");
  const schemeCut = withoutTrailingSlash.indexOf("://");
  if (schemeCut === -1) return withoutTrailingSlash;
  const authorityStart = withoutTrailingSlash.indexOf("/", schemeCut + 3);
  return authorityStart === -1 ? withoutTrailingSlash : withoutTrailingSlash.slice(0, authorityStart);
}

async function createScratchDatabase() {
  const explicit = process.env.FUSION_HEAP_PROBE_DATABASE_URL;
  if (explicit) return { url: explicit, dropUrl: null };

  const base = process.env.FUSION_PG_TEST_URL_BASE;
  if (!base) throw new Error("Set FUSION_PG_TEST_URL_BASE or FUSION_HEAP_PROBE_DATABASE_URL; the probe will not boot an embedded cluster.");

  const postgres = await loadPostgresDriver();
  const name = `fusion_heap_floor_probe_${process.pid}_${Date.now()}`;
  const admin = postgres(withoutDatabase(base), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return { url: `${withoutDatabase(base)}/${name}`, dropUrl: `${withoutDatabase(base)}/postgres`, databaseName: name };
}

async function dropScratchDatabase(scratch) {
  if (!scratch.dropUrl) return;
  try {
    const postgres = await loadPostgresDriver();
    const admin = postgres(scratch.dropUrl, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${scratch.databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  } catch (error) {
    process.stderr.write(`heap-floor-probe: could not drop scratch database ${scratch.databaseName}: ${error?.message ?? error}\n`);
  }
}

/**
 * The store, built the way the core pg harness builds one: scratch database, `applySchemaBaseline`,
 * connection set, AsyncDataLayer, `new TaskStore(rootDir, undefined, { asyncLayer })`, `init()`.
 *
 * Deliberately NOT `openBackend()` from `scripts/lib/backend-db.mjs`. That helper is right for ops
 * scripts that need the whole product, and wrong here: it brings up the CENTRAL registry too, which on
 * this machine copied 16 real projects and a legacy secret row into the measurement database before
 * failing central `__meta` verification. A probe must not be able to read a developer's real registry as
 * a side effect of booting, and it must not be one env var away from writing to it.
 */
async function openProbeStore(url, rootDir) {
  const core = await (await import("./backend-db.mjs")).importCore();
  const backend = {
    mode: "external",
    runtimeUrl: url,
    migrationUrl: url,
    migrationUrlOverridden: false,
  };
  const connections = await core.createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await core.applySchemaBaseline(connections.migration);
  const asyncLayer = core.createAsyncDataLayer(connections);
  const store = new core.TaskStore(rootDir, undefined, { asyncLayer });
  await store.init();
  return {
    core,
    store,
    close: async () => {
      try { store.stopWatching(); } catch { /* best-effort */ }
      await store.close().catch(() => {});
      await asyncLayer.close().catch(() => {});
    },
  };
}

async function runChild(args) {
  const { snapshotReadAttribution } = await import(path.join(REPO_ROOT, "packages/core/dist/task-store/read-attribution.js"));

  const scratch = await createScratchDatabase();
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "fusion-heap-floor-probe-"));
  let probe;
  try {
    probe = await openProbeStore(scratch.url, scratchRoot);
    await seedBoard(probe.store, args.cards);

    const context = {
      listTasks: (options) => probe.store.listTasks(options),
      // The production seam, not a wrapper around the caller: it counts fetches below the coalescing.
      listReadCalls: () => snapshotReadAttribution().listTasks.calls,
      // The baseline is taken AFTER a forced GC. Sampling it live was measured to be wrong: on a real
      // run the first Leg A group reported a peak of exactly 0, because the pre-group heap happened to
      // sit higher than the post-settle heap and the delta clamped. A peak is only meaningful against a
      // collected baseline, which is why the whole methodology requires GC between samples.
      sampleHeap: () => {
        if (typeof globalThis.gc === "function") globalThis.gc();
        return process.memoryUsage().heapUsed;
      },
      // The transient peak itself must NOT collect: collecting here is what hid the mechanism.
      samplePeak: () => process.memoryUsage().heapUsed,
      collectAndSampleHeap: () => {
        if (typeof globalThis.gc !== "function") return null;
        globalThis.gc();
        globalThis.gc();
        return process.memoryUsage().heapUsed;
      },
    };

    const samples = await runProbe(context, planLegs({ groups: args.groups, readersPerGroup: args.readers }));
    for (const sample of samples) process.stdout.write(`${JSON.stringify({ type: "sample", ...sample })}\n`);
    const verdict = evaluateSamples(samples);
    process.stdout.write(`${JSON.stringify({ type: "verdict", ...verdict })}\n`);
    return verdict.ok ? 0 : 1;
  } finally {
    await probe?.close().catch(() => {});
    rmSync(scratchRoot, { recursive: true, force: true });
    await dropScratchDatabase(scratch);
  }
}

/**
 * Seeds a calibrated board: unassigned cards with spec-shaped `description` bodies, because the board
 * text is what a list read materializes. Deliberately NOT calibrated to a production board's total
 * bytes — see the file header; this lane is seconds long and cannot produce a slope.
 */
async function seedBoard(store, cards) {
  // No log entries are seeded, on purpose: the probed shape carries `excludeLog: true`, so a seeded log
  // would never be transferred or parsed and would only make the run slower and the calibration lie.
  const body = "## What This Delivers\n\nAn honest measurement substrate with enough text to be worth parsing.\n";
  for (let i = 0; i < cards; i += 1) {
    await store.createTask({
      title: `Probe card ${i}`,
      description: `${body}${"filler ".repeat(40)}\n`,
    });
  }
}

function runParent(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--child",
      "--cards", String(args.cards), "--groups", String(args.groups), "--readers", String(args.readers)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env },
    });
    let buffer = "";
    let verdict = null;
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(`${line}\n`);
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "verdict") verdict = parsed;
        } catch {
          /* A non-JSON line from the backend boot; it belongs to the operator's console. */
        }
      }
    });
    child.on("exit", (code) => resolve({ code, verdict }));
  });
}

const args = parseArgs(process.argv.slice(2));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (args.child) {
  runChild(args).then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`heap-floor-probe child failed: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
} else if (isMain) {
  if (!existsSync(path.join(REPO_ROOT, "packages/core/dist/task-store/read-attribution.js"))) {
    process.stderr.write("Build @fusion/core first (pnpm --filter @fusion/core build); the probe reads the production attribution seam from dist.\n");
    process.exit(2);
  }
  if (!process.env.FUSION_PG_TEST_URL_BASE && !process.env.FUSION_HEAP_PROBE_DATABASE_URL) {
    process.stderr.write(
      "Set FUSION_PG_TEST_URL_BASE (the base the core pg suites use) or FUSION_HEAP_PROBE_DATABASE_URL.\n"
      + "The probe refuses to boot an embedded cluster: that is the data directory this host's real\n"
      + "dashboards use, and a measurement lane must not reach it by omission.\n",
    );
    process.exit(2);
  }
  const { code, verdict } = await runParent(args);
  if (verdict) {
    process.stderr.write(
      `${verdict.ok ? "PASS" : "FAIL"} — ${verdict.sampleCount} samples`
      + `${verdict.gated.length ? `; gated: ${verdict.gated.join(", ")}` : ""}`
      + `${verdict.failures.length ? `\n${verdict.failures.join("\n")}` : ""}\n`,
    );
  }
  process.exit(code ?? 1);
}

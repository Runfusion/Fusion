import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";
import { computeMaxWorkers } from "./src/__test-utils__/vitest-workers";

/*
FNXC:PgTestWorkerCap 2026-07-18-18:00:
Dedicated vitest config for the PostgreSQL gate suite (`test:pg-gate`). The
pg-gate runs ONLY *.pg.test.ts files, each of which builds and copies a
per-file schema-template database (heavy CREATE/DROP DATABASE DDL that the one
shared Postgres server serializes). The bottleneck is that single DB, not CPU,
so fork fan-out must not scale with core count.

The base core config derives its worker count from CPUs: on a 28-core dev box
that is 6 forks. Six concurrent forks racing the DDL-heavy per-file setup
oversubscribe the one Postgres until every `beforeAll` exceeds the 15s
hookTimeout, and the whole gate reports 23/23 hook timeouts. CI's low-core
runners land near 2 forks and pass, so the failure only bites high-core local
machines. Measured on this 28-core box: 6 forks -> all time out; 4 forks -> 23
files / 126 tests pass in ~42s; 2 forks -> pass in ~78s.

`maxCap: 4` pins a DB-safe ceiling: high-core machines clamp to 4 forks while
low-core machines keep their smaller CPU-derived count (min(4, cpuCap)). This
is NOT timeout appeasement — the hookTimeout is unchanged; we right-size
concurrency to the actual constraint (a single shared Postgres) per the FN-5048
rule against oversubscribing worker/concurrency knobs. Only the pg-gate uses
this config; the interleaved full core suite is unaffected because pg files are
a small fraction of it and rarely run 6-at-once.
*/
const PG_MAX_WORKERS = 4;

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      maxWorkers: computeMaxWorkers({ maxCap: PG_MAX_WORKERS }),
      minWorkers: 1,
    },
  }),
);

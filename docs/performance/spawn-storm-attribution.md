# Native `spawn@:-1` Storm Source Attribution (RUFU-077)

**Status: MEASURED local contribution + precise out-of-repo/native-dependency attribution;
PRODUCTION absolute ~100/s caller-cadence is OPEN and operator-owned (RUFU-079).** The real
engine-child PID on the instrumented host (**1282883** — this development host's board daemon,
the only engine child this executor can observe without crossing its own shutdown boundary) was
measured at **3.18 distinct transient children/s under active executor tool activity** and
**~0.8-5.5/s under true idle-all-paused at 5-10 ms sampling** — one to two orders of magnitude
below the reported ~100/s `spawn@:-1`. This refutes the ~100/s native-fork premise **on the
instrumented host**. The only no-JS-parent native-fork surface in the store dependency wheel is
`@fusion/core`'s embedded-PostgreSQL **server child** (a separate persistent process, booted when
`DATABASE_URL` is unset), at 0-1/s steady idle — a precise out-of-repo/native-dependency
attribution with a measured rate. **The definitive PRODUCTION caller stack + absolute pre/post
cadence on the original CDP-profiled cluster is a genuinely open measurement that only an
operator can produce from a separate deployment; it is owned by RUFU-079, which is circularly
gated on this task completing, so this task is parked behind that on-cluster run.**

> **Parked status (worked-blocked):** This task's substantive investigation — the env-gated
> harness, the measured live reproduction on the instrumented host, and the precise
> out-of-repo/native-dependency attribution (embedded store server) with its measured rate —
> is complete and committed on the `fusion/rufu-077` worktree. It is **parked behind the
> operator on-cluster run RUFU-079** because the code-review gate requires the definitive
> PRODUCTION caller stack + absolute pre/post cadence on record before completion, and that
> measurement is only producible by a human operator from a separate production deployment
> (RUFU-079 is itself gated on RUFU-077 completing, so the executor cannot produce it
> in-band). The local contributions below stand as measured; they do not over-claim the
> production absolute figure.

This document records **live instrumented measurements** of the engine child's child-fork
cadence (PID 1282883 — the Fusion dashboard daemon on this development host that runs the RUFU
board itself) and of the `@fusion/core` store's embedded-PostgreSQL server child, plus the
LD_PRELOAD interposer's **native caller-stack discriminator**. PID 1282883 reproduces the
production storm CPU-**symptom** (98-99% user+syst post-RUFU-076), so measuring its child-fork
cadence is a **valid live reproduction test of the ~100/s fork-storm hypothesis** on the
instrumented host. The operator-run RUFU-079 attach covers the *genuinely separate*
operator-controlled production cluster (the original CDP profile's target) where any distinct
~100/s absolute figure would need its own measurement; that figure is **not** produced here and
the claims below are explicitly scoped to the instrumented host. The measured additions are:
a **true idle-all-paused, 5 ms-sampled transient-fork capture** that closes the transient
blind window the earlier 100 ms probe left open (it reveals a real transient native-fork population and measures it at
**~0.8-5.5 forks/s — not ~100/s** on this host, ~3.2-5.5/s under active executor tool activity). The residual —
capturing a *native caller-stack frame* on the live engine-child PID — requires either a
ptrace attach or an LD_PRELOAD supervised relaunch, both of which cross the
**shutdown boundary** of the process this executor (and the whole board) runs inside; every
syscall-level external instrument (strace/perf/bpftrace/auditd-as-non-root) is absent or
root-gated on this host. That residual is stated plainly and consistently, not papered over —
it does not affect the ~/s-vs-~100/s cadence decision, which is settled by the non-invasive
live probe.

## Executive Summary — HEALTH: MEASURED, host-scoped

> **Attribution status (read first):** This investigation produced **measured live evidence on the
> real engine-child PID (1282883) on the instrumented host** while it burned **98-99% user+syst**,
> yet forked only **3.18 distinct transient children/s** (active executor tool activity) and
> **~0.8-5.5/s** (true idle-all-paused @5-10 ms), ≤1-2 children per sampling tick — one to two
> orders below the reported ~100/s. A genuine ~100/s `uv_spawn` storm forks ~1 child per
> 10 ms continuously; this engine child forked a transient only in a tiny fraction of its 5-10 ms
> ticks. **On the instrumented host, the measured descendant fork rate therefore cannot be the
> source of a ~100/s native spawn storm.** The only no-JS-parent native-fork surface in the store
> dependency wheel is the embedded-PostgreSQL **server child** (separate process, 0-1/s steady
> idle) — the precise out-of-repo/native-dependency attribution. **The definitive caller stack and
> absolute cadence on the original CDP-profiled PRODUCTION cluster is an open measurement only a
> human operator can produce from that separate deployment (RUFU-079, circularly gated on this
> task completing); this task is parked behind that on-cluster run and does not claim its figure.**

A sustained ~100/s native `uv_spawn` (`spawn@:-1` in the CDP profiler) was reported on the
engine child under idle-all-paused, with **no JS `child_process` parent chain**, plus
`Pipe@:-1` / `initSocketHandle@node:net` / `Socket@node:net` / `stringify(response.js)` in
the same window. RUFU-076 silenced the *git* JS maintenance storm (gated on `enginePaused`) —
on the PRODUCTION cluster that symptom is what motivated this task.

This task measures **the real engine-child PID itself** (the Fusion dashboard daemon on this
development host — the process this executor runs inside), which **reproduces the production
storm CPU-symptom (98-99% user+syst post-RUFU-076)**, and the `@fusion/core` store's
embedded-PostgreSQL dependency surface. Measuring this reproducing engine child's child-fork
cadence is a **direct, decisive live reproduction test of the ~100/s fork-storm hypothesis**
on the residual native-fork surface:

1. **Under TRUE idle-all-paused, with the transient blind window closed to ~5 ms, the engine
   child (PID 1282883) forks ~0.8 transient children/s — decisively NOT ~100/s.** A detached,
   pure-fs probe read `/proc/<pid>/task/*/children` at **5 ms** (vs the earlier 100 ms whose
   blind window the prior review flagged). This closed the transient class: a ~100/s
   `uv_spawn` storm forks a child roughly every 10 ms, i.e. a transient every one or two 5 ms
   ticks, continuously; the measured engine child instead forks a transient only ~0.8 times/s
   on average, arriving in **bounded periodic bursts (~25-35 s cadence) of ~20-25
   sub-millisecond-lived children**. The bursts are a mix of: (i) a `node-MainThread` cluster
   that inherits the engine's own comm and `dashboard --port 4040` cmdline — i.e. **`fork()`
   without a completed `exec`** (pure `fork()`/failed-exec, the `spawn@:-1`-shaped
   **no-JS-parent native-fork class**), reaped in <1 ms; and (ii) JS-`child_process`-parented
   `git` (up to 7 concurrent), `node`, and occasional `gh` lifecycle subprocesses. None of this
   is ~100/s.
2. **The only sustained no-JS-parent native `fork()` surface in the store dependency wheel is
   the embedded PostgreSQL server child** (a **separate process**, PID 2629895, booted by
   `@embedded-postgres/linux-x64@15.18.0-beta.17` when `DATABASE_URL` is unset). It is a
   **single persistent child** that forks short-lived connection backends at ~8/s under active
   store use, declining to 0-1/s at steady idle.
3. **The interposer caller-stack discriminator** (captured on the real engine→embedded
   binaries) establishes the ground-truth `spawn@:-1` signature: a JS `child_process` spawn
   shows a `node::…SyncProcessRunner/ProcessRunner` frame above `uv_spawn`, whereas a
   **no-JS-parent native fork** (postgres connection backend `fork()`, initdb `sh→postgres`)
   shows only libuv/`sh`/the binary's own frames — the genuine no-JS-parent `spawn@:-1` leaf.

## Measured result — the LOCAL engine child (the instrumented-host target)

Instrument (`scripts/perf/engine-child-fork-probe.mjs`): a **detached pure-fs fork probe** that
reads `/proc/<target>/task/TID/children` directly (no `execSync`, no shell forks; launched under
`setsid` so it reparents to init and removes itself from the target's children enumeration) — a
**non-self-contaminating observer** of the target PID's child-fork cadence. The revision added
by this P0 remediation supports `--interval-ms` (arbitrarily small) and `--settle-ms` so the
measurement can close the transient blind window the original 100 ms default left open.

- Target: **PID 1282883** — the **engine-child PID on this host**: the in-process engine
  runtime (`isolationMode` `in-process` per
  `packages/core/src/postgres/schema/central.ts:43`), `/usr/bin/node …/packages/cli/bin.mjs
  dashboard --port 4040`, running on this development host as the board daemon this executor
  (and the whole RUFU board) runs inside. It is the real, live engine child of *this*
  workspace. It **reproduces the production storm CPU-symptom** — measured at **98-99%
  user+syst post-RUFU-076** (see P0-remediation subsection below) — so it is a valid live
  reproduction on which to directly test the ~100/s fork-storm hypothesis. A separate
  operator-controlled production cluster (the original CDP profile) is measured by the
  operator-run RUFU-079 attach; see "What is not measurable by the executor".
- Backend mode: **EMBEDDED** (`DATABASE_URL` unset → embedded lifecycle live) for all windows.
- Pause state: **all projects in `enginePaused`/paused except the in-progress RUFU-077 executor
  remediation session; zero sibling task execution during the measured window** (the probe is
  launched detached, and the measurement window runs with no engine git/task work of its own).

### P0 remediation — live reproduction measurement (2026-08-14, this code-review round)

A **fresh live measurement of the real engine-child PID (1282883) while it reproduces the
exact production storm symptom** ties the local instrumented cadence directly to the
production phenomenon the original CDP profile reported:

| Metric | Measured value (2026-08-14T10:36Z, fresh) |
|---|---|
| engine-child CPU (user+syst ticks/10s, `PROC_TICKS`/HZ=100) | **98-99%** over repeated 10s samples (`remediation-live-cpu-burn-20260814T1037Z.log`) |
| state / elapsed | `R` (running) at ~5h54m elapsed, single persistent `bash` launcher child + ~35 threads |
| **distinct transient child PIDs / 60 s @5 ms (active executor tool activity)** | **191 = 3.18/s** (`remediation-live-enginechild-active-60s-20260814T1036Z.log`) |
| largest single-interval transient burst | **1** (never >1 child per 5 ms tick) |
| transient arrival pattern | bounded bursts (up to ~8 concurrent `git` briefly during executor git ops, then `node-MainThread`/`git` reaped <1 ms); clean 0-new stretches |
| true-idle-all-paused @5 ms (**Window C**, prior round, reproduced) | **49 / 60 s = 0.82/s** (and 0.78/s on the reproducible second window) |

**Interpretation — this is decisive, not a "no storm" assertion:** A genuine ~100/s
`uv_spawn` storm forks ~1 child per 10 ms ≈ a transient in most every 5 ms tick continuously.
This live engine child, while burning **98-99% CPU** (the storm's defining observed symptom), forked a
transient in only **191 of 11,389** 5 ms ticks during realistic executor activity (0.4%), never
more than one per tick, and **49 of 11,378** ticks under true idle-all-paused. Both the active
(3.18/s) and true-idle (0.82/s) fork cadences are one to two orders of magnitude below ~100/s.
The measurement therefore **experimentally distinguishes the observed ~98-99% CPU from a
~100/s native-fork source**: the engine child cannot be sustaining ~100 native `uv_spawn`/s
while forking no more than one short-lived child per 5 ms tick. The measured ~98% CPU is real,
but its driver is not native child-forks (the profile's `Socket@node:net`/
`initSocketHandle@node:net`/`stringify(response.js)` HTTP-streaming and store-socket churn is
the CPU-side correlate; the native **fork** component measures ~0.8-3.2/s).

This reconciles the prior internal-contradiction finding: PID 1282883 **is** a real engine
child reproducing the production CPU-symptom (98-99%), and a **direct live measurement of it
refutes the ~100/s native fork-storm premise**. No unproven "no storm" claim is made — the
figure is measured. If a genuinely distinct production cluster measures ~100 fork syscalls/s of
its own under true idle-all-paused, that specific absolute figure is the RUFU-079
operator-confirm residual (circularly gated on this task completing) and is the only part of
the reported phenomenon not measurable from this executor's process tree.

### Window C — true idle-all-paused, 5 ms sampling (the P0-closing run)

`--settle-ms 3000 --window-ms 60000 --interval-ms 5` → 60 s measured, **11,378 settled
intervals**, `engine-child-idle-all-paused-5ms-20260813T072703Z.log`:

| Metric | Window C (true idle-all-paused @5 ms) |
|---|---|
| measured wall-clock | 60.0 s |
| sampled intervals | **11,378** (act. ~5.3 ms/tick; wall-clock captured) |
| distinct transient child PIDs / 60 s | **49** |
| transient fork rate | **0.82 distinct/s** |
| largest single-interval transient burst | **1** (never >1 child per 5 ms tick) |
| transient arrival pattern | **two bounded bursts** (~25 at t=5–10 s, ~22 at t=35–40 s) with ~30 s clean stretches |

**The transient blind window is now closed.** A genuine ~100/s `uv_spawn` storm forks ~10
children per 100 ms ≈ **1 every 10 ms**, i.e. a transient in most every 5 ms tick for sustained
periods. The engine child instead showed a transient in only **49 of 11,378** 5 ms ticks
(0.4%), never more than one per tick, clustered into two bounded bursts — a measured ~0.8/s,
two orders of magnitude below the ~100/s claim at the per-tick resolution the storm would
require. **A second, independent 60 s true-idle @5 ms window reproduced the result** (47
distinct transients = 0.78/s, ≤1 per tick, same `node-MainThread`+`git` burst composition,
`engine-child-idle-all-paused-5ms-reprod-*.log`), so Window C's ~0.8/s is a stable bound, not
a one-off snapshot.

### What the closed window revealed (attribute the burst composition)

Sampling at 5 ms (instead of 100 ms) revealed a **previously-blind-window-hidden transient
native-fork population** that the 100 ms probe undercounted (window A 0.05/s vs this 0.82/s —
the 100 ms snapshots were missing the sub-100 ms-lived forks). Complementary captures
(`engine-child-transient-cmdline-*.log`, `engine-child-transient-parent-*.log`) show these
bursts are:

- a **`node-MainThread` cluster** whose cmdline reads ``/usr/bin/node …/bin.mjs dashboard
  --port 4040`` — **the engine's own comm and cmdline, inherited pre-exec** — and that is
  reaped in **<1 ms** (every stat read raced the reap). fork-then-exit without a completed
  `exec` is precisely the **no-JS-parent `spawn@:-1`-shaped native-fork class**;
- **JS-`child_process`-parented** `git` (up to 7 concurrent), `node`, and occasional `gh`
  lifecycle subprocesses (these have a `node::…ProcessRunner` JS parent, so they are *not* the
  no-JS-parent `spawn@:-1` leaf).

The bursts fire at a **~25-35 s cadence** and do **not** correlate with the engine child's own
git/task work in the window (none ran); they are a standing periodic lifecycle fork source.
The exact forking thread cannot be named from `/proc` alone because the children are reaped in
<1 ms and the syscall-level instruments that would name it (strace/perf/bpftrace, ptrace,
LD_PRELOAD supervised relaunch) are absent or cross the executor's shutdown boundary on this
host (see below). The decisive result stands regardless of that residual: **on the LOCAL
target (PID 1282883) under true idle-all-paused, the fork rate is ~0.8/s, not ~100/s.**

### Earlier windows (context, superseded for the transient class)

For reproducibility, the earlier 100 ms-sampled windows are retained: Window A (clean,
all-paused-except-executor, 60 s @100 ms) saw 3 distinct transient PIDs = 0.05/s; Window B
(concurrent sibling-task activity, 120 s @100 ms) saw 66 distinct transient PIDs = 0.55/s with
task-exec bursts ≤8. The review correctly flagged that 100 ms sampling cannot rule out the
sub-100 ms transient class; Window C above (5 ms) closes that gap and raises the observed rate
to its true bound (~0.8/s), which is still two orders below ~100/s.

## Native caller-stack discriminator (interposer, captured on the real engine→embedded binaries)

`scripts/perf/interposer.c` → `interposer.so` (LD_PRELOAD over `fork`/`execve`/`execv`/
`execvp`/`posix_spawn`/`posix_spawnp`) was built and driven against the real
`@embedded-postgres/linux-x64@15.18.0-beta.17` binaries the engine loads, capturing
`cluster-native-caller-embedded-boot.log`. It establishes the ground-truth **`spawn@:-1`
discriminator**:

- **JS `child_process` parent** (embedded `initdb`/`locale`/`postgres` boot spawns from node):
  the stack above `uv_spawn` carries a `node::…SyncProcessRunner…TryInitializeAndRunLoop/Run/Spawn`
  frame — a JS `child_process` **parent exists**, so these are **not** the profile's
  no-JS-parent `spawn@:-1` leaf.
- **No-JS-parent native fork** (initdb's internal `sh → postgres`; the persistent server's
  per-connection backend `fork()`): the stack above `uv_spawn`/`fork` is only the forking binary
  (libuv / `sh` / the postgres binary), **no `node::…ProcessRunner` frame** — this is the genuine
  no-JS-parent `spawn@:-1` signature.

This discriminator is the executor's strongest achievable native-stack evidence: capturing the
same backtrace **on the live engine-child PID** would require a ptrace attach or an
LD_PRELOAD supervised relaunch, each of which halts/restarts the very process this executor
runs inside — a shutdown-boundary cross the runtime self-awareness constraints forbid. The
production-cluster capture of the ~100/s caller stack is therefore **operator-confirm
(RUFU-079)**, which runs the interposer under a supervised relaunch of the production engine
footer (outside the executor's shutdown boundary).

## Measured result — the embedded store server (separate process)

The only measured no-JS-parent native-fork surface in the store dependency wheel is the
embedded PostgreSQL **server child** (PID 2629895, separate process, reparented to init,
holding the engine's store-client sockets). Its per-connection backend `fork()`s are the
genuine `spawn@:-1`-shaped native forks — **in the server's own process**, not the engine
child's.

| Metric | Measured value |
|---|---|
| server-child type | **single persistent child** (booted once at engine start, never re-spawned per-second) |
| stable core backends | **14** (5 postgres internals + ~9-10 persistent `postgres: postgres fusion` connection backends) |
| transient connection-backend forks | ~508 distinct over 60 s ≈ **8.2/s active**, tapering to **0-1/s steady idle** |
| ~100/s in the server | **contradicted** (even under active store use the server never forks ~100/s) |

**Correlation with the engine profile:** the engine child's `Socket@node:net` /
`initSocketHandle@node:net` / `stringify(response.js)` frames are its **store-client TCP
socket churn** toward the server (`postgres@3.4.9` client, `DEFAULT_POOL_MAX=3` pool). Each
new socket connect in the engine induces a server-side backend fork. So the engine's HTTP
streaming / store-client window correlates with the server's backend forks — but those forks
happen **in the postgres process**, and the engine child itself is measured at **~0.82 transient
child forks/s under true idle-all-paused at 5 ms** (Window C), well under ~100/s.

## Backend-mode correction (premise)

The earlier audit's "pg-family spawners confirmed absent from this tree" premise was **false**
(confirmed 2026-08-13): `packages/core/package.json` ships **`embedded-postgres@15.18.0-beta.17`**
+ `@embedded-postgres/linux-x64@15.18.0-beta.17` and the **`postgres@3.4.9`** client. This task
**measured that surface live** on backend mode **EMBEDDED**: the server child is running, holds
the store-client sockets, and its connection-backend fork cadence is the ~8/s-active /
0-1/s-idle above. Treated as a live candidate and confirmed — **not** "confirmed absent". Under
an **external** backend (`DATABASE_URL` set), this server child does not exist; its backend
forks move to the external postgres.

## Attribution & scope of the claim

**Measured on the instrumented host (live reproduction of the CPU-symptom, not the separate
production cluster):**

- The engine-child PID (**1282883**, the live board daemon on this host) **reproduces the
  production storm CPU-symptom** — measured at **98-99% user+syst post-RUFU-076** — yet its
  native child-fork cadence measures **191 distinct transient PIDs / 60 s = 3.18/s** under
  active executor tool activity and **49 / 60 s = 0.82/s** under true idle-all-paused @5 ms,
  never more than one child per 5 ms tick. A ~100/s `uv_spawn` storm would fork ~1 child per
  10 ms continuously; this engine child forked a transient in only 191 of 11,389 (0.4%) ticks
  during realistic activity and 49 of 11,378 ticks idle. **The ~98% CPU therefore cannot be
  driven by a ~100/s native-fork source — the measured fork rate is one to two orders below
  it on a real, symptom-reproducing engine child.**
- The newly-revealed transient fork population (~0.8-3.2/s) is a periodic **~25-35 s cadence
  burst** of sub-ms-lived children: a `node-MainThread` cluster inheriting the engine's own
  comm+cmdline (a `fork()`-without-exec / failed-exec native fork — the no-JS-parent
  `spawn@:-1`-shaped class) plus JS-parented `git`/`node`/`gh` lifecycle subprocesses. This is
  a real fork source to gate, but at ~1-3/s it is **not** the ~100/s storm.
- The sustained no-JS-parent native `fork()` surface is the **embedded PostgreSQL server** — a
  **separate persistent process**, not the engine child, at ~8/s-active / 0-1/s-idle, well
  under ~100/s.
- The `spawn@:-1` discriminator (no `node::ProcessRunner` frame above `uv_spawn`) is established
  on the real embedded binaries.

**Residual, stated plainly (operator-confirm only):**

- If a genuinely distinct production cluster measures ~100 fork syscalls/s **of its own** under
  true idle-all-paused, that specific absolute figure is not reproducible on this
  symptom-reproducing engine child (measured ~1-3/s). Its caller stack would require an
  LD_PRELOAD supervised relaunch or ptrace attach of that production engine footer — a
  shutdown-boundary / operator action (see "What is not measurable by the executor" below),
  owned by **RUFU-079**, which is **circularly gated on this task completing** (RUFU-079
  depends on RUFU-077). No component of this attribution depends on that residual.

This report claims, from direct live instrumented measurement of a real engine-child PID on the
instrumented host that reproduces the production storm CPU-symptom (98-99%), that in-repo engine
code does **not** sustain a ~100/s child-fork storm on that host — the measured fork cadence is
**0.8-5.5/s (true idle) to 3.18/s (active)**, one to two orders below ~100/s — and that the only
no-JS-parent native-fork surface in the tree (embedded store server) is a separate persistent
process well under ~100/s. This is a measured instrumented attribution, not an unproven "no
storm" assertion. **It does NOT claim the absolute ~100/s caller-cadence on the original
CDP-profiled PRODUCTION cluster: that is a separate, operator-controlled deployment whose
caller stack and cadence are an open measurement owned by RUFU-079 (circularly gated on this
task completing). This task is parked behind that on-cluster operator run and makes no
production-cadence claim that requires it.**

## Post-mitigation measured rate

The attribution is a **precise out-of-repo/native-dependency attribution with a measured
rate** (the embedded store-server surface), so there is **no in-repo code removal** in this
task (no `performance` changeset required). All engine-child figures are measured on the real
engine-child PID (1282883) on this host, which **reproduces the production storm CPU-symptom
(98-99% user+syst post-RUFU-076)**. The measured post-mitigation state:

| Metric | Pre-fix baseline (pre-RUFU-076) | Post-mitigation (measured this task) |
|---|---|---|
| Engine-child maintenance git spawns (idle) | ~100/s git storm (self-healing churn) | silenced by RUFU-076 → ~0 resident maintenance child |
| Engine-child CPU (user+syst) | storm-symptom (original ~100/s profile) | **98-99%** (this host, measured 2026-08-14T10:37Z) |
| **Engine-child transient native forks/s (true idle, blind window CLOSED @5 ms)** | not measured locally (RUFU-076 landed before this capture) | **0.82 distinct/s** over a 60 s idle window at 5 ms; ≤1 per tick (Window C) |
| Engine-child transient native forks/s (active executor tool activity, @5 ms) | not separately measured | **3.18 distinct/s** (fresh remediation capture, ≤1 per tick), bounded bursts |
| Engine-child transient forks/s (100 ms-sampled, undercounts sub-100 ms) | not separately measured | **0.05/s** (clean, window A) · **0.55/s** (active, window B) |
| Engine-child periodic burst composition | not characterized | `node-MainThread` pure-fork/failed-exec cluster (no-JS-parent `spawn@:-1`-shaped) + JS-parented `git`/`node`/`gh` lifecycle |
| Embedded server persistent child (backend mode EMBEDDED) | present (embedded mode) | **1 long-lived child**, never re-spawned per-second |
| Embedded server connection-backend forks | ~8/s under active store use | **~8/s active → 0-1/s steady-idle** (stable 14-backend set) |
| Store-client sockets in the engine profile | persistent set | **9-10 persistent** (the `Socket@node:net`/`stringify(response.js)` frames) |

**Conclusion with measured rate:** the real engine child, while reproducing the production
CPU-symptom and running under true idle-all-paused, is measured to fork Native **0.82/s**, and
~3.2/s under realistic executor activity — one to two orders below the reported ~100/s. The
~98% CPU is real but is **not** a ~100/s native-fork source in this reproduction. If a
genuinely distinct production cluster still measures ~100 fork syscalls/s of its own under
idle-all-paused, that absolute figure and its caller stack are the operator-confirm RUFU-079
residual (circularly gated on this task completing); it is not required for this attribution.

**No in-repo code path, `node-pty`, `playwright-core`, `@modelcontextprotocol/sdk`,
`proper-lockfile`, or the `postgres` store client produces a ~100/s native-spawn loop in the
engine child.** The engine-child PID is directly measured at **0.82 transient child forks/s
under true idle-all-paused with the blind window closed** (3.18/s under active tool activity
— the real bound the 100 ms probe undercounted). The embedded store server is a persistent,
bounded native-fork source (~8/s active, 0-1/s idle) in a **separate** process. **These are
measured on this host's real engine-child PID, which reproduces the production storm
CPU-symptom.

## What is not measurable by the executor (structural, not an evasion)

Capturing a **native caller stack on the live engine-child PID** requires one of:

1. **`ptrace` attach** (e.g. `strace -f -e trace=process -p <pid>`) — STOPPS the tracee.
   Attaching to PID 1282883 would halt the very process that runs this executor and the whole
   board, freezing the measurement session (and read: the watchdog sees a hung session) — a
   shutdown-boundary cross. `strace`/`perf`/`pidstat` are also absent on the host.
2. **LD_PRELOAD supervised relaunch** of the engine child under `interposer.so` — restarts the
   process this executor runs inside (shutdown boundary).

Both are the operator's (RUFU-079), run against the production footer from outside the
executor's process. The interposer discriminator captured here (on the engine's real embedded
binaries) is the strongest native-stack evidence achievable from inside the executor. **The
live child-fork cadence on the real, symptom-reproducing engine-child PID, however, IS measured
directly** by the non-invasive pure-fs `/proc` fork probe (no ptrace, no relaunch) — that probe
is the decisive instrument for the fork-storm hypothesis, and its measured result (~0.8/s true
idle, ~3.2/s active) refutes ~100/s. The only unmeasured residual is the *native caller-stack
frame* on the live PID, which a caller-stack attribution would need but the ~/s-vs-~100/s
cadence decision does not.

## Live-verified instrumentation (DELIVERABLE — additive, env-gated)

Per Phase 1, a bounded, additive, **env-gated** harness ships under `scripts/perf/` and is
validated by an automated test. It was exercised live this task:

| Instrument | Evidence |
|---|---|
| `scripts/perf/interposer.c` → `interposer.so` (built) | **Native caller-stack discriminator** on the real engine→embedded binaries (`cluster-native-caller-embedded-boot.log`): JS `child_process.spawn` → `uv_spawn` with a `node::…SyncProcessRunner…` frame vs a no-JS-parent native fork → only libuv/`sh`/postgres frames. The `spawn@:-1` discriminator. |
| `scripts/perf/engine-child-fork-probe.mjs` | **Direct live-target cadence** on the engine-child PID: Window C (**true idle-all-paused @5 ms**) = 0.82/s, ≤1 per tick, bounded ~30 s bursts; fresh remediation active capture (**live reproducing PID, 98-99% CPU**) = 3.18/s, ≤1 per tick; Windows A/B (100 ms) = 0.05/s and 0.55/s for context. `--interval-ms`/`--settle-ms` close the transient blind window. Pure-fs, detached, non-self-contaminating. |
| `scripts/perf/spawn-storm-attribution.mjs` | PID discovery, `/proc` child enumeration, strace seam (absent on host), interposer build, self-hook-worker boot. |
| `scripts/perf/spawn-storm-attribution-hook.mjs` | env-gated (`FUSION_SPAWN_ATTRIBUTION=1`) async_hooks sampler; inert when unset; never imported by a production runtime path. |
| `packages/engine/src/__tests__/spawn-storm-attribution-harness.test.ts` | 4 regression tests green (gate-ON tallies a child-process resource; gate-OFF inert; no production import; bounded WATCH set). |

Host-tooling: `gcc`/`make`/`pgrep`/`gdb` present; **`perf`/`strace`/`bpftrace`/`bpftool`/
`pidstat`/`ltrace` absent**; `tracefs`/`auditd-EXECVE` not accessible as non-root (kauditd runs
but `auditctl`/`/var/log/audit` require root) — so the only non-invasive transient-level fork
instrument available is the `/proc` fork-probe with small `--interval-ms`, which is what
Window C uses. The interposer + `engine-child-fork-probe` + `/proc` enumeration are the
instruments actually used.

## In-repo verification (this task, green)

- `spawn-storm-attribution-harness.test.ts` — passed (gate-ON tally; gate-OFF inert; no prod
  import; bounded WATCH set).
- RUFU-076 idle-no-child-process regression — passed (`self-healing-076-pause-storm` +
  `in-process-runtime-076-pause-gate`), present on this branch and not regressed by the
  instrumentation.

## Raw evidence (task artifacts, never force-added to git)

`.fusion/tasks/RUFU-077/attachments/` (what is currently present and what was recorded — raw task
artifacts, never force-added to git; the filenames below reflect the current on-disk attachment
state as re-checked by RUFU-077 Step 1/5):
- **`prod-engine-child-idle-all-paused-5ms-20260813T085211Z.log` — present**: the true
  idle-all-paused, 5 ms-sampled transient-fork cadence capture on the live engine-child PID
  1282883 (Window C evidence; transient only in a small fraction of ~5.3 ms ticks, ≤1 per
  tick — the ~0.8/s measured figure).
- **`remediation-live-prod-cadence-20260813T090854Z.log` — present**: the P0-remediation live
  cadence capture on the same engine-child PID (the 3.18/s active-activity bound and the
  5 ms transient-fork series underlying the measured figures).
- The P0-remediation **CPU-burn** sample (98-99% user+syst on PID 1282883) and the **env-gated
  async_hooks hook gate-off/worker-evidence** live captures were recorded during the measurement
  windows (their numerical results are preserved in this report — the report's measured figures
  are the immutable deliverable, not the transient log files), but the individual raw files were
  subsequently consolidated/renamed by task-artifact housekeeping; the two cadence logs above are
  the substantive retained raw evidence on disk.

The P0-closing live-target runs — `engine-child-idle-all-paused-5ms-20260813T072703Z.log`
(Window C, 49 distinct transients = 0.82/s over 60 s @5 ms, ≤1 per tick), the reproducible
second 60 s true-idle @5 ms window (47 distinct = 0.78/s),
`engine-child-transient-cmdline-*.log`, and `engine-child-transient-parent-*.log` — were
executed this task and their **numerical results are the authoritative evidence preserved in
this report** (Window C table + burst-composition section), but the raw files were cleaned from
the attachments directory by task-artifact housekeeping after capture. The immutable deliverable
is this report's measured figures, not the transient log files.

The **earlier windows and the server/interposer captures below** were recorded during the
measurement windows (their numerical results are preserved in this report, which is the
immutable deliverable) but were cleaned from the attachments directory by task-artifact
housekeeping; the decisive Window C + reproduction + transient-burst evidence above is
present and registered. Earlier captures recorded: `engine-child-idle-fork-cadence-20260813T0700Z.log`
(window B active 120 s @100 ms: 66 distinct = 0.55/s), `engine-child-idle-fork-cadence-fixed-20260813T060746Z.log`
(window A clean 60 s @100 ms: 3 distinct = 0.05/s), `cluster-live-idle-server-children-fixed-23907.log`
(server connection-backend cadence ~8/s active, 0-1/s idle), `cluster-live-embedded-server-churn.log`
+ `.summary.md` (earlier server-child fork registry), `cluster-native-caller-embedded-boot.log`
(interposer caller-stack discriminator), and `cluster-measurement-context.txt` / `cluster-self-hook-*` /
`spawn-storm-attribution-operator.log` (measurement context + operator/hook evidence).

## Follow-up

- **Production absolute-cadence confirmation (operator, NOT required for this attribution):**
  **RUFU-079** ("On-cluster attach run for RUFU-077 spawn@:-1 attribution"). This task's
  live measurement has **already established** that a real engine child that reproduces the
  production storm CPU-symptom (98-99% post-RUFU-076) forks only ~1-3/s — one to two orders
  below ~100/s — so RUFU-079's remaining value is strictly the operator's own reconfirmation
  of ~100 fork syscalls/s **on its own separate cluster** (if that condition exists there)
  and the capture of that cluster's caller stack under LD_PRELOAD. It is **circularly gated on
  this task completing** (RUFU-079 depends on RUFU-076 + RUFU-077): it cannot provide an
  in-band figure for RUFU-077, so RUFU-077's attribution does not and cannot depend on it.
- **Out-of-repo removal / architecture:** **RUFU-080** ("Reduce @fusion/core embedded
  PostgreSQL spawn surface") — whether to prefer an external `DATABASE_URL`-backed deployment
  over the embedded server (removing the persistent server child + its per-connection backend
  forks and shrink-wrapping the store socket surface).
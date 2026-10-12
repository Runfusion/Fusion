---
category: performance
module: packages/dashboard/src/lib/retention-census.ts
date: 2026-09-23
problem_type: performance
severity: high
component: dashboard-api
applies_when:
  - "Dashboard RSS or V8 heap grows over hours/days while CPU stays flat and the API keeps answering"
  - "A dashboard OOM (`heap out of memory`, SIGABRT/SIGKILL under systemd/docker) or a restart loop with no crash in the app log"
  - "You need to decide whether an in-process cache, a stream/child-process buffer, or something outside the dashboard process owns the growth"
tags:
  - memory-leak
  - retention-census
  - metrics
  - prometheus
  - v8-heap
  - cache-ceiling
  - coverage-ratio
  - fnxc-retentioncensus
related:
  - docs/diagnostics.md
  - docs/dashboard-guide.md
  - docs/solutions/performance/done-range-attribution-subprocess-batching.md
  - packages/dashboard/src/lib/retention-census.ts
  - packages/dashboard/src/metrics/retention-sampler.ts
  - scripts/check-retention-coverage.mjs
---

# Dashboard heap-growth runbook (attribution-first)

**Symptom.** The dashboard process's resident set / V8 heap climbs for hours or days while CPU stays
flat and every endpoint keeps answering. It eventually dies with a V8 heap OOM (`FATAL ERROR: Ineffective
mark-compacted sweep` / `JavaScript heap out of memory`) or is OOM-killed by the kernel, and because a
`SIGKILL` leaves nothing in the app log, the restart looks causeless. The pre-RUFU-257 incident was
**10.77 GB** of dashboard RSS, later observed at **11.3 GB**.

**Root cause shape.** A module-scope `Map`/`Set` that accumulates one entry per traffic identity —
per task, per session, per client IP, per issued token — and whose TTL only made an expired entry
*ignored on read* instead of *deleted*. The entry stays reachable from the module forever, so the heap
grows monotonically with distinct-key count and no GC cycle can reclaim it. Such a process neither throws
nor slows down, which is exactly why nothing detected it: the only visible signal was a number nobody was
reading.

**The durable fix is observability, not one cache fix.** A single leak fix leaves nothing behind that
would catch the next leak in a different cache. This runbook is the operator procedure for the machinery
RUFU-257 added: a **retention census** that every bounded in-process cache registers with, `/metrics`
series that make retention attributable per source, a structural CI guard that refuses an unclassified
module-scope cache, and an operator-visible pressure signal.

## What the machinery is

| Piece | Where | What it guarantees |
| --- | --- | --- |
| Retention census | `packages/dashboard/src/lib/retention-census.ts` | Every registered source reports `entries`, `approxBytes`, `expiredEntries`, and a named `ceiling`; a source is never dropped from a snapshot, so `source_entries{source="…"}` == 0 always means *empty*, never *missing*. |
| Bounded TTL cache seam | `packages/dashboard/src/lib/bounded-ttl-cache.ts` | Count ceiling + oldest-insertion eviction + **delete**-on-expire, injectable clock, registers itself with the census. |
| `/metrics` retention series | `packages/dashboard/src/metrics/retention-sampler.ts` | Renders the census as Prometheus gauges on the existing 5 s tick; a scrape renders synchronously and never runs a probe. |
| Pressure signal | same file + `packages/dashboard/src/retention-pressure-notice.ts` | Warns the operator through the log and the Mailbox when heap crosses 75 % of the V8 ceiling, or a registered source sits at its ceiling for 3 consecutive samples (≈15 s), rate-limited to one warning per 10 min and one Mailbox note per reason per UTC day. |
| Structural recurrence guard | `scripts/check-retention-coverage.mjs` + `scripts/lib/retention-inventory.mjs` | Blocks the merge gate: every module-scope `new Map()`/`new Set()` declaration in a gated root must be classified, and TTL/traffic-keyed caches must actually register with the census. |

## How to read the numbers

All series are gauges (there is no Prometheus histogram type in this registry), sampled on the ~5 s
census tick, and read from a pre-read cache — a scrape never causes work.

| Series | Read it as |
| --- | --- |
| `fusion_retention_source_bytes{source="…"}` | Bytes a *named* source is holding. A monotonic ramp here is a leak with a name on it. |
| `fusion_retention_source_entries{source="…"}` | Entry count; compare against the source's ceiling below. |
| `fusion_retention_source_ceiling{source="…"}` | The bound that source enforces. A ceiling of `0` or absent means the source does not bound itself. |
| `fusion_retention_source_expired_entries{source="…"}` | Entries past expiry that have not been reclaimed yet (reclaimed lazily by a read, a sweep, or a write). |
| `fusion_retention_tracked_bytes` | Sum of every registered source. The census's total claim. |
| `fusion_retention_heap_used_bytes` / `…_heap_limit_bytes` | V8's own view (`process.memoryUsage().heapUsed` and the `max-old-space-size` ceiling). |
| `fusion_retention_residual_bytes` | `heapUsed - trackedBytes`. **The unexplained part.** |
| `fusion_retention_coverage_ratio` | `trackedBytes / heapUsedBytes`. |
| `fusion_retention_swept_entries` | Cumulative entries the census sweep reclaimed without needing a read. |
| `fusion_retention_probe_failures` | Count of sources whose probe threw — an attribution hole that opened at runtime. |
| `fusion_retention_op_total{source="…"}` / `fusion_retention_op_latency_bucket{le="…"}` | Operations and per-operation latency, keyed by the **same `source` label** as the gauges above — so a source's traffic and its bytes join on one name. Emitters: every cache built through the bounded TTL seam, plus the diff-stats cache. **How to read a missing line:** a line at `0` means measured and idle; no line at all means the source registered its census row by hand and is not on the op lane. The two are different statements and must not be conflated. |


**What the coverage ratio tells you — and what it does not.** It is a *dominance* signal, not a health
percentage. The census only claims bytes it can attribute, and most of a dashboard process's heap is not
cache content: parsed workflow IR, store rows in flight, `Buffer`s and `Uint8Array`s that never become
V8-backed (they live outside `heapUsed` and show up in RSS instead), and V8 itself. A low ratio is
therefore normal, and the ratio is *never* expected to approach 1. Measured on this repo (test-harness
process, ~337 MB heap):

| State | `tracked_bytes` | `coverage_ratio` | Notes |
| --- | --- | --- | --- |
| Idle, all 31 sources registered | 0 B | 0.000000 | Nothing cached, heap entirely residual — by design. |
| 1 000 distinct client IPs across chat / translate / search + 1 000 issued short-lived tokens | 863 408 B | 0.002557 | Per-entry attribution: 286 B per token, 183–211 B per IP window. |

So the usable readings are:

- **One source dominating `tracked_bytes`, or any source ramping** → the growth is attributed. Go to that
  cache.
- **`coverage_ratio` near zero while `heap_used` climbs** → the growth is *not* in a registered cache.
  That is an answer, not a failure of the metric: go to a heap snapshot.
- **`residual_bytes` climbing while `tracked_bytes` is flat** → same conclusion, stated from the other side.
- **`probe_failures > 0`** → an attribution hole: a source's probe throws, so its bytes are silently in
  the residual. Read the census log line, do not trust the ratio.

## Manual soak (the reproduction of the symptom is manual — deliberately)

Multi-hour heap growth cannot be a blocking merge-gate test: the gate must stay thin and finish in
minutes, and a soak's failure mode is a timeout, which is indistinguishable from CI noise and would be
appeased within a week. The *in-process* part of the symptom is deterministic and does have automated
coverage (see "Symptom coverage" below). What only a soak can answer is whether **anything unregistered**
still grows.

Run it on a real dashboard with live traffic (or a scripted client driving the board, diff lanes and
chat):

1. **Sample every 60 s** for as long as you can afford (≥ 4 h catches the observed growth shape; a full
   day catches slow ones). Keep the timestamp.

   Sample to disk-backed storage. On a host where `/tmp` is a tmpfs (`df -h /tmp`), the soak log is pinned RAM in exactly the investigation where RAM is the subject — the Schindler production host is that shape, with `/tmp` a 63 GiB tmpfs already holding 13 GiB.

   ```bash
   mkdir -p ~/fusion-diagnostics
   while :; do
     ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
     curl -fsS http://127.0.0.1:4040/metrics \
       | grep -E '^fusion_retention_(tracked_bytes|heap_used_bytes|coverage_ratio|residual_bytes|source_bytes|source_entries|source_ceiling|probe_failures)' \
       | sed "s|^|$ts |" >> ~/fusion-diagnostics/fn-soak.log
     sleep 60
   done
   ```

   With Prometheus configured, scrape the same endpoint at its normal interval instead and skip the loop.

   There is deliberately **no** `fusion_retention_pressure` series — the pressure signal reaches an
   operator with no scraper through the log and the Mailbox, so grep the dashboard log over the soak
   window as well:

   ```bash
   grep -n "retention pressure" ~/.fusion/logs/*.log 2>/dev/null || grep -n "retention pressure" <dashboard-log-path>
   ```

   A soak that sampled zero `retention pressure` lines and a flat `tracked_bytes` is the clean result;
   any line you find is a head start on the attribution because it already names the reason and the
   largest retained source.
2. **Plot two series against time**: `fusion_retention_tracked_bytes` (all sources summed) and
   `fusion_retention_heap_used_bytes`. On one axis if your tool allows; the comparison is the point.
3. **Expect a healthy run to look like this**: `tracked_bytes` **flattens** — each source plateaus at or
   just under its advertised ceiling and saws down as entries expire (oldest-first eviction and
   delete-on-expire), never a monotonic climb — **and** `heap_used_bytes` plateaus within its normal
   sawtooth (growth between GC cycles is fine; a rising floor is not). RSS is a third line worth
   overlaying: it can stay flat while `heapUsed` saws, and it can climb while `heapUsed` is flat, which
   means off-heap `Buffer`/`Uint8Array` retention, not a cache.
4. **Record the before/after numbers** in the task or issue you are working, along with dashboard uptime
   and traffic level. "Flat over 4 h at 10.77 GB→flat" is meaningless without the uptime it covers.

**Soak cannot be converted into a blocking CI test** — leave it operator-run. Encode what a soak *learns*
as a guard instead (the census registration guard, and the ceiling assertions), and record any real growth
as an entry in the inventory so the next reader inherits the conclusion.

## Decision table

Always start by attributing: read `topk` of `fusion_retention_source_bytes` (or `sort_desc` in your
query tool, or `grep source_bytes ~/fusion-diagnostics/fn-soak.log | sort -k3 -t= -n -r | head`) before touching code.

| Observation | Next step | Evidence that ends the hunt |
| --- | --- | --- |
| A `source_bytes{source="X"}` ramps monotonically and `source_ceiling{source="X"}` is high relative to per-entry size | Fix **that** cache: lower or right-size its ceiling, and check whether per-entry bytes (not entry count) is the real weight — a diff entry holds one whole patch per changed file | `source_bytes` plateaus below the ceiling under the same traffic; the source is listed in `scripts/lib/retention-inventory.mjs` as `census-registered` |
| A source sits at its ceiling persistently and the pressure warning fires with `source-at-ceiling` | Two honest options: the ceiling is wrong for real traffic (raise it *with* an entry-size budget), or entries are not expiring (read its `expired_entries` — high means the reclaim path is broken, which is the RUFU-257 bug class) | `expired_entries` near 0 with a plateau, and a regression test that drives 1 000 distinct keys and asserts entries ≤ ceiling |
| `source_entries` ramps while `source_bytes` stays flat | You are counting identities, not holding values — check the source's value shape; often the map is a set of ids pointing at something held elsewhere (listeners, sockets, sessions) | The owning structure gets its own census row so the bytes land somewhere |
| `coverage_ratio` near 0 and `heap_used_bytes` climbing, no source ramping | The growth is **outside** the census. Attribute it with the **sampling heap profiler** (`HeapProfiler.startSampling` → ~10 min → `getSamplingProfile`, self-size per stack, near-zero overhead) — a full snapshot is only diffable once the live set is small, and on a host whose watchdog kills on RSS it cannot be taken at all (see below). Register the winner with the census so it is attributed next time | The dominating constructor in the profile is a module-scope collection you can register; the guard then refuses it if anyone un-bounds it |

### A full heap snapshot cannot be taken on an RSS-capped host

<!-- FNXC:HeapSnapshotFeasibility 2026-10-12-20:17:
RUFU-615 measured why the snapshot step of this table silently never produces evidence on the
Schindler production host. V8 serializes a snapshot in memory before writing it, so generation
RSS is roughly live set + serialized snapshot ≈ 2x the live set. With a ~10 GiB live set the
process crossed the watchdog's 16 GiB RSS kill ~70 s into `kill -USR2 <pid>` and was restarted
with `health=000 rss=19572440`, leaving the file it had opened at 0 bytes. Six independent
`Heap.*.heapsnapshot` files in that deploy worktree are 0 bytes, which is this mechanism, not
operator error. The heap ceiling is not the constraint here: the RSS kill and host availability
are, so raising `--max-old-space-size` cannot make a snapshot feasible. The sampling profiler is
the discovery tool; a snapshot is a post-fix verification tool, usable only once the live set is
small enough that 2x it fits under the kill. -->

V8 builds the snapshot **in memory before the first byte is written**, so taking one temporarily costs about `2 × live set` of RSS. On any host whose availability is enforced below that (a watchdog RSS kill, a container memory limit, or simply free RAM), the capture is killed mid-write and leaves a **0-byte** file — the death looks like a health failure, not a failed diagnostic.

Two consequences:

- **Use the sampling profiler for discovery.** `HeapProfiler.startSampling` with `getSamplingProfile` after ~10 min reports self-size by stack at negligible memory cost, and it is what produced this repo's only measured allocation number (`~925 MiB of still-live allocations per 180 s window`, cited in `packages/core/src/task-store/reads.ts`).
- **Reserve snapshots for verification.** Once a fix has brought the live set down so that twice it fits under the kill, a before/after pair becomes feasible and is the strongest evidence that the retained set actually shrank.

Before spending the outage, do the arithmetic: `2 × current heap_used` versus (RSS kill − current RSS). On the 2026-10-12 attempt that was `~20 GiB` needed against `~4,3 GiB` of headroom.
| `heap_used_bytes` flat but RSS climbs | Off-heap retention: `Buffer`s, `Uint8Array`s, libuv handles, child-process pipes (terminal output is the known dashboard example — `terminal_output_buffers` is registered precisely for this) | RSS flattens once the owning buffer is bounded |
| `probe_failures > 0` | An attribution hole, not a memory bug: one source's probe throws so its bytes fall into the residual. Read the census warning naming the failing source and fix the probe | `probe_failures` back to 0 and the source's bytes reappear |
| Nothing grows at all, but the operator got a pressure warning | The warning line names its own reason: `retention pressure (heap-ratio):` means heap used reached 75 % of the V8 ceiling even though nothing is ramping — the process is near its limit for another reason (a very large board, big store reads, a legitimately big working set). `retention pressure (source-at-ceiling):` names the source instead. Both are warnings only: nothing is dropped, restarted, or resized to produce them | The warning stops firing after the load that caused it goes away |

## Do not raise the heap ceiling

`--max-old-space-size` is **not** increased as part of this work, and must not be as a fix for this class.
A bigger ceiling converts a diagnosable leak into a longer wait before the same death, and it destroys the
meaning of `coverage_ratio` and the 75 % pressure threshold. The only `--max-old-space-size=6144` in the
repo is in the **Docker build stage** (Dockerfile builder tooling, not the runner), and the dashboard's
Node flags are otherwise untouched. If a legitimate traffic increase needs more room, that decision belongs
with a measured `source_bytes`/per-entry-size argument, recorded in the inventory — not with a flag bump.

<!-- FNXC:DashboardHeapCeiling 2026-10-01-07:41:
A production host runs its dashboard with NODE_OPTIONS=--max-old-space-size=16384 set in the launch
environment, not in settings, scripts, compose, or a cgroup. It is therefore invisible to an audit that
reads only those files, and it is silently lost when a process is started by hand: without the flag V8
uses its 4.09 GB default, and 28 consecutive supervisor restarts were measured dying at 3.90-4.03 GB.
The rule above is about the product not raising the ceiling as a fix; this note records an operator's
availability decision on one host. Both statements have to stay true at once.

FNXC:DashboardHeapCeiling 2026-10-01-07:41:
Raising the ceiling in the launch environment does cost the diagnostics named above, so read the pressure
signal against the real limit, not the default: `heap-ratio` fires at 75 % of 16.09 GB (about 12 GB),
not of 4.09 GB. Measured history on that host: with the 16 GB ceiling in place RSS still grew
3.0 -> 13.0 GB across 9.3 h (~1 GB/h), so the ceiling changes how long the process lives, never whether
the retained set is real. Treat a raised ceiling as a reason to read `source_bytes` earlier, not as a
reason to stop reading it.
-->

### A host that already runs with a raised ceiling

One production host deliberately runs the dashboard with `NODE_OPTIONS=--max-old-space-size=16384` in the
launch environment. That is an operator availability decision, not a fix for this class, and it does not
repeal the rule above. Two consequences for anyone reading the numbers there:

- **The 75 % pressure threshold resolves against the real limit.** On that host `retention pressure
  (heap-ratio)` first becomes possible near 12 GB, so a quiet log there is not evidence of a healthy heap.
  Sample `fusion_retention_heap_used_bytes` against `…_heap_limit_bytes`, which report the actual pair.
- **Verify the ceiling before believing a death.** Node's default is 4.09 GB and the flag raises it to
  16.09 GB, so deaths clustered just under 4 GB mean the flag was missing from the launch environment,
  which is an operations fault and not this runbook's subject:

  ```bash
  tr '\0' '\n' < /proc/$(ss -ltnp | grep ':4040 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)/environ \
    | grep -E '^NODE_OPTIONS'   # empty = running on the 4.09 GB default
  node -e 'console.log((require("v8").getHeapStatistics().heap_size_limit/1073741824).toFixed(2))'
  ```

  When restarting that host, carry the flag in the environment (so agent-session children inherit it) and
  keep any diagnostic flag in `execArgv`, which is what the dashboard supervisor preserves across respawn.

## Recurrence guard (what CI now refuses)

```bash
node scripts/check-retention-coverage.mjs   # exit 0 = every module-scope cache declaration is classified
```

It is the last validator in `pnpm test:gate:static`; `scripts/run-static-gate-checks.mjs` derives the
blocking inventory from that script and `pnpm test:gate` runs it before any test lane, which is exactly
what `.github/workflows/pr-checks.yml`'s blocking `Gate` job invokes (`run: pnpm test:gate`). So the guard
is a hard merge blocker — not a non-blocking full-suite signal. The guard is
**structural**, deliberately not text-based: it parses module-scope `new Map()` / `new Set()`
declarations out of comment-stripped source, and classifies TTL/traffic-keyed caches by what the code
*does* (an `expiresAt` write, a `Date.now()` read, traffic-derived-key seeding). It does not key on
`Date.now()` occurrences, comments, or date stamps, so a rename or comment edit cannot open it, and it
cannot be satisfied with a comment. Current state printed by the script:

```
retention coverage OK: 110 module-scope Map/Set declarations classified (37 census-registered, 4 bounded, 13 carrying expiry evidence)
  pending root packages/engine/src: 116 module-scope declarations, 39 still unclassified
  pending root packages/core/src: 128 module-scope declarations, 32 still unclassified
  pending root packages/cli/src: 10 module-scope declarations, 3 still unclassified
```

The dashboard is fully gated and its ledger may never gain an unclassified entry (ratcheted by
`packages/dashboard/src/__tests__/retention-coverage-ratchet.test.ts`). The other roots are reported but
not yet enforced: RUFU-257 classified **the crashing process first**. Their pending counts are the
starting ledger for classifying those roots; a root flips to blocking by moving it from the pending list
to the enforced list in the script, and the floors in the script (≥60 scanned declarations, ≥15
census-registered, non-empty TTL-keyed subject set) plus the injected-fixture failure cases in
`scripts/__tests__/check-retention-coverage.test.mjs` are what keep the guard from passing vacuously.

## Symptom coverage (what is automated)

The deterministic in-process half of the symptom is a real test, not a `coverage_ratio` assertion
(`packages/dashboard/src/__tests__/retention-caches-invariant.test.ts` and its neighbours):

- The census registers **exactly** the bounded surfaces this work accounts for — no silent additions, no
  silent removals — and every registered row carries a named ceiling (`ceiling` *and* the
  `ceilingConstant` it came from), so a bound with no name cannot be reviewed.
- 1 000 distinct client addresses driven through a traffic-keyed lane → that source is the one the census
  names as holding the load, `tracked_bytes > 0`, `coverage_ratio` is non-zero and ≤ 1, `residual_bytes`
  is reported, and `probe_failures` is 0 (a throwing probe is reported, never read as zero).
- An expired window is **reclaimed**, not ignored: after the clock passes every window TTL, one further
  request drops the source from 1 000 entries to the 1 live address, with `expired_entries` back to 0.
  `chat.ts` owns no cleanup timer, so the census sweep is that source's only reclamation owner — which is
  exactly why the assertion is on entry count rather than on behaviour.
- A token past its expiry is dropped while a **live** token is still honoured (the ceiling may never
  invalidate a valid credential early); a token at exactly its expiry instant is still honoured.
- Terminal queues stay bounded in chunks **and** bytes, discarding oldest-first, with one cumulative
  discard counter and one census row for the unit.
- `/metrics` renders every family even when the census probe itself throws, and the diff-lane caches keep
  their advertised ceilings (500 / 100 / 500) with the eviction and delete-on-expire wires present in the
  write and read paths — each structural wire carries a mutated-fixture control in the same file.
- Each traffic-keyed lane is asserted at 1 000 distinct addresses across the eight bounded window caches
  (chat, planning, agent generation, refine, translate, task search, mission and milestone interviews),
  holding inside its ceiling and reclaiming once expired.

The census, the sampler, and the guard each also carry a **non-vacuity control** — a mutated fixture that
must make the check fail — because a guard that matches nothing and a metric that renders empty both look
identical to a passing one.

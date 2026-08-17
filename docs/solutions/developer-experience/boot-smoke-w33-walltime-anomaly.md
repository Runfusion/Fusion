---
title: "Boot-smoke W33 wall-time anomaly: controlled re-measure"
date: 2026-08-15
category: developer-experience
module: scripts/boot-smoke.mjs
problem_type: performance_investigation
component: boot_smoke
applies_when: "A weekly velocity row reports a boot-smoke wall-time spike and the team needs to distinguish a boot-path regression from cold embedded-PostgreSQL measurement variance."
symptoms:
  - "A single `pnpm smoke:boot` measurement is above the established 17.4–18.8 second clean band."
  - "Gate and changed-only lanes do not show a matching slowdown."
root_cause: single_sample_measurement_variance
resolution_type: documented_measurement_protocol
severity: low
related_components:
  - scripts/boot-smoke.mjs
  - scripts/test-velocity-baseline.mjs
  - scripts/test-velocity-history.json
  - docs/test-velocity-baseline.md
tags: [boot-smoke, performance, test-velocity, embedded-postgres, fn-9105]
---

# Boot-smoke W33 wall-time anomaly: controlled re-measure

## Problem

The W33 weekly velocity row at `2026-08-13T01:59:18.032Z` recorded boot smoke at **26,667 ms**,
up from the preceding 18,149 ms. Gate and changed-only measurements improved in that row, making
this a boot-specific signal worth checking, but a weekly row is only one sample.

The history already showed that this pattern was not durable: 21,059 ms and 22,807 ms samples on
2026-06-23 were followed by 19,802 ms and then 18,157 ms; 25,333 ms on 2026-07-08 was followed by
17,604 ms; and 20,150 ms / 24,038 ms on 2026-07-22 were followed by 18,285 ms / 18,454 ms.

## Investigation

FN-9105 measured five **sequential** `BOOT_SMOKE_TIMINGS=1 pnpm smoke:boot` runs after a passing
`pnpm build` preflight. The samples ran in the task worktree rather than the operator-owned primary
checkout, as required by the worktree policy:

- Worktree: `/Users/eclipxe/Projects/kb/.worktrees/keen-mesa`
- Worktree and base `main` SHA: `987878bd173d6a8c22eb963e721cf5ea2694cda4`
- Host: Darwin 25.1.0; Apple M3 Ultra; 256 GiB RAM; Node `v26.3.0`
- Every sample used the smoke script's fresh isolated `$HOME` and project directory, embedded
  PostgreSQL defaults, and an ephemeral port. No sample needed the port-retry path.
- Process checks found no concurrent Vitest/test/build/boot-smoke/`fn serve` process before the
  sample window; initial load was 12.61/14.57/13.80 and final load was 7.91/12.13/12.93.

| Sample | Wall ms | help ms | init ms | serve-to-health-200 ms | sigterm-to-exit ms | Attempt |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 26,395.841 | 1,859 | 9,410 | 1,534 | 14 | 1 |
| 2 | 19,588.981 | 1,001 | 2,562 | 1,542 | 12 | 1 |
| 3 | 19,755.175 | 1,083 | 2,711 | 1,548 | 15 | 1 |
| 4 | 19,825.254 | 1,120 | 2,801 | 1,541 | 16 | 1 |
| 5 | 19,562.424 | 993 | 2,536 | 1,563 | 14 | 1 |

The wall-clock min/median/max was **19,562.424 / 19,755.175 / 26,395.841 ms**. Phase medians
were help **1,083 ms**, init **2,711 ms**, serve-to-health-200 **1,542 ms**, and shutdown **14 ms**.
The high first sample was attributable to cold init at 9,410 ms, not a port retry.

## Root cause

This was **single-sample measurement variance**, not a confirmed boot-path regression. Each smoke
run deliberately creates a cold isolated home and starts embedded PostgreSQL, so `initdb` and local
filesystem activity can vary materially. The script can also legitimately retry a lost ephemeral-port
bind and must tolerate short-lived temp-directory cleanup races; neither occurred in this set, but
both are variance sources the protocol must report rather than hide.

## Decision and protocol

Treat a controlled median **at most 20,500 ms** as in band. The FN-9105 median was 19,755.175 ms,
so W33's 26,667 ms capture is an artifact for diagnosis, not a reason to change production startup.

When a future single weekly boot-smoke sample spikes:

1. Build the same task worktree first and keep the primary checkout untouched.
2. Quiesce competing test/build/boot-smoke work, then run five sequential samples with
   `BOOT_SMOKE_TIMINGS=1`.
3. Preserve every sample and report wall min/median/max plus the four phase values; do not discard
   a cold or retry sample.
4. Only investigate a boot-path regression when the five-sample median exceeds 20,500 ms. Attribute
   it to help, init, serve-to-health-200, or shutdown before changing code.
5. Never respond by widening timeouts, adding retries, or weakening assertions.

## Clean-baseline handoff

`scripts/test-velocity-history.json` remains append-only and was not hand-edited. This task also did
not append a mid-week row or regenerate `docs/test-velocity-baseline.md`. The operator's next
quiesced weekly refresh, `pnpm test:velocity -- --measure --write-report`, after its build preflight,
records W34. If that one measurement spikes, use this protocol before declaring a regression.

## Timing snapshot outcome

FN-9105 found no local `.timings` reporter inputs through `discoverWorkspaceTimingFiles()`. A
recent `main` full-suite run (`31912458236`) exposed only four non-expired
`test-timings-shard-*` artifacts: its 21 reporter files covered 17 packages, fewer than the 34
packages in the existing snapshot. FN-9105 therefore left `scripts/test-timings.json` untouched
rather than publishing an incomplete refresh. No timestamp was fabricated or restamped, no prune
action stood in for a refresh, and no full suite ran locally solely to produce timings. A future
refresh requires complete genuine recent CI shard artifacts or local reporter output.

---
"@runfusion/fusion": patch
---

Fix dashboard freezing for several seconds while a Fusion agent runs a long verification command (e.g. `pnpm test`).

Root cause was in `runVerificationCommand`'s output capture (`packages/engine/src/run-verification-tool.ts`). The captured stdout/stderr buffers used a string-concat + re-encode pattern: once total output exceeded 200 KB, every subsequent line did `Buffer.from(buf.tail).subarray(...).toString("utf8")`, allocating and re-decoding the entire ~100 KB tail per line. A vitest run dumping 50k+ lines produced multiple GB of GC churn, which stalled the dashboard event loop in stop-the-world pauses (matching the symptom: occasional multi-second freezes with no CPU spike on the host).

The buffer is now stored as a chunk array; tail compaction runs only when accumulated size grows past 2× the cap, making per-line append amortized O(1). All 12 existing `run-verification-command` tests pass unchanged.

Two follow-on changes shipped in the same patch:

- **Embedded terminal PTY ingestion** (`packages/dashboard/src/terminal-service.ts`) had the same anti-pattern: `outputBuffer.slice(0, 4096)` + `outputBuffer.slice(4096)` on every 4 ms flush tick. Switched to a chunk array with O(1) drain. Throttle bumped from 4 ms to 16 ms (60 fps) and per-flush cap from 4 KB to 64 KB. This was not the cause of the user-reported freeze, but the same O(N²) hazard would surface under any flood from a terminal pane.
- **Vitest worker fan-out tightened**: per-package cap lowered from `min(6, cpus()-1)` to `min(4, cpus()-1)` in cli/dashboard/desktop/mobile/plugin-sdk/engine (engine had no cap before). Each config now explicitly pins `pool` (`forks` or `threads`) and only sets the matching `poolOptions`, removing the dual-pool declaration. Worst-case `pnpm test` fan-out: ~12 workers → ~8.

/*
FNXC:HeapCeilingObservability 2026-10-01-10:56 (RUFU-462):
A dashboard process can be running under a V8 heap ceiling its operator never chose. On the host that
motivated this module, the board died 28 times at 3.90–4.03 GB heap under the supervisor — `Ineffective
mark-compacts near heap limit` — because it had been started without `NODE_OPTIONS`, so V8 used its ~4.09 GB
platform default while the host's established launch environment is `--max-old-space-size=16384`. Every
surface read normal throughout: `/api/health` said ok, the logs said nothing, and the supervisor hid each
death. The number existed only in the launch environment, so it could only be discovered by a body count.

This module makes that number a first-class observed fact. It RESOLVES the ceiling from the one authoritative
source (`v8.getHeapStatistics().heap_size_limit`, the same call the retention census and `/api/system-stats`
already use — never a second source of truth) and CLASSIFIES which launch site carries it:

  - `execArgv`      — a flag Node was invoked with directly (argv-0 flags, tsx loader flags under `pnpm dev`),
  - `NODE_OPTIONS`  — the flag set in the environment (the shape the runbook records per host),
  - `v8-default`    — neither site declares it, so the ceiling is whatever V8 picked for this machine.

`execArgv` wins over `NODE_OPTIONS` because Node applies argv flags after `NODE_OPTIONS`, so the later write
is what actually shaped the heap.

OBSERVE ONLY. Nothing here sets, raises, defaults, or injects a ceiling: `docs/solutions/performance/
dashboard-heap-growth-runbook.md` states the product must not raise the ceiling as a fix for a leak, and the
value itself is a per-host operator decision. `isV8Default` therefore means "no launch site declared a
ceiling, so this is V8's own choice" — it is a statement about provenance, which is what an operator can act
on, not a claim that the byte count matches an unmeasurable platform default (V8 exposes no "default limit"
value in-process, only the resolved one).

The raw `NODE_OPTIONS` string is launch-environment content and never leaves this module: surfaces get the
resolved byte count plus the fixed three-value source enum.
*/

import { getHeapStatistics } from "node:v8";
import { formatBytes } from "./format-bytes.js";

/** The V8 flag that sets the old-space (heap) ceiling, in MiB. */
export const MAX_OLD_SPACE_FLAG = "--max-old-space-size";

/** Which launch site the ceiling came from. Fixed enum: safe for auth-exempt payloads and run-audit. */
export type HeapCeilingSource = "execArgv" | "NODE_OPTIONS" | "v8-default";

/** The resolved ceiling plus its provenance — the fact every boot surface reports. */
export interface HeapCeiling {
  /** Resolved V8 old-space ceiling in bytes, read from `heap_size_limit` (never derived from the flag). */
  heapLimitBytes: number;
  /** Which launch site declared the flag, or `v8-default` when neither did. */
  source: HeapCeilingSource;
  /** True when no launch site declared a ceiling, i.e. V8 chose this process's limit itself. */
  isV8Default: boolean;
}

/** Injectable inputs for tests and for hosts that resolve the ceiling before the store exists. */
export interface HeapCeilingInit {
  /** Node's own flags (`process.execArgv`); wins over `NODE_OPTIONS` because Node applies them later. */
  execArgv?: readonly string[];
  /** Environment to read `NODE_OPTIONS` from (`process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The authoritative resolved ceiling in bytes; defaults to V8's own `heap_size_limit`. */
  heapSizeLimitBytes?: number;
}

/**
 * Find a declared `--max-old-space-size` value in a token list, accepting both the `--flag=value` and the
 * two-token `--flag value` spellings Node accepts in argv and in `NODE_OPTIONS`. Node's own parser takes the
 * LAST occurrence, so this returns the last one too. A present-but-unusable value (non-numeric, zero,
 * negative, non-finite) is NOT a ceiling declaration: V8 would have rejected the launch outright over one,
 * so a garbled token must not masquerade as an intentional ceiling choice.
 */
function findDeclaredMaxOldSpaceMib(tokens: readonly string[] | undefined): number | undefined {
  let declared: number | undefined;
  for (let i = 0; i < (tokens?.length ?? 0); i++) {
    const token = tokens![i];
    if (typeof token !== "string") continue;
    let raw: string | undefined;
    if (token.startsWith(`${MAX_OLD_SPACE_FLAG}=`)) {
      raw = token.slice(MAX_OLD_SPACE_FLAG.length + 1);
    } else if (token === MAX_OLD_SPACE_FLAG) {
      raw = tokens![i + 1];
      // A trailing `--flag` with no following token declares nothing.
      if (raw === undefined) continue;
      i++;
    } else {
      continue;
    }
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    declared = parsed;
  }
  return declared;
}

/** Split `NODE_OPTIONS` into argument tokens the way Node does (whitespace-separated). */
function nodeOptionTokens(env: NodeJS.ProcessEnv | undefined): string[] {
  const raw = env?.NODE_OPTIONS;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Resolve the ceiling this process is running under and where that came from.
 *
 * The byte value always comes from the injected seam (default: V8's own `heap_size_limit`), never from
 * arithmetic on the flag value — V8's resolved limit is larger than the requested MiB, and the requested
 * number is a wish while `heap_size_limit` is the fact.
 */
export function resolveHeapCeiling(init: HeapCeilingInit = {}): HeapCeiling {
  const execArgv = init.execArgv ?? process.execArgv;
  const env = init.env ?? process.env;
  let heapLimitBytes = init.heapSizeLimitBytes;
  if (typeof heapLimitBytes !== "number" || !Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) {
    heapLimitBytes = getHeapStatistics().heap_size_limit;
  }

  let source: HeapCeilingSource = "v8-default";
  if (findDeclaredMaxOldSpaceMib(execArgv) !== undefined) {
    source = "execArgv";
  } else if (findDeclaredMaxOldSpaceMib(nodeOptionTokens(env)) !== undefined) {
    source = "NODE_OPTIONS";
  }

  return { heapLimitBytes, source, isV8Default: source === "v8-default" };
}

let bootHeapCeiling: HeapCeiling | undefined;

/**
 * Resolve once per process and memoize. The ceiling cannot change after V8 booted, so every surface that
 * reports it (boot log, `/api/health`, `/api/system-stats`, the run-audit row, the notice) must read the same
 * snapshot rather than re-probe and risk disagreeing with the boot line it is quoted beside.
 */
export function getBootHeapCeiling(init: HeapCeilingInit = {}): HeapCeiling {
  bootHeapCeiling ??= resolveHeapCeiling(init);
  return bootHeapCeiling;
}

/** Test-only seam: forget the memoized snapshot so a suite can re-resolve under injected inputs. */
export function resetBootHeapCeilingForTesting(): void {
  bootHeapCeiling = undefined;
}

/** Human-readable ceiling, e.g. `16.09 GiB`. Shares the retention notice's formatter so both agree. */
export function formatHeapCeilingBytes(ceiling: HeapCeiling | number): string {
  const bytes = typeof ceiling === "number" ? ceiling : ceiling.heapLimitBytes;
  return formatBytes(bytes);
}

/** The fixed-phrase description of the carrying site. Never includes flag values or env content. */
export function describeHeapCeilingSource(ceiling: HeapCeiling): string {
  switch (ceiling.source) {
    case "execArgv":
      return `from ${MAX_OLD_SPACE_FLAG} in execArgv`;
    case "NODE_OPTIONS":
      return `from ${MAX_OLD_SPACE_FLAG} in NODE_OPTIONS`;
    case "v8-default":
    default:
      return `V8 default — no ${MAX_OLD_SPACE_FLAG} in execArgv or NODE_OPTIONS`;
  }
}

/**
 * The one-line boot report. It names the number AND the site that carries it, because the failure this
 * module exists for was a ceiling that silently differed from the host's intent: "which place holds it" is
 * the half an operator can actually go edit.
 */
export function formatHeapCeilingLine(ceiling: HeapCeiling): string {
  return `Heap ceiling: ${formatHeapCeilingBytes(ceiling)} (${describeHeapCeilingSource(ceiling)})`;
}

/** Compact form for embedding in supervisor lines: `16.09 GiB from NODE_OPTIONS`. */
export function formatHeapCeilingCompact(ceiling: HeapCeiling): string {
  const site =
    ceiling.source === "execArgv"
      ? `from ${MAX_OLD_SPACE_FLAG} in execArgv`
      : ceiling.source === "NODE_OPTIONS"
        ? `from ${MAX_OLD_SPACE_FLAG} in NODE_OPTIONS`
        : `at the V8 default, no flag declared`;
  return `${formatHeapCeilingBytes(ceiling)} ${site}`;
}

/**
 * What a supervisor respawn will do with the ceiling. The respawn rebuilds the child from `process.execArgv`
 * and passes the environment through, so BOTH sites survive — but only one of them is this process's actual
 * source, and the compiled-binary respawn path rebuilds with NO execArgv flags at all. Saying which site is
 * in effect is what stops a restart from silently changing the picture (RUFU-462 Step 4/5).
 */
export function describeHeapCeilingRespawnCarry(ceiling: HeapCeiling): string {
  switch (ceiling.source) {
    case "execArgv":
      return `respawn rebuilds it from execArgv`;
    case "NODE_OPTIONS":
      return `respawn inherits it through NODE_OPTIONS`;
    case "v8-default":
    default:
      return `nothing to carry — the child gets the V8 default too`;
  }
}

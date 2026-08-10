/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 — the unattributed-marker ratchet):

U18 made the mutation-context parameter required across the mutating store surface. Most converted
call sites had no authenticated actor to supply, because the units that produce one have not landed:
HTTP routes get theirs in U9, the CLI in U11, and engine sweeps/schedulers/self-healing in U13. Those
sites pass `UNATTRIBUTED_MUTATION_CONTEXT`, which is honest but is still debt.

Debt that is only honest is still invisible. Without this test the marker would spread — every new
mutation added between now and U13 would reach for it, because it is the path of least resistance and
it compiles. This test converts it into an ENFORCED, SHRINKING obligation: the count may fall, and it
may never rise. It must reach ZERO as U9/U11/U13 land; a unit that lands without lowering it has not
actually wired its surface.

If this test fails because the count GREW: do not raise the baseline. Derive a real actor instead —
`mutationContextForAgent` exists for the case where an agent id is already in scope, and any surface
with an authenticated session or an inbound run context should carry that through rather than mint a
marker. Raising the baseline is how a ratchet becomes a rubber stamp.

If it fails because the count SHRANK: lower `BASELINE` in the same commit that removed the usages.
That is the intended direction and the assertion says so explicitly.

Scope note: only `@fusion/core` production source is counted. `identity/mutation-context.ts` defines
the marker, `identity/actor.ts` documents it, the two index barrels re-export it, and the test-utils
fixture references it in prose — none of those are call sites, so all five are excluded. `__tests__`
is excluded because a test asserting the unattributed path is coverage, not debt.
*/

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_SRC = join(fileURLToPath(new URL("../", import.meta.url)));

const MARKER = "UNATTRIBUTED_MUTATION_CONTEXT";

/** Files that mention the marker without being call sites. */
const EXCLUDED_FILES = new Set([
  "identity/mutation-context.ts",
  "identity/actor.ts",
  "index.ts",
  "index.gate.ts",
  "__test-utils__/mutation-context-fixture.ts",
]);

/*
FNXC:Identity 2026-08-09-03:04:
THE RATCHET. 33 call sites in `@fusion/core` were converted to the marker by U18 because no real
actor was derivable at them. Ownership of the remaining work, so the number is a work list and not
just a number:

  - store.ts (4), task-store/* (10), duplicates/* (9), missions + async mission stores (4)
      -> store-side sweeps, intake, and recovery paths. Actor arrives with U13 (engine lanes) or
         U9/U11 (the dashboard/CLI entry points that call create and mission triage).
  - agents/agent-store.ts (3)
      -> deleteAgent and forceReleaseTask, where the only agent id in scope names the TARGET of the
         write rather than its author. Every other checkout path in that file already derives a real
         actor via `mutationContextForAgent`.
  - board/board-action-services.ts (2)
      -> the structural board-store seam consumed by dashboard routes. U9.

This must reach 0. It must never grow.
*/
const BASELINE = 33;

function isCountedLine(line: string): boolean {
  const trimmed = line.trim();
  // Imports and comments mention the marker without invoking it.
  return !(trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function censusUsages(): { total: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of collectTsFiles(CORE_SRC)) {
    const rel = relative(CORE_SRC, file).split(sep).join("/");
    if (EXCLUDED_FILES.has(rel)) continue;
    let count = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!isCountedLine(line)) continue;
      count += line.split(MARKER).length - 1;
    }
    if (count > 0) {
      byFile[rel] = count;
      total += count;
    }
  }
  return { total, byFile };
}

describe("unattributed actor census (U18 ratchet)", () => {
  it("never grows, and shrinks to zero as U9/U11/U13 wire real actors", () => {
    const { total, byFile } = censusUsages();
    expect(
      total,
      `Unattributed mutation-context usages GREW from ${BASELINE} to ${total}.\n`
      + "Do not raise BASELINE. Derive a real actor at the new call site instead "
      + "(mutationContextForAgent, or thread the caller's authenticated context).\n"
      + `Current distribution:\n${JSON.stringify(byFile, null, 2)}`,
    ).toBeLessThanOrEqual(BASELINE);

    expect(
      total,
      `Unattributed mutation-context usages SHRANK from ${BASELINE} to ${total}. `
      + "That is the intended direction — lower BASELINE to " + total + " in this same commit "
      + "so the ratchet keeps its new floor.",
    ).toBe(BASELINE);
  });

  it("counts real call sites, not imports or prose", () => {
    const { byFile } = censusUsages();
    // The definition module and the barrels mention the marker but are never call sites.
    for (const excluded of EXCLUDED_FILES) {
      expect(byFile[excluded]).toBeUndefined();
    }
    // A guard on the counter itself: a comment-only mention must not be counted.
    expect(isCountedLine(`  // pass ${MARKER} here`)).toBe(false);
    expect(isCountedLine(`  * ${MARKER} is the marker`)).toBe(false);
    expect(isCountedLine(`import { ${MARKER} } from "../identity/mutation-context.js";`)).toBe(false);
    expect(isCountedLine(`    await store.logEntry(id, "x", undefined, ${MARKER});`)).toBe(true);
  });

  it("the marker is reserved, so it can never become a real actor or hold a grant", async () => {
    const { RESERVED_ACTOR_IDS, UNATTRIBUTED_ACTOR_ID, isReservedActorId, BOOTSTRAP_ACTOR_ID } =
      await import("../identity/actor.js");
    expect(UNATTRIBUTED_ACTOR_ID).toBe("system:unattributed");
    expect(isReservedActorId(UNATTRIBUTED_ACTOR_ID)).toBe(true);
    expect(RESERVED_ACTOR_IDS).toContain(UNATTRIBUTED_ACTOR_ID);
    /*
    The distinction U18 exists to preserve: an unwired call site must NOT be indistinguishable from a
    pre-enablement bootstrap write, or the later units have no work list and the seam reports as
    fully attributed while attributing nothing.
    */
    expect(UNATTRIBUTED_ACTOR_ID).not.toBe(BOOTSTRAP_ACTOR_ID);
  });

  it("the marker carrier keeps the pre-existing synthetic run/agent audit values", async () => {
    const { UNATTRIBUTED_MUTATION_CONTEXT, mutationContextForAgent } =
      await import("../identity/mutation-context.js");
    const { UNATTRIBUTED_ACTOR_ID } = await import("../identity/actor.js");
    /*
    Converting a call site to the marker must change what the audit row says about the ACTOR and
    nothing else; "unknown"/"system" are the values the move and delete paths already fell back to.
    */
    expect(UNATTRIBUTED_MUTATION_CONTEXT.runId).toBe("unknown");
    expect(UNATTRIBUTED_MUTATION_CONTEXT.agentId).toBe("system");
    expect(UNATTRIBUTED_MUTATION_CONTEXT.actor.actor.id).toBe(UNATTRIBUTED_ACTOR_ID);

    // The derived form is NOT the marker: its actor is the real agent.
    const derived = mutationContextForAgent("agent-7");
    expect(derived.actor.actor.id).toBe("agent-7");
    expect(derived.actor.actor.kind).toBe("agent");
    expect(derived.actor.actingFor).toBeUndefined();
  });
});

/*
FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
`safeComputeDeferralCapacityGateFacts` is the ONLY form a deferral catch/reject path may call.
The lifecycle `suspended` branch's catch converts throws into a terminal task:graph-failed park +
task.error — a throwing diagnostic awaited there converts an explain-wait into a failure, and an
unbounded await there parks the card forever on the gate it is diagnosing. The first slice proved
this exact class was live: an unguarded `store.listAgents` inside the suspension-facts builder was
a latent graph-failed park for any store with a rejecting agent path.

A comment cannot hold a future contributor back, so this static scan holds them: no engine
production source may invoke the raw `computeDeferralCapacityGateFacts` spelling. The scan is
case-sensitive and therefore exact against the safe name (`safeCompute…` carries a capital C
mid-identifier and never matches). The scan function is behavior, so the ratchet also proves its
own teeth against an injected catch-shaped raw call.
*/
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The raw invocation, word-bounded. `safeComputeDeferralCapacityGateFacts` cannot match: the
 *  safe spelling capitalizes the C, and the scan is case-sensitive by construction. */
const RAW_CALL = /\bcomputeDeferralCapacityGateFacts\s*\(/;

/** Files allowed to DEFINE the raw name (the module and its unit tests). The collector tests
 *  paths relative to SRC_ROOT, so the `__tests__` alternative must anchor at string start too. */
const ALLOW_DEFINITION = /workflows[/\\]capacity-gate-facts\.ts$|(^|[/\\])__tests__([/\\]|$)/;

function collectProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectProductionSources(full));
    } else if (entry.endsWith(".ts") && !ALLOW_DEFINITION.test(full.slice(SRC_ROOT.length))) {
      out.push(full);
    }
  }
  return out;
}

/** Names every production source line that invokes the raw name. Exported shape is a plain
 *  string list so the injected-call proof and the real scan share one implementation. */
function findRawComputeCallSites(sources: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of sources) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (RAW_CALL.test(line)) hits.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
    });
  }
  return hits;
}

describe("capacity gate facts — deferral paths call only the safe wrapper (RUFU-372)", () => {
  it("no engine production source invokes the raw computeDeferralCapacityGateFacts", () => {
    expect(findRawComputeCallSites(collectProductionSources(SRC_ROOT))).toEqual([]);
  });

  it("the scan goes RED against a raw call injected into a deferral catch (the ratchet has teeth)", () => {
    const injectedCatchShape = [
      "async function onNodeEntry() {",
      "  try {",
      "    return await hooks.moveTask(input);",
      "  } catch (error) {",
      "    const facts = await computeDeferralCapacityGateFacts({ store, now: Date.now() });",
      "    return { kind: 'suspended', reason: 'capacity', facts };",
      "  }",
      "}",
    ].join("\n");
    // The scan reads real files; write the probe under __tests__ (skipped by the production
    // collector) and scan it explicitly, so the injected call never lives in production.
    const injectedFile = join(SRC_ROOT, "__tests__", "__ratchet-injection-probe__.ts");
    try {
      writeFileSync(injectedFile, injectedCatchShape);
      expect(findRawComputeCallSites([injectedFile])).toEqual([relative(SRC_ROOT, injectedFile) + ":5"]);
      // The safe spelling in the same shape is NOT a hit — the scan distinguishes them.
      writeFileSync(injectedFile, injectedCatchShape.replace("computeDeferralCapacityGateFacts", "safeComputeDeferralCapacityGateFacts"));
      expect(findRawComputeCallSites([injectedFile])).toEqual([]);
    } finally {
      rmSync(injectedFile, { force: true });
    }
  });

  /*
  FNXC:CapacityGateFacts 2026-11-02-23:58 (RUFU-372 second revision):
  The raw-name ban is only half the contract. A deferral path may perform AT MOST ONE await and it must be
  the safe wrapper's own bounded await — an ambient read (`capacityFactsSource()`, a `getSettings()` call)
  awaited before the wrapper sits outside the bound entirely, and in the column boundary a throw from that
  catch converts an explain-wait into a terminal `task:graph-failed` park plus `task.error`. That is the
  diagnostic causing the failure it was written to explain, so the shape is scanned rather than commented.
  */
  it("no deferral path awaits an ambient capacity-facts source outside the wrapper", () => {
    const AMBIENT_AWAIT = /await\s+[\w.]*capacityFactsSource\s*\(/;
    const offenders: string[] = [];
    for (const file of collectProductionSources(SRC_ROOT)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (AMBIENT_AWAIT.test(line)) offenders.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);

    // Teeth: the exact shape the provider exists to prevent must be caught by this scan.
    const injectedProviderAwait = [
      "} catch (err) {",
      "  const source = await deps.capacityFactsSource();",
      "  const facts = await safeComputeDeferralCapacityGateFacts(source);",
    ].join("\n");
    const probe = join(SRC_ROOT, "__tests__", "__provider-await-probe__.ts");
    try {
      writeFileSync(probe, injectedProviderAwait);
      expect(readFileSync(probe, "utf8").split("\n").some((line) => AMBIENT_AWAIT.test(line))).toBe(true);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

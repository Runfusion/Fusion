import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
FNXC:RunAuditSink 2026-11-03-05:55 (RUFU-453):
`index.gate.ts` is the barrel the `engine-core` merge-gate project aliases `@fusion/core` to, and its maintenance rule
is that ordinary barrel changes are mirrored there. When RUFU-453 added `submitRunAuditToSinkWriter` to `index.ts`
only, the engine seam's module-scope import bound `undefined` inside `engine-core`, the seam's synchronous hand-off
threw, and best-effort callers swallowed it — 55 assertions in `merger-merge-lifecycle.test.ts` reported
`recordRunAuditEvent` called 0 times and nothing named the cause. A gap between two barrels is invisible until a
gate file happens to reach the symbol, so the parity is checked here instead of by the next unlucky task.

This is a code-construct guard, not a prose assertion: it compares the export lists the two barrels actually declare.
*/

const FULL_BARREL = { url: new URL("../index.ts", import.meta.url), name: "src/index.ts" } as const;
const GATE_BARREL = { url: new URL("../index.gate.ts", import.meta.url), name: "src/index.gate.ts" } as const;

/** Exported symbol names per run-audit module specifier, read from a barrel's own `export { … } from` statements. */
function runAuditExports(barrel: { url: URL; name: string }): Map<string, Set<string>> {
  const text = readFileSync(barrel.url, "utf8");
  const byModule = new Map<string, Set<string>>();
  const pattern = /export\s*\{([^}]*)\}\s*from\s*"(\.\/run-audit\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((name) => name.length > 0);
    const specifier = match[2] ?? "";
    const existing = byModule.get(specifier) ?? new Set<string>();
    for (const name of names) existing.add(name);
    byModule.set(specifier, existing);
  }
  // A wildcard re-export would make this scan silently incomplete, which is worse than no scan at all.
  expect([...text.matchAll(/export\s*\*\s*from\s*"\.\/run-audit\//g)]).toEqual([]);
  return byModule;
}

describe("run-audit exports are present in both core barrels", () => {
  const full = runAuditExports(FULL_BARREL);
  const gate = runAuditExports(GATE_BARREL);

  it("scans something real (a barrel with no run-audit exports proves nothing)", () => {
    expect(full.size).toBeGreaterThan(0);
    const fullNames = [...full.values()].flatMap((set) => [...set]);
    expect(fullNames).toContain("emitBoundedRunAudit");
    // The symbol whose absence caused the silent 55-failure gate run.
    expect(fullNames).toContain("submitRunAuditToSinkWriter");
  });

  it("mirrors every run-audit symbol the full barrel exports", () => {
    for (const [specifier, names] of full) {
      if (!gate.has(specifier)) {
        expect(
          [...names],
          `module "${specifier}" is re-exported by ${FULL_BARREL.name} but not by ${GATE_BARREL.name}; `
          + "the engine-core merge-gate project would bind these imports to undefined",
        ).toEqual([]);
        continue;
      }
      const gateNames = gate.get(specifier)!;
      const missing = [...names].filter((name) => !gateNames.has(name));
      expect(
        missing,
        `${FULL_BARREL.name} exports ${missing.join(", ")} from "${specifier}" but ${GATE_BARREL.name} does not`,
      ).toEqual([]);
    }
  });
});

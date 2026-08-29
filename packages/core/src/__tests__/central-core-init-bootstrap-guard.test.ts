/**
 * FNXC:CentralCore 2026-07-28-03:00:
 * Regression guard for GET /api/activity-feed 500
 * (`backendHandle is only available in backend mode (asyncLayer injected)`).
 * #2454 left `createCentralBackendLayer` as dead code behind an early return on
 * layer-less `init()`. Dashboard/CLI call sites use `new CentralCore(); await init()`
 * without `attachBackendLayer`, so init must still bootstrap PG.
 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const centralCoreSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../central/central-core.ts"),
  "utf8",
);

describe("CentralCore.init layer-less PG bootstrap", () => {
  it("keeps createCentralBackendLayer reachable (no #2454 early-return no-op)", () => {
    const initStart = centralCoreSrc.indexOf("async init(): Promise<void>");
    expect(initStart).toBeGreaterThan(-1);
    const initEnd = centralCoreSrc.indexOf("async close(): Promise<void>", initStart);
    expect(initEnd).toBeGreaterThan(initStart);
    const initBody = centralCoreSrc.slice(initStart, initEnd);

    expect(initBody).toContain("createCentralBackendLayer");
    // The regression: after the asyncLayer branch, mark initialized and return
    // without ever reaching createCentralBackendLayer.
    expect(initBody).not.toMatch(
      /if \(this\.asyncLayer\) \{[\s\S]*?\n\s*\}\s*\n\s*this\.initialized = true;\s*\n\s*return;\s*\n/,
    );
    // Bootstrap must still assign the owned layer + shutdown hooks.
    expect(initBody).toContain("ownedBackendShutdown");
    expect(initBody).toContain("ownedBackendReleaseConnections");
  });
});

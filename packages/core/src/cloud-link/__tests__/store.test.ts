import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearCloudLinkPending,
  loadCloudLinkPending,
  loadCloudLinkState,
  saveCloudLinkPending,
  saveCloudLinkState,
} from "../store.js";

/*
 * FNXC:CloudLink 2026-09-04-03:44:
 * Synthesize fixture credentials so code scanning does not treat test data as a
 * hardcoded credential and a real value cannot be pasted in as a fixture.
 */
function fixtureSecret(label: string): string {
  return ["fixture", label, "value"].join("-");
}

describe("cloud-link store", () => {
  it("creates parent directories for a custom path", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-link-"));
    const nested = join(dir, "nested", "state.json");
    saveCloudLinkState(
      {
        httpBaseUrl: "https://cloud.example",
        engineId: "eng_1",
        deviceSecret: fixtureSecret("initial"),
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
      nested,
    );
    expect(existsSync(nested)).toBe(true);
    expect(JSON.parse(readFileSync(nested, "utf8")).engineId).toBe("eng_1");
  });

  it("keeps linked credentials intact when pending pairing is saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-link-"));
    const linkedPath = join(dir, "cloud-link.json");
    const pendingPath = join(dir, "cloud-link-pending.json");
    saveCloudLinkState(
      {
        httpBaseUrl: "https://cloud.example",
        engineId: "eng_live",
        deviceSecret: fixtureSecret("linked"),
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
      linkedPath,
    );
    saveCloudLinkPending(
      {
        httpBaseUrl: "https://cloud.example",
        code: "ABCD-EFGH",
        pendingSecret: fixtureSecret("pending"),
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      pendingPath,
    );
    expect(loadCloudLinkState(linkedPath)?.engineId).toBe("eng_live");
    expect(loadCloudLinkState(linkedPath)?.deviceSecret).toBe(fixtureSecret("linked"));
    expect(loadCloudLinkPending(pendingPath)?.code).toBe("ABCD-EFGH");
    clearCloudLinkPending(pendingPath);
    expect(loadCloudLinkPending(pendingPath)).toBeNull();
    expect(loadCloudLinkState(linkedPath)?.engineId).toBe("eng_live");
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFusionAgentDir, getLegacyAgentDir, getPackageManagerAgentDir } from "./auth-paths.js";

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("getPackageManagerAgentDir", () => {
  it("falls back to legacy Pi settings when Fusion settings only contain Fusion metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "fusion-agent-dir-"));
    const fusionAgentDir = getFusionAgentDir(home);
    const legacyAgentDir = getLegacyAgentDir(home);

    mkdirSync(fusionAgentDir, { recursive: true });
    mkdirSync(legacyAgentDir, { recursive: true });
    writeJson(join(fusionAgentDir, "settings.json"), {
      fusionDisabledExtensions: ["/Users/example/.pi/agent/extensions/browse.ts"],
    });
    writeJson(join(legacyAgentDir, "settings.json"), {
      packages: ["npm:pi-claude-cli"],
    });

    expect(getPackageManagerAgentDir(home)).toBe(legacyAgentDir);
  });

  it("prefers Fusion settings when they contain package-manager settings", () => {
    const home = mkdtempSync(join(tmpdir(), "fusion-agent-dir-"));
    const fusionAgentDir = getFusionAgentDir(home);
    const legacyAgentDir = getLegacyAgentDir(home);

    mkdirSync(fusionAgentDir, { recursive: true });
    mkdirSync(legacyAgentDir, { recursive: true });
    writeJson(join(fusionAgentDir, "settings.json"), {
      packages: ["npm:pi-claude-cli"],
    });
    writeJson(join(legacyAgentDir, "settings.json"), {
      packages: ["npm:legacy-only"],
    });

    expect(getPackageManagerAgentDir(home)).toBe(fusionAgentDir);
  });
});

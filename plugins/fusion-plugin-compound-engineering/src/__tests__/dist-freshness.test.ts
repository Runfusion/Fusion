import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsPath = fileURLToPath(new URL("../../dist/settings.js", import.meta.url));
const orchestratorPath = fileURLToPath(new URL("../../dist/session/orchestrator.js", import.meta.url));

function readRequiredDistFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`dist/ is missing — run pnpm build first (FN-6596): ${path}`);
  }
  return readFileSync(path, "utf8");
}

/*
FNXC:CompoundEngineering 2026-06-17-13:15:
The plugin loader imports dist/index.js before src/index.ts, while dist is gitignored and can drift from the fixed TypeScript source. This fast textual guard fails a stale artifact ship before ce-debug regresses to the old enabledStages allow-list.
*/
describe("compiled Compound Engineering dist freshness", () => {
  it("keeps compiled settings on the disabledStages opt-out model", () => {
    const settings = readRequiredDistFile(settingsPath);

    expect(settings).toMatch(/export function getDisabledStages\s*\(\s*settings\s*\)/);
    expect(settings).toMatch(/asStringArray\(settings,\s*["']disabledStages["'],\s*DEFAULT_DISABLED_STAGES\)/);
    expect(settings).toMatch(/const disabled = new Set\(getDisabledStages\(settings\)\);/);
    expect(settings).toMatch(/listStages\(\)\.map\(\(s\) => s\.stageId\)\.filter\(\(stageId\) => !disabled\.has\(stageId\)\)/);
    expect(settings).not.toContain('asStringArray(settings, "enabledStages"');
    expect(settings).not.toContain("asStringArray(settings, 'enabledStages'");
  });

  it("keeps compiled orchestrator launch gating on disabledStages", () => {
    const orchestrator = readRequiredDistFile(orchestratorPath);

    expect(orchestrator).toMatch(/import \{ getDefaultModelId, getDefaultProvider, getDisabledStages \} from ["']\.\.\/settings\.js["'];/);
    expect(orchestrator).toMatch(/if \(getDisabledStages\(this\.ctx\.settings\)\.includes\(stageId\)\) \{\s*throw new Error\(`CE stage is not enabled: \$\{stageId\}`\);\s*\}/);
    expect(orchestrator).not.toMatch(/getEnabledStages\(this\.ctx\.settings\)\.includes\(stageId\)/);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, "..");

function readCommand(command: "serve" | "daemon" | "dashboard" | "desktop" | "task"): string {
  return readFileSync(resolve(commandsDir, `${command}.ts`), "utf8");
}

/*
 * FNXC:GrokCliRouting 2026-07-09-23:05:
 * FN-7761 regression guard for packaged host bootstrap. The Grok helper must run before loadAllPlugins() in each long-lived CLI host so the enabled bundled runtime is loaded and getRuntimeById("grok") can resolve before chat/executor sessions try to route grok-cli/no-key messages.
 */
describe("Grok CLI runtime packaged bootstrap", () => {
  for (const command of ["serve", "daemon", "dashboard"] as const) {
    it(`${command} eagerly ensures the bundled Grok runtime before loading enabled plugins`, () => {
      const source = readCommand(command);
      const importIndex = source.indexOf("ensureBundledGrokRuntimePluginInstalled");
      const ensureIndex = source.indexOf("ensureBundledGrokRuntimePluginInstalled(pluginStore, pluginLoader)");
      const loadIndex = source.indexOf("pluginLoader.loadAllPlugins()");

      expect(importIndex).toBeGreaterThanOrEqual(0);
      expect(ensureIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(ensureIndex).toBeLessThan(loadIndex);
    });
  }
});

/*
FNXC:GrokCliRouting 2026-07-15-10:17:
Hosts must pass a real engine PluginRunner (getRuntimeById) into createServer — never the bare PluginLoader. Engine-mode merge omits onMerge so server.ts derives engine.onMerge. UI-only / bare CLI leave pluginRunner undefined (dual-remediation).
*/
describe("Grok CLI PluginRunner host wiring", () => {
  it("dashboard engine mode passes cwdEngine.getPluginRunner and omits onMerge", () => {
    const source = readCommand("dashboard");
    expect(source).toContain("pluginRunner: cwdEngine?.getPluginRunner?.()");
    expect(source).not.toContain("pluginRunner: pluginLoader");
    // Engine-mode createServer must not force onMergeImpl — server.ts derives engine.onMerge.
    expect(source).toContain("const uiOnlyOnMerge = async (taskId: string)");
    expect(source).toContain("onMerge: uiOnlyOnMerge");
    // uiOnlyOnMerge must not invent a runner
    const uiOnlyIndex = source.indexOf("const uiOnlyOnMerge = async (taskId: string)");
    const landCall = source.indexOf("landWorkspaceTask(store, mergeTask!, cwd, {", uiOnlyIndex);
    const runAiMergeCall = source.indexOf("runAiMerge(store, cwd, taskId, {", uiOnlyIndex);
    expect(landCall).toBeGreaterThan(uiOnlyIndex);
    expect(runAiMergeCall).toBeGreaterThan(uiOnlyIndex);
    expect(source.slice(landCall, landCall + 280)).toContain("pluginRunner: undefined");
    expect(source.slice(runAiMergeCall, runAiMergeCall + 320)).toContain("pluginRunner: undefined");
    // No cross-project warm-engine fallback for merge runner
    expect(source).not.toContain("let mergePluginRunner");
  });

  it("serve and daemon pass primaryEngine.getPluginRunner, not pluginLoader", () => {
    for (const command of ["serve", "daemon"] as const) {
      const source = readCommand(command);
      expect(source).toContain("pluginRunner: primaryEngine.getPluginRunner?.()");
      expect(source).not.toContain("pluginRunner: pluginLoader");
    }
  });

  it("desktop passes cwdEngine.getPluginRunner, not pluginLoader", () => {
    const source = readCommand("desktop");
    expect(source).toContain("pluginRunner: cwdEngine?.getPluginRunner?.()");
    expect(source).not.toContain("pluginRunner: pluginLoader");
  });

  it("fn task merge does not invent a PluginRunner bootstrap", () => {
    const source = readCommand("task");
    const mergeFnIndex = source.indexOf("export async function runTaskMerge");
    expect(mergeFnIndex).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf("export async function runTaskAttach", mergeFnIndex);
    const mergeFnBody = source.slice(mergeFnIndex, nextExport > 0 ? nextExport : undefined);
    expect(mergeFnBody).toContain("FNXC:GrokCliRouting 2026-07-15-10:17");
    expect(mergeFnBody).toContain("Do not invent a full PluginRunner bootstrap");
    expect(mergeFnBody).not.toContain("mergePluginRunner");
  });
});

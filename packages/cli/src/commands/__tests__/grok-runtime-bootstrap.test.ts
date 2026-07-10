import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, "..");

function readCommand(command: "serve" | "daemon" | "dashboard"): string {
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

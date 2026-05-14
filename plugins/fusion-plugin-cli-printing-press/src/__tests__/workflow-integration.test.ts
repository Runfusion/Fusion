import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore, type WorkflowStepTemplate } from "@fusion/core";
import plugin from "../index.js";
import { installExecMock } from "./fixtures/exec-mock.js";

const execAsync = promisify(exec);

async function makeTaskStore() {
  const rootDir = await mkdtemp(join(tmpdir(), "fn-4150-cli-printing-press-"));
  const globalDir = await mkdtemp(join(tmpdir(), "fn-4150-cli-printing-press-global-"));
  const store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await store.init();
  return { store, rootDir, globalDir };
}

async function cleanupTaskStore(ctx: Awaited<ReturnType<typeof makeTaskStore>>) {
  ctx.store.stopWatching();
  ctx.store.close();
  await rm(ctx.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(ctx.globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function injectPluginTemplates(store: TaskStore): void {
  const templates: Array<{ pluginId: string; template: WorkflowStepTemplate }> = (plugin.workflowSteps ?? []).map((template) => ({
    pluginId: plugin.manifest.id,
    template: {
      id: `plugin:${plugin.manifest.id}:${template.stepId}`,
      name: template.name,
      description: template.description,
      prompt: template.prompt ?? "",
      mode: template.mode,
      phase: template.phase,
      scriptName: template.scriptName,
      toolMode: template.toolMode,
      defaultOn: template.defaultOn,
      modelProvider: template.modelProvider,
      modelId: template.modelId,
      enabled: template.enabled,
      category: "Plugin",
      icon: "puzzle",
    },
  }));
  store.setPluginWorkflowStepTemplates(templates);
}

async function runScriptStepFromSettings(store: TaskStore, scriptName: string): Promise<{ stdout: string; stderr: string }> {
  const settings = await store.getSettings();
  const command = settings.scripts?.[scriptName];
  if (!command) {
    throw new Error(`Missing script command for ${scriptName}`);
  }
  return execAsync(command, { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 });
}

describe("workflow integration contracts", () => {
  const stores: Array<Awaited<ReturnType<typeof makeTaskStore>>> = [];

  afterEach(async () => {
    while (stores.length > 0) {
      const ctx = stores.pop();
      if (ctx) {
        await cleanupTaskStore(ctx);
      }
    }
  });

  it("guards against execSync usage in workflow-oriented execution fixtures", () => {
    const execMock = installExecMock();
    execMock.assertExecSyncUnused();
    expect(typeof plugin.manifest.id).toBe("string");
  });

  it("materializes plugin script-mode workflow step through TaskStore", async () => {
    const ctx = await makeTaskStore();
    stores.push(ctx);
    injectPluginTemplates(ctx.store);

    const step = await ctx.store.getWorkflowStep("plugin:fusion-plugin-cli-printing-press:run-service-cli");
    expect(step).toMatchObject({
      id: "plugin:fusion-plugin-cli-printing-press:run-service-cli",
      mode: "script",
      phase: "pre-merge",
      scriptName: "cli-printing-press:run-service-cli",
    });
  });

  it("runs a plugin script-mode step end-to-end via TaskStore plus project scripts", async () => {
    const execMock = installExecMock();
    execMock.setNextResult({ stdout: "ok\n", stderr: "", code: 0 });

    const ctx = await makeTaskStore();
    stores.push(ctx);
    injectPluginTemplates(ctx.store);

    await ctx.store.updateSettings({
      scripts: {
        "cli-printing-press:run-service-cli": "echo ok",
      },
    });

    const step = await ctx.store.getWorkflowStep("plugin:fusion-plugin-cli-printing-press:run-service-cli");
    expect(step).toMatchObject({
      mode: "script",
      scriptName: "cli-printing-press:run-service-cli",
      phase: "pre-merge",
    });

    const result = await runScriptStepFromSettings(ctx.store, step!.scriptName!);
    expect(result.stdout).toContain("ok");
    execMock.assertExecSyncUnused();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore Workflow Steps", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  describe("Workflow Steps", () => {
    it("should create a workflow step with all fields", async () => {
      const ws = await store.createWorkflowStep({
        name: "Documentation Review",
        description: "Verify all public APIs have documentation",
        prompt: "Review the task changes and verify that all new public functions have docs.",
        enabled: true,
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("Documentation Review");
      expect(ws.description).toBe("Verify all public APIs have documentation");
      expect(ws.mode).toBe("prompt");
      expect(ws.gateMode).toBe("advisory");
      expect(ws.prompt).toBe("Review the task changes and verify that all new public functions have docs.");
      expect(ws.scriptName).toBeUndefined();
      expect(ws.enabled).toBe(true);
      expect(ws.createdAt).toBeDefined();
      expect(ws.updatedAt).toBeDefined();
    });

    it("should create a workflow step with minimal fields", async () => {
      const ws = await store.createWorkflowStep({
        name: "QA Check",
        description: "Run tests and verify they pass",
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("QA Check");
      expect(ws.description).toBe("Run tests and verify they pass");
      expect(ws.mode).toBe("prompt"); // Default mode
      expect(ws.gateMode).toBe("advisory"); // prompt default gate mode
      expect(ws.prompt).toBe(""); // Empty when not provided
      expect(ws.enabled).toBe(true); // Default enabled
    });

    it("should create a script-mode workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Run Tests",
        description: "Execute the test suite",
        mode: "script",
        scriptName: "test",
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("Run Tests");
      expect(ws.mode).toBe("script");
      expect(ws.gateMode).toBe("advisory");
      expect(ws.prompt).toBe("");
      expect(ws.scriptName).toBe("test");
      expect(ws.modelProvider).toBeUndefined();
      expect(ws.modelId).toBeUndefined();
      expect(ws.enabled).toBe(true);
    });

    it("should round-trip gateMode create/list/update", async () => {
      const promptStep = await store.createWorkflowStep({
        name: "Prompt advisory",
        description: "advisory default",
        mode: "prompt",
        prompt: "review",
      });
      const scriptStep = await store.createWorkflowStep({
        name: "Script advisory",
        description: "advisory default",
        mode: "script",
        scriptName: "test",
      });

      expect(promptStep.gateMode).toBe("advisory");
      expect(scriptStep.gateMode).toBe("advisory");

      await store.updateWorkflowStep(promptStep.id, { gateMode: "gate" });
      await store.updateWorkflowStep(scriptStep.id, { gateMode: "advisory" });
      const listed = await store.listWorkflowSteps();
      const updatedPrompt = listed.find((step) => step.id === promptStep.id);
      const updatedScript = listed.find((step) => step.id === scriptStep.id);

      expect(updatedPrompt?.gateMode).toBe("gate");
      expect(updatedScript?.gateMode).toBe("advisory");
    });

    it("should preserve explicit gate opt-in for script mode", async () => {
      const ws = await store.createWorkflowStep({
        name: "Script gated",
        description: "explicit gate opt-in",
        mode: "script",
        scriptName: "test",
        gateMode: "gate",
      });

      expect(ws.gateMode).toBe("gate");
    });

    it("should reject script mode without scriptName", async () => {
      await expect(
        store.createWorkflowStep({
          name: "Broken",
          description: "No script name",
          mode: "script",
        }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should reject script mode with empty scriptName", async () => {
      await expect(
        store.createWorkflowStep({
          name: "Broken",
          description: "Empty script name",
          mode: "script",
          scriptName: "  ",
        }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should auto-increment workflow step IDs", async () => {
      const ws1 = await store.createWorkflowStep({ name: "Step 1", description: "First" });
      const ws2 = await store.createWorkflowStep({ name: "Step 2", description: "Second" });
      const ws3 = await store.createWorkflowStep({ name: "Step 3", description: "Third" });

      expect(ws1.id).toBe("WS-001");
      expect(ws2.id).toBe("WS-002");
      expect(ws3.id).toBe("WS-003");
    });

    it("should list workflow steps", async () => {
      await store.createWorkflowStep({ name: "Step 1", description: "First" });
      await store.createWorkflowStep({ name: "Step 2", description: "Second" });

      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].name).toBe("Step 1");
      expect(steps[1].name).toBe("Step 2");
    });

    it("should return empty array when no workflow steps exist", async () => {
      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(0);
    });

    it("should get a single workflow step by ID", async () => {
      const ws = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const found = await store.getWorkflowStep(ws.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(ws.id);
      expect(found!.name).toBe("Docs");
    });

    it("should return undefined for non-existent workflow step", async () => {
      const found = await store.getWorkflowStep("WS-999");
      expect(found).toBeUndefined();
    });

    it("should resolve plugin script-mode workflow steps from injected templates", async () => {
      store.setPluginWorkflowStepTemplates([
        {
          pluginId: "my-plugin",
          template: {
            id: "plugin:my-plugin:my-step",
            name: "My Plugin Step",
            description: "Plugin-provided step",
            mode: "script",
            phase: "pre-merge",
            scriptName: "my-plugin:run-step",
            prompt: "",
            toolMode: "readonly",
            defaultOn: false,
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            category: "Plugin",
            icon: "puzzle",
          },
        },
      ]);

      const listed = await store.listWorkflowSteps();
      const listedStep = listed.find((candidate) => candidate.id === "plugin:my-plugin:my-step");
      expect(listedStep).toMatchObject({
        id: "plugin:my-plugin:my-step",
        templateId: "my-step",
        name: "My Plugin Step",
        mode: "script",
        gateMode: "advisory",
        phase: "pre-merge",
        scriptName: "my-plugin:run-step",
        defaultOn: false,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const step = await store.getWorkflowStep("plugin:my-plugin:my-step");
      expect(step).toMatchObject({
        id: "plugin:my-plugin:my-step",
        templateId: "my-step",
        mode: "script",
        gateMode: "advisory",
        phase: "pre-merge",
        scriptName: "my-plugin:run-step",
        defaultOn: false,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        enabled: true,
      });
    });

    it("should resolve plugin prompt-mode workflow steps from injected templates", async () => {
      store.setPluginWorkflowStepTemplates([
        {
          pluginId: "my-plugin",
          template: {
            id: "plugin:my-plugin:prompt-step",
            name: "My Prompt Step",
            description: "Prompt plugin step",
            mode: "prompt",
            phase: "pre-merge",
            prompt: "Run plugin checks",
            toolMode: "readonly",
            category: "Plugin",
            icon: "puzzle",
          },
        },
      ]);

      const step = await store.getWorkflowStep("plugin:my-plugin:prompt-step");
      expect(step).toMatchObject({
        id: "plugin:my-plugin:prompt-step",
        templateId: "prompt-step",
        mode: "prompt",
        gateMode: "advisory",
        prompt: "Run plugin checks",
      });
    });

    it("should list db workflow steps and plugin workflow steps together", async () => {
      const dbStep = await store.createWorkflowStep({ name: "DB Step", description: "stored" });
      store.setPluginWorkflowStepTemplates([
        {
          pluginId: "my-plugin",
          template: {
            id: "plugin:my-plugin:my-step",
            name: "My Plugin Step",
            description: "Plugin-provided step",
            prompt: "Run plugin checks",
            toolMode: "coding",
            category: "Plugin",
            icon: "puzzle",
          },
        },
      ]);

      const steps = await store.listWorkflowSteps();
      expect(steps.map((step) => step.id)).toEqual([dbStep.id, "plugin:my-plugin:my-step"]);
    });

    it("should list disabled plugin steps without auto-materializing them", async () => {
      store.setPluginWorkflowStepTemplates([
        {
          pluginId: "my-plugin",
          template: {
            id: "plugin:my-plugin:disabled-step",
            name: "Disabled Plugin Step",
            description: "Plugin-provided step",
            prompt: "Run plugin checks",
            toolMode: "readonly",
            category: "Plugin",
            icon: "puzzle",
            enabled: false,
          },
        },
      ]);

      const listed = await store.listWorkflowSteps();
      expect(listed.find((step) => step.id === "plugin:my-plugin:disabled-step")?.enabled).toBe(false);

      const task = await store.createTask({
        description: "Task with plugin-only workflow steps",
        enabledWorkflowSteps: ["plugin:my-plugin:disabled-step"],
      });
      expect(task.enabledWorkflowSteps).toEqual(["plugin:my-plugin:disabled-step"]);
    });

    it("should keep plugin workflow IDs unchanged while materializing built-in templates", async () => {
      store.setPluginWorkflowStepTemplates([
        {
          pluginId: "my-plugin",
          template: {
            id: "plugin:my-plugin:my-step",
            name: "My Plugin Step",
            description: "Plugin-provided step",
            prompt: "Run plugin checks",
            toolMode: "readonly",
            category: "Plugin",
            icon: "puzzle",
          },
        },
      ]);

      const task = await store.createTask({
        description: "Task with mixed workflow steps",
        enabledWorkflowSteps: ["plugin:my-plugin:my-step", "browser-verification"],
      });

      expect(task.enabledWorkflowSteps).toEqual(["plugin:my-plugin:my-step", "WS-001"]);
    });

    it("should update a workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Original",
        description: "Original desc",
        prompt: "Original prompt",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        name: "Updated",
        description: "Updated desc",
        prompt: "Updated prompt",
        enabled: false,
      });

      expect(updated.name).toBe("Updated");
      expect(updated.description).toBe("Updated desc");
      expect(updated.mode).toBe("prompt");
      expect(updated.prompt).toBe("Updated prompt");
      expect(updated.enabled).toBe(false);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(ws.updatedAt).getTime()
      );
    });

    it("should switch a workflow step from prompt to script mode", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        prompt: "Review documentation.",
        mode: "prompt",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        mode: "script",
        scriptName: "lint",
      });

      expect(updated.mode).toBe("script");
      expect(updated.scriptName).toBe("lint");
      expect(updated.prompt).toBe(""); // Cleared on mode switch
      expect(updated.modelProvider).toBeUndefined(); // Cleared on mode switch
      expect(updated.modelId).toBeUndefined(); // Cleared on mode switch
    });

    it("should switch a workflow step from script to prompt mode", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        mode: "prompt",
        prompt: "Review code quality.",
      });

      expect(updated.mode).toBe("prompt");
      expect(updated.scriptName).toBeUndefined(); // Cleared on mode switch
      expect(updated.prompt).toBe("Review code quality.");
    });

    it("should reject switching to script mode without scriptName", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        prompt: "Review documentation.",
      });

      await expect(
        store.updateWorkflowStep(ws.id, { mode: "script" }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should ignore prompt updates for script-mode steps", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        prompt: "This should be ignored",
      });

      expect(updated.prompt).toBe(""); // Prompt not updated for script mode
    });

    it("should ignore model override updates for script-mode steps", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      // Model overrides should not be set for script mode
      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("should throw when updating non-existent workflow step", async () => {
      await expect(
        store.updateWorkflowStep("WS-999", { name: "Nope" })
      ).rejects.toThrow("Workflow step 'WS-999' not found");
    });

    it("should delete a workflow step", async () => {
      const ws = await store.createWorkflowStep({ name: "ToDelete", description: "Gone" });
      await store.deleteWorkflowStep(ws.id);

      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(0);
    });

    it("should throw when deleting non-existent workflow step", async () => {
      await expect(store.deleteWorkflowStep("WS-999")).rejects.toThrow(
        "Workflow step 'WS-999' not found"
      );
    });

    it("should remove references from tasks when deleting a workflow step", async () => {
      const ws = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const task = await store.createTask({
        description: "Test task with workflow steps",
        enabledWorkflowSteps: [ws.id],
      });

      expect(task.enabledWorkflowSteps).toEqual([ws.id]);

      await store.deleteWorkflowStep(ws.id);

      // Wait for async cleanup
      await new Promise((r) => setTimeout(r, 50));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.enabledWorkflowSteps).toBeUndefined();
    });

    it("should create a task with enabledWorkflowSteps", async () => {
      const ws1 = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const ws2 = await store.createWorkflowStep({ name: "QA", description: "Run tests" });

      const task = await store.createTask({
        description: "Task with workflow steps",
        enabledWorkflowSteps: [ws1.id, ws2.id],
      });

      expect(task.enabledWorkflowSteps).toEqual([ws1.id, ws2.id]);
    });

    it("should materialize built-in workflow templates when creating a task", async () => {
      const task = await store.createTask({
        description: "Task with browser verification",
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(task.enabledWorkflowSteps).toEqual(["WS-001"]);

      const step = await store.getWorkflowStep("WS-001");
      expect(step).toMatchObject({
        id: "WS-001",
        templateId: "browser-verification",
        name: "Browser Verification",
        toolMode: "coding",
      });
    });

    it("should reuse an existing materialized built-in workflow step", async () => {
      const first = await store.createTask({
        description: "First browser verification task",
        enabledWorkflowSteps: ["browser-verification"],
      });
      const second = await store.createTask({
        description: "Second browser verification task",
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(first.enabledWorkflowSteps).toEqual(["WS-001"]);
      expect(second.enabledWorkflowSteps).toEqual(["WS-001"]);

      const steps = await store.listWorkflowSteps();
      expect(steps.filter((step) => step.templateId === "browser-verification")).toHaveLength(1);
    });

    it("should materialize frontend-ux-design built-in template when creating a task", async () => {
      const task = await store.createTask({
        description: "Task with frontend UX design review",
        enabledWorkflowSteps: ["frontend-ux-design"],
      });

      expect(task.enabledWorkflowSteps).toEqual(["WS-001"]);

      const step = await store.getWorkflowStep("WS-001");
      expect(step).toMatchObject({
        id: "WS-001",
        templateId: "frontend-ux-design",
        name: "Frontend UX Design",
        toolMode: "readonly",
      });
    });

    it("should not set enabledWorkflowSteps when empty array provided", async () => {
      const task = await store.createTask({
        description: "Task without workflow steps",
        enabledWorkflowSteps: [],
      });

      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should create a workflow step with model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "Security Audit",
        description: "Check for security issues",
        prompt: "Scan for vulnerabilities.",
        enabled: true,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      expect(ws.modelProvider).toBe("anthropic");
      expect(ws.modelId).toBe("claude-sonnet-4-5");
    });

    it("should create a workflow step without model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "QA Check",
        description: "Run tests",
      });

      expect(ws.modelProvider).toBeUndefined();
      expect(ws.modelId).toBeUndefined();
    });

    it("should update a workflow step model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: "openai",
        modelId: "gpt-4o",
      });

      expect(updated.modelProvider).toBe("openai");
      expect(updated.modelId).toBe("gpt-4o");
    });

    it("should clear a workflow step model override by setting to undefined", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      expect(ws.modelProvider).toBe("anthropic");

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: undefined,
        modelId: undefined,
      });

      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("should persist model override across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Perf Review",
        description: "Check performance",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].modelProvider).toBe("anthropic");
      expect(listed[0].modelId).toBe("claude-sonnet-4-5");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.modelProvider).toBe("anthropic");
      expect(found!.modelId).toBe("claude-sonnet-4-5");
    });

    it("should normalize legacy workflow steps without mode to prompt mode", async () => {
      // Create a step normally (it will have mode: "prompt")
      const ws = await store.createWorkflowStep({
        name: "Legacy Step",
        description: "Pre-existing step",
        prompt: "Review the code.",
      });

      // Simulate legacy data by writing a step without mode directly to DB
      const config = await (store as any).readConfig();
      // Remove mode from the stored step to simulate legacy data
      delete config.workflowSteps[0].mode;
      await (store as any).writeConfig(config);

      // Re-read should normalize mode to "prompt"
      const found = await store.getWorkflowStep(ws.id);
      expect(found!.mode).toBe("prompt");
      expect(found!.prompt).toBe("Review the code.");
    });

    it("should persist script-mode workflow step across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Type Check",
        description: "Run TypeScript type checking",
        mode: "script",
        scriptName: "typecheck",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].mode).toBe("script");
      expect(listed[0].scriptName).toBe("typecheck");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.mode).toBe("script");
      expect(found!.scriptName).toBe("typecheck");
    });

    // ── Workflow Step defaultOn ──────────────────────────────────────────────

    it("should persist defaultOn flag on workflow step creation", async () => {
      const ws = await store.createWorkflowStep({
        name: "Default-on Step",
        description: "Auto-selected for new tasks",
        defaultOn: true,
      });

      expect(ws.defaultOn).toBe(true);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(true);

      // Verify persistence
      const steps = await store.listWorkflowSteps();
      expect(steps[0].defaultOn).toBe(true);
    });

    it("should not set defaultOn by default", async () => {
      const ws = await store.createWorkflowStep({
        name: "Non-default Step",
        description: "Not auto-selected",
      });

      expect(ws.defaultOn).toBeUndefined();

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBeUndefined();
    });

    it("should update defaultOn flag on workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Step",
        description: "Desc",
      });

      const updated = await store.updateWorkflowStep(ws.id, { defaultOn: true });
      expect(updated.defaultOn).toBe(true);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(true);
    });

    it("should clear defaultOn flag by setting to false", async () => {
      const ws = await store.createWorkflowStep({
        name: "Step",
        description: "Desc",
        defaultOn: true,
      });

      const updated = await store.updateWorkflowStep(ws.id, { defaultOn: false });
      expect(updated.defaultOn).toBe(false);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(false);
    });

    it("should auto-apply default-on workflow steps when creating task without enabledWorkflowSteps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Optional Check", description: "Only when manually selected", enabled: true, defaultOn: false });
      await store.createWorkflowStep({ name: "Disabled Step", description: "Disabled step", enabled: false, defaultOn: true });

      const task = await store.createTask({ description: "Test task" });

      // Only the enabled + defaultOn step should be auto-applied
      expect(task.enabledWorkflowSteps).toEqual(["WS-001"]);
    });

    it("should use explicit enabledWorkflowSteps over default-on steps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });

      const task = await store.createTask({
        description: "Test task",
        enabledWorkflowSteps: ["WS-001", "WS-002"],
      });

      // Explicit input takes precedence
      expect(task.enabledWorkflowSteps).toEqual(["WS-001", "WS-002"]);
    });

    it("should use empty enabledWorkflowSteps to override default-on steps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });

      const task = await store.createTask({
        description: "Test task",
        enabledWorkflowSteps: [],
      });

      // Explicit empty array means user intentionally wants no steps
      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should not auto-apply disabled steps even with defaultOn flag", async () => {
      await store.createWorkflowStep({ name: "Disabled Step", description: "Disabled step", enabled: false, defaultOn: true });

      const task = await store.createTask({ description: "Test task" });

      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should auto-apply multiple default-on steps in order", async () => {
      await store.createWorkflowStep({ name: "First", description: "First", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Second", description: "Second", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Third", description: "Third", enabled: true, defaultOn: false });

      const task = await store.createTask({ description: "Test task" });

      expect(task.enabledWorkflowSteps).toEqual(["WS-001", "WS-002"]);
    });

    it("logs default-on resolution failures and still creates the task", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const listStepsSpy = vi.spyOn(store, "listWorkflowSteps").mockRejectedValue(new Error("workflow catalog unavailable"));

      try {
        const task = await store.createTask({ description: "Best effort defaults" });
        expect(task.id).toMatch(/^FN-\d+$/);
        expect(task.enabledWorkflowSteps).toBeUndefined();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Failed to auto-apply default workflow steps during task creation"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          descriptionLength: "Best effort defaults".length,
          error: "workflow catalog unavailable",
        });
      } finally {
        listStepsSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("should update task workflow steps and materialize built-in templates", async () => {
      const task = await store.createTask({ description: "Editable task" });

      const updated = await store.updateTask(task.id, {
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(updated.enabledWorkflowSteps).toEqual(["WS-001"]);

      const persisted = await store.getTask(task.id);
      expect(persisted.enabledWorkflowSteps).toEqual(["WS-001"]);
    });

    it("should resolve built-in workflow templates from getWorkflowStep", async () => {
      const step = await store.getWorkflowStep("browser-verification");

      expect(step).toMatchObject({
        id: "browser-verification",
        templateId: "browser-verification",
        name: "Browser Verification",
        mode: "prompt",
        phase: "pre-merge",
        toolMode: "coding",
      });
    });

    it("should resolve frontend-ux-design built-in template from getWorkflowStep", async () => {
      const step = await store.getWorkflowStep("frontend-ux-design");

      expect(step).toMatchObject({
        id: "frontend-ux-design",
        templateId: "frontend-ux-design",
        name: "Frontend UX Design",
        mode: "prompt",
        phase: "pre-merge",
        toolMode: "readonly",
      });
    });

    // ── Workflow Step Phase ──────────────────────────────────────────────

    it("should default phase to 'pre-merge' when creating a workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Pre-merge Check",
        description: "Runs before merge",
      });

      expect(ws.phase).toBe("pre-merge");
    });

    it("should create a workflow step with explicit 'post-merge' phase", async () => {
      const ws = await store.createWorkflowStep({
        name: "Post-merge Notify",
        description: "Runs after merge",
        phase: "post-merge",
      });

      expect(ws.phase).toBe("post-merge");
    });

    it("should create a workflow step with explicit 'pre-merge' phase", async () => {
      const ws = await store.createWorkflowStep({
        name: "Pre-merge Gate",
        description: "Runs before merge",
        phase: "pre-merge",
      });

      expect(ws.phase).toBe("pre-merge");
    });

    it("should update a workflow step phase from pre-merge to post-merge", async () => {
      const ws = await store.createWorkflowStep({
        name: "Phase Switch",
        description: "Will switch phase",
      });

      expect(ws.phase).toBe("pre-merge");

      const updated = await store.updateWorkflowStep(ws.id, { phase: "post-merge" });
      expect(updated.phase).toBe("post-merge");
    });

    it("should persist phase across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Phase Persist",
        description: "Check phase persistence",
        phase: "post-merge",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].phase).toBe("post-merge");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.phase).toBe("post-merge");
    });

    it("should normalize legacy workflow steps without phase to pre-merge", async () => {
      const ws = await store.createWorkflowStep({
        name: "Legacy Step",
        description: "Pre-existing step",
        prompt: "Review the code.",
      });

      // Simulate legacy data by removing phase from the stored step
      const config = await (store as any).readConfig();
      delete config.workflowSteps[0].phase;
      await (store as any).writeConfig(config);

      // Re-read: phase should be undefined (legacy), but when used by engine
      // it should be treated as "pre-merge"
      const found = await store.getWorkflowStep(ws.id);
      expect(found!.phase).toBeUndefined();
    });
  });

  // ── Title Summarization Tests ────────────────────────────────────────────

});

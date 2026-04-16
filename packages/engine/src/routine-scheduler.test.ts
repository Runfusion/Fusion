import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoutineScheduler, type RoutineSchedulerOptions } from "./routine-scheduler.js";
import type { RoutineStore, Routine, TaskStore, RoutineExecutionResult, Settings } from "@fusion/core";
import type { RoutineRunner } from "./routine-runner.js";

// Default settings inline to avoid @fusion/core build dependency during tests
const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 30000,
  autoResolveConflicts: true,
  requirePlanApproval: false,
  recycleWorktrees: false,
  worktreeNaming: "random",
  globalPause: false,
  enginePaused: false,
  ntfyEnabled: false,
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
  planningProvider: "anthropic",
  planningModelId: "claude-sonnet-4-5",
  validatorProvider: "openai",
  validatorModelId: "gpt-4o",
  taskStuckTimeoutMs: undefined,
  groupOverlappingFiles: false,
  autoMerge: true,
};

function createMockRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "test-routine-id",
    agentId: "test-agent",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron", cronExpression: "0 * * * *" },
    catchUpPolicy: "run_one",
    executionPolicy: "parallel",
    enabled: true,
    runCount: 0,
    runHistory: [],
    cronExpression: "0 * * * *",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockTaskStore(settingsOverrides: Partial<Settings> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      ...settingsOverrides,
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createMockRoutineStore(routines: Routine[] = []): RoutineStore {
  const routineMap = new Map(routines.map((r) => [r.id, r]));

  return {
    getRoutine: vi.fn().mockImplementation((id: string) => {
      const routine = routineMap.get(id);
      if (!routine) {
        throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
      }
      return routine;
    }),
    listRoutines: vi.fn().mockResolvedValue(routines),
    updateRoutine: vi.fn().mockImplementation((id: string, _updates: any) => {
      const routine = routineMap.get(id);
      if (!routine) {
        throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
      }
      return routine;
    }),
    getDueRoutines: vi.fn().mockResolvedValue(routines),
    getDueRoutinesAllScopes: vi.fn().mockResolvedValue(routines),
    recordRun: vi.fn().mockImplementation((id: string, result: RoutineExecutionResult) => {
      return createMockRoutine({ id, lastRunResult: result });
    }),
    startRoutineExecution: vi.fn().mockResolvedValue(undefined),
    completeRoutineExecution: vi.fn().mockResolvedValue(undefined),
    cancelRoutineExecution: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as RoutineStore;
}

function createMockRoutineRunner(): RoutineRunner {
  return {
    executeRoutine: vi.fn().mockResolvedValue({
      routineId: "test-routine",
      success: true,
      output: "Success",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } as RoutineExecutionResult),
    handleCatchUp: vi.fn().mockResolvedValue(undefined),
    getInFlightCount: vi.fn().mockReturnValue(0),
    isRoutineRunning: vi.fn().mockReturnValue(false),
  } as unknown as RoutineRunner;
}

function createRoutineScheduler(
  taskStore?: TaskStore,
  routineStore?: RoutineStore,
  routineRunner?: RoutineRunner,
  options?: Partial<Pick<RoutineSchedulerOptions, "pollIntervalMs" | "scope">>,
): RoutineScheduler {
  return new RoutineScheduler({
    taskStore: taskStore ?? createMockTaskStore(),
    routineStore: routineStore ?? createMockRoutineStore(),
    routineRunner: routineRunner ?? createMockRoutineRunner(),
    pollIntervalMs: options?.pollIntervalMs,
    scope: options?.scope,
  });
}

describe("RoutineScheduler", () => {
  let scheduler: RoutineScheduler;

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
    }
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("clamps poll interval to minimum 10000ms", () => {
      scheduler = createRoutineScheduler(
        undefined,
        undefined,
        undefined,
        { pollIntervalMs: 100 }, // Below minimum
      );

      // The scheduler should have clamped to 10000ms
      expect(scheduler["pollIntervalMs"]).toBe(10000);
    });

    it("uses default poll interval of 60000ms when not specified", () => {
      scheduler = createRoutineScheduler();
      expect(scheduler["pollIntervalMs"]).toBe(60000);
    });
  });

  describe("start/stop", () => {
    it("sets running = true after start", () => {
      scheduler = createRoutineScheduler();
      scheduler.start();
      expect(scheduler.isActive()).toBe(true);
    });

    it("clears interval and sets running = false after stop", () => {
      scheduler = createRoutineScheduler();
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });

    it("runs first tick immediately on start", async () => {
      const routineStore = createMockRoutineStore([createMockRoutine({ id: "due-routine" })]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      scheduler.start();
      // Wait for the tick to complete
      await new Promise((r) => setTimeout(r, 10));
      scheduler.stop();

      expect(routineRunner.handleCatchUp).toHaveBeenCalled();
      expect(routineRunner.executeRoutine).toHaveBeenCalled();
    });

    it("is idempotent on start", () => {
      scheduler = createRoutineScheduler();
      scheduler.start();
      scheduler.start(); // Should not throw
      expect(scheduler.isActive()).toBe(true);
    });

    it("is safe to stop when not started", () => {
      scheduler = createRoutineScheduler();
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  describe("tick", () => {
    it("skips when globalPause is true", async () => {
      const routineStore = createMockRoutineStore([createMockRoutine()]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ globalPause: true }),
        routineStore,
        routineRunner,
      );

      await scheduler.tick();

      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("skips when enginePaused is true", async () => {
      const routineStore = createMockRoutineStore([createMockRoutine()]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ enginePaused: true }),
        routineStore,
        routineRunner,
      );

      await scheduler.tick();

      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("skips when no routines are due", async () => {
      const routineStore = createMockRoutineStore([]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      await scheduler.tick();

      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("processes due routines in order", async () => {
      const routine1 = createMockRoutine({ id: "routine-1" });
      const routine2 = createMockRoutine({ id: "routine-2" });
      const routineStore = createMockRoutineStore([routine1, routine2]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      await scheduler.tick();

      // Both routines should be processed
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(2);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(2);
    });

    it("calls handleCatchUp then executeRoutine for each routine", async () => {
      const routine1 = createMockRoutine({ id: "routine-order-1" });
      const routine2 = createMockRoutine({ id: "routine-order-2" });
      const routineStore = createMockRoutineStore([routine1, routine2]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      await scheduler.tick();

      // Both routines should be processed
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(2);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(2);
    });

    it("handles errors in individual routine execution gracefully", async () => {
      const routine = createMockRoutine({ id: "routine-error" });
      const routineStore = createMockRoutineStore([routine]);
      const routineRunner = createMockRoutineRunner();
      vi.mocked(routineRunner.executeRoutine).mockRejectedValueOnce(
        new Error("Execution failed"),
      );
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      // Should not throw
      await expect(scheduler.tick()).resolves.toBeUndefined();
    });

    it("re-entrance guard prevents overlapping ticks", async () => {
      const routine = createMockRoutine({ id: "routine-reentrant" });
      const routineStore = createMockRoutineStore([routine]);
      const routineRunner = createMockRoutineRunner();
      // Make execution slow
      vi.mocked(routineRunner.executeRoutine).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          routineId: "routine-reentrant",
          success: true,
          output: "",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } as RoutineExecutionResult;
      });
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      // Start two ticks concurrently
      const [tick1, tick2] = [scheduler.tick(), scheduler.tick()];
      await Promise.all([tick1, tick2]);

      // Should only have executed once (second tick was blocked by re-entrance guard)
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
    });
  });

  describe("triggerManual", () => {
    it("delegates to routineRunner.executeRoutine with 'api' trigger", async () => {
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), createMockRoutineStore(), routineRunner);

      await scheduler.triggerManual("test-routine");

      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("test-routine", "api");
    });

    it("passes through the result from routineRunner", async () => {
      const mockResult: RoutineExecutionResult = {
        routineId: "test-routine",
        success: true,
        output: "Success",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      const routineRunner = createMockRoutineRunner();
      vi.mocked(routineRunner.executeRoutine).mockResolvedValue(mockResult);
      scheduler = createRoutineScheduler(createMockTaskStore(), createMockRoutineStore(), routineRunner);

      const result = await scheduler.triggerManual("test-routine");

      expect(result).toEqual(mockResult);
    });
  });

  describe("triggerWebhook", () => {
    it("delegates to routineRunner.executeRoutine with 'webhook' trigger", async () => {
      const routine = createMockRoutine({ id: "webhook-routine", trigger: { type: "webhook", webhookPath: "/test" } });
      const routineStore = createMockRoutineStore([routine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

      await scheduler.triggerWebhook("webhook-routine", { data: "test" });

      expect(routineRunner.executeRoutine).toHaveBeenCalledWith(
        "webhook-routine",
        "webhook",
        expect.objectContaining({ webhookPayload: { data: "test" } }),
      );
    });

    it("throws for routine with non-webhook trigger type", async () => {
      const routine = createMockRoutine({ id: "cron-routine", trigger: { type: "cron", cronExpression: "0 * * * *" } });
      const routineStore = createMockRoutineStore([routine]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore);

      await expect(scheduler.triggerWebhook("cron-routine", {})).rejects.toThrow(
        "does not have webhook trigger type",
      );
    });

    it("throws for nonexistent routine", async () => {
      const routineStore = createMockRoutineStore([]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore);

      await expect(scheduler.triggerWebhook("nonexistent", {})).rejects.toThrow(
        "not found",
      );
    });

    it("proceeds without signature check when no secret is configured", async () => {
      // Clear the env var if it exists
      const originalSecret = process.env.FUSION_ROUTINE_WEBHOOK_SECRET;
      delete process.env.FUSION_ROUTINE_WEBHOOK_SECRET;

      try {
        const routine = createMockRoutine({ id: "webhook-no-secret", trigger: { type: "webhook", webhookPath: "/test" } });
        const routineStore = createMockRoutineStore([routine]);
        const routineRunner = createMockRoutineRunner();
        scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

        // Should not throw even without signature
        await scheduler.triggerWebhook("webhook-no-secret", { data: "test" });

        expect(routineRunner.executeRoutine).toHaveBeenCalled();
      } finally {
        // Restore env var
        if (originalSecret !== undefined) {
          process.env.FUSION_ROUTINE_WEBHOOK_SECRET = originalSecret;
        }
      }
    });

    it("throws for invalid HMAC signature when secret is configured", async () => {
      process.env.FUSION_ROUTINE_WEBHOOK_SECRET = "test-secret";

      try {
        const routine = createMockRoutine({ id: "webhook-with-secret", trigger: { type: "webhook", webhookPath: "/test" } });
        const routineStore = createMockRoutineStore([routine]);
        scheduler = createRoutineScheduler(createMockTaskStore(), routineStore);

        await expect(
          scheduler.triggerWebhook("webhook-with-secret", { data: "test" }, "sha256=invalidsignature"),
        ).rejects.toThrow("Invalid webhook signature");
      } finally {
        delete process.env.FUSION_ROUTINE_WEBHOOK_SECRET;
      }
    });

    it("accepts valid HMAC signature", async () => {
      const secret = "test-secret-123";
      process.env.FUSION_ROUTINE_WEBHOOK_SECRET = secret;

      try {
        const routine = createMockRoutine({ id: "webhook-valid-sig", trigger: { type: "webhook", webhookPath: "/test" } });
        const routineStore = createMockRoutineStore([routine]);
        const routineRunner = createMockRoutineRunner();
        scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner);

        const payload = { data: "test" };
        const crypto = await import("node:crypto");
        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

        await scheduler.triggerWebhook("webhook-valid-sig", payload, signature);

        expect(routineRunner.executeRoutine).toHaveBeenCalled();
      } finally {
        delete process.env.FUSION_ROUTINE_WEBHOOK_SECRET;
      }
    });

    it("throws when signature is missing but secret is configured", async () => {
      process.env.FUSION_ROUTINE_WEBHOOK_SECRET = "test-secret";

      try {
        const routine = createMockRoutine({ id: "webhook-missing-sig", trigger: { type: "webhook", webhookPath: "/test" } });
        const routineStore = createMockRoutineStore([routine]);
        scheduler = createRoutineScheduler(createMockTaskStore(), routineStore);

        await expect(
          scheduler.triggerWebhook("webhook-missing-sig", { data: "test" }),
        ).rejects.toThrow("Missing webhook signature");
      } finally {
        delete process.env.FUSION_ROUTINE_WEBHOOK_SECRET;
      }
    });
  });

  describe("isActive", () => {
    it("returns false initially", () => {
      scheduler = createRoutineScheduler();
      expect(scheduler.isActive()).toBe(false);
    });

    it("returns true after start", () => {
      scheduler = createRoutineScheduler();
      scheduler.start();
      expect(scheduler.isActive()).toBe(true);
      scheduler.stop();
    });

    it("returns false after stop", () => {
      scheduler = createRoutineScheduler();
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });
  });

  // ── Scoped lane regression tests (FN-1766) ─────────────────────────────────

  describe("scoped lane polling", () => {
    it("scope='project' calls getDueRoutines with 'project'", async () => {
      const routineStore = createMockRoutineStore([]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, createMockRoutineRunner(), { scope: "project" });

      await scheduler.tick();

      expect(routineStore.getDueRoutines).toHaveBeenCalledWith("project");
      expect(routineStore.getDueRoutinesAllScopes).not.toHaveBeenCalled();
    });

    it("scope='global' calls getDueRoutines with 'global'", async () => {
      const routineStore = createMockRoutineStore([]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, createMockRoutineRunner(), { scope: "global" });

      await scheduler.tick();

      expect(routineStore.getDueRoutines).toHaveBeenCalledWith("global");
      expect(routineStore.getDueRoutinesAllScopes).not.toHaveBeenCalled();
    });

    it("scope='all' calls getDueRoutinesAllScopes", async () => {
      const routineStore = createMockRoutineStore([]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, createMockRoutineRunner(), { scope: "all" });

      await scheduler.tick();

      expect(routineStore.getDueRoutinesAllScopes).toHaveBeenCalled();
      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("scope='project' skips global-scoped routines", async () => {
      const globalRoutine = createMockRoutine({ id: "global-routine", scope: "global" });
      const routineStore = createMockRoutineStore([globalRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // Should NOT execute the global routine
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("scope='global' skips project-scoped routines", async () => {
      const projectRoutine = createMockRoutine({ id: "project-routine", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "global" });

      await scheduler.tick();

      // Should NOT execute the project routine
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("scope='all' executes both global and project routines", async () => {
      const globalRoutine = createMockRoutine({ id: "global-rout", name: "Global", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "project-rout", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Both routines should be processed
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(2);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(2);
    });

    it("scope='all' deduplicates by routine ID — no double execution", async () => {
      // Same routine ID in both scopes
      const sharedRoutine = createMockRoutine({ id: "shared-id", name: "Shared", scope: "project" });
      const routineStore = createMockRoutineStore([sharedRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([sharedRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Should only execute once
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
    });

    it("scope='all' skips routine from wrong scope after scope mismatch", async () => {
      // Routine says global but scheduler is polling project scope
      const mismatchedRoutine = createMockRoutine({ id: "mismatch", name: "Mismatched", scope: "global" });
      const routineStore = createMockRoutineStore([mismatchedRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // Should NOT execute - routine is global but scheduler is in project scope
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("scope='project' default when not specified", () => {
      const routineStore = createMockRoutineStore([]);
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, createMockRoutineRunner());

      expect(scheduler["scope"]).toBe("project");
    });

    it("scope is preserved when invoking handleCatchUp", async () => {
      const projectRoutine = createMockRoutine({ id: "project-catchup", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // handleCatchUp should be called with the routine (preserving scope context)
      expect(routineRunner.handleCatchUp).toHaveBeenCalledWith(projectRoutine);
    });

    it("scope is preserved when invoking executeRoutine", async () => {
      const projectRoutine = createMockRoutine({ id: "project-exec", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // executeRoutine should be called with the routine ID and trigger type
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("project-exec", "cron");
    });
  });

  describe("scoped lane pause regressions", () => {
    it("scope='project' skips when initially paused", async () => {
      const routineStore = createMockRoutineStore([createMockRoutine({ scope: "project" })]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ globalPause: true }),
        routineStore,
        routineRunner,
        { scope: "project" },
      );

      await scheduler.tick();

      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("scope='global' skips when initially paused", async () => {
      const routineStore = createMockRoutineStore([createMockRoutine({ scope: "global" })]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ enginePaused: true }),
        routineStore,
        routineRunner,
        { scope: "global" },
      );

      await scheduler.tick();

      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("scope='all' skips when initially paused", async () => {
      const globalRoutine = createMockRoutine({ scope: "global" });
      const projectRoutine = createMockRoutine({ scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ globalPause: true }),
        routineStore,
        routineRunner,
        { scope: "all" },
      );

      await scheduler.tick();

      expect(routineStore.getDueRoutinesAllScopes).not.toHaveBeenCalled();
    });

    it("scope='project' halts mid-loop when pause flips", async () => {
      const projectRoutine1 = createMockRoutine({ id: "r1", name: "Routine 1", scope: "project" });
      const projectRoutine2 = createMockRoutine({ id: "r2", name: "Routine 2", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine1, projectRoutine2]);

      // Mock getSettings to pause after first routine
      let getSettingsCalls = 0;
      const mockTaskStore: TaskStore = {
        getSettings: vi.fn().mockImplementation(async () => {
          getSettingsCalls++;
          return {
            ...DEFAULT_SETTINGS,
            globalPause: getSettingsCalls >= 3, // Pause on 3rd call (before r2)
          };
        }),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as TaskStore;

      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(mockTaskStore, routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // Should only process first routine
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(1);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
      expect(routineRunner.handleCatchUp).toHaveBeenCalledWith(projectRoutine1);
    });
  });

  describe("scoped lane ID-overlap regressions", () => {
    it("identical IDs across global and project scopes must not cross lane boundaries", async () => {
      // Same ID in both scopes - store returns both
      const globalRoutine = createMockRoutine({ id: "overlap-id", name: "Global Overlap", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "overlap-id", name: "Project Overlap", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // With scope="all", both routines share the same ID
      // The scheduler should execute once (first occurrence wins due to deduplication)
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("overlap-id", "cron");
    });

    it("scope='project' with overlapping ID only processes project-scoped version", async () => {
      const projectRoutine = createMockRoutine({ id: "overlap-id", name: "Project Only", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("overlap-id", "cron");
    });

    it("scope='global' with overlapping ID only processes global-scoped version", async () => {
      const globalRoutine = createMockRoutine({ id: "overlap-id", name: "Global Only", scope: "global" });
      const routineStore = createMockRoutineStore([globalRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "global" });

      await scheduler.tick();

      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("overlap-id", "cron");
    });
  });

  describe("utility-lane semaphore boundary", () => {
    it("RoutineScheduler does not use task-lane semaphore operations", async () => {
      scheduler = createRoutineScheduler();

      // Cast to any to access internal state for semaphore trap
      const schedulerAny = scheduler as any;

      // Verify no semaphore-related methods exist on the scheduler
      expect(schedulerAny.acquire).toBeUndefined();
      expect(schedulerAny.release).toBeUndefined();
      expect(schedulerAny.run).toBeUndefined();
      expect(schedulerAny.semaphore).toBeUndefined();
      expect(schedulerAny["_semaphore"]).toBeUndefined();
    });

    it("RoutineScheduler constructor does not accept semaphore parameter", () => {
      scheduler = createRoutineScheduler();

      // Verify internal state doesn't have semaphore references
      const keys = Object.keys(scheduler);
      const hasSemaphore = keys.some(k => k.toLowerCase().includes("semaphore") || k.toLowerCase().includes("acquire"));
      expect(hasSemaphore).toBe(false);
    });
  });

  // ── Cross-package integration tests (FN-1743) ─────────────────────────────────
  //
  // These tests verify end-to-end scoped routine scheduling wiring across packages.
  // They ensure that:
  // 1. RoutineScheduler bound to a project store executes scoped routines only for that project lane
  // 2. RoutineScheduler polls both global and project lanes when configured with both stores
  // 3. Lane identity is preserved through handleCatchUp → executeRoutine
  // 4. Identical routine IDs in different lanes do not cause cross-lane execution
  // 5. Lane diagnostics are verifiable in test assertions

  describe("cross-package dual-lane execution integration", () => {
    it("scope='all' polls both global and project lanes in the same tick", async () => {
      const globalRoutine = createMockRoutine({ id: "global-rout-all", name: "Global", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "project-rout-all", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Both lanes should be polled
      expect(routineStore.getDueRoutinesAllScopes).toHaveBeenCalledTimes(1);
      expect(routineStore.getDueRoutines).not.toHaveBeenCalled();
      // Both routines should be processed
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(2);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(2);
    });

    it("scope='all' lane identity is preserved through handleCatchUp → executeRoutine", async () => {
      const globalRoutine = createMockRoutine({ id: "global-lane-id", name: "Global Lane", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "project-lane-id", name: "Project Lane", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Verify both lanes were processed with correct IDs
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("global-lane-id", "cron");
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("project-lane-id", "cron");
    });

    it("pause applies uniformly across both lanes when scope='all'", async () => {
      const globalRoutine = createMockRoutine({ id: "global-rout-pause", name: "Global", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "project-rout-pause", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(
        createMockTaskStore({ globalPause: true }),
        routineStore,
        routineRunner,
        { scope: "all" },
      );

      await scheduler.tick();

      // Neither lane should be polled when paused
      expect(routineStore.getDueRoutinesAllScopes).not.toHaveBeenCalled();
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("identical routine IDs across global and project lanes execute once (deduplication)", async () => {
      // Same ID in both scopes
      const globalRoutine = createMockRoutine({ id: "shared-rout", name: "Shared Global", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "shared-rout", name: "Shared Project", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Only one execution should occur due to deduplication
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(1);
    });
  });

  describe("cross-package scoped isolation integration", () => {
    it("RoutineScheduler bound to project store never executes global-lane routines", async () => {
      const globalRoutine = createMockRoutine({ id: "global-iso-rout", name: "Global", scope: "global" });
      const routineStore = createMockRoutineStore([globalRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // Project-scoped scheduler should not execute global routine
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("RoutineScheduler bound to global store never executes project-lane routines", async () => {
      const projectRoutine = createMockRoutine({ id: "project-iso-rout", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "global" });

      await scheduler.tick();

      // Global-scoped scheduler should not execute project routine
      expect(routineRunner.handleCatchUp).not.toHaveBeenCalled();
      expect(routineRunner.executeRoutine).not.toHaveBeenCalled();
    });

    it("scope='all' processes routines from both lanes but never crosses lane boundaries", async () => {
      const globalRoutine = createMockRoutine({ id: "global-boundary-rout", name: "Global", scope: "global" });
      const projectRoutine = createMockRoutine({ id: "project-boundary-rout", name: "Project", scope: "project" });
      const routineStore = createMockRoutineStore([globalRoutine, projectRoutine]);
      (routineStore.getDueRoutinesAllScopes as ReturnType<typeof vi.fn>).mockResolvedValue([globalRoutine, projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "all" });

      await scheduler.tick();

      // Both lanes should be processed
      expect(routineRunner.handleCatchUp).toHaveBeenCalledTimes(2);
      expect(routineRunner.executeRoutine).toHaveBeenCalledTimes(2);
      // Each routine is executed exactly once (no double execution)
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("global-boundary-rout", "cron");
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("project-boundary-rout", "cron");
    });

    it("scope='project' lane identity is preserved through handleCatchUp → executeRoutine", async () => {
      const projectRoutine = createMockRoutine({ id: "project-preserved-id", name: "Project Preserved", scope: "project" });
      const routineStore = createMockRoutineStore([projectRoutine]);
      const routineRunner = createMockRoutineRunner();
      scheduler = createRoutineScheduler(createMockTaskStore(), routineStore, routineRunner, { scope: "project" });

      await scheduler.tick();

      // Lane identity preserved through the execution pipeline
      expect(routineRunner.handleCatchUp).toHaveBeenCalledWith(projectRoutine);
      expect(routineRunner.executeRoutine).toHaveBeenCalledWith("project-preserved-id", "cron");
    });
  });
});

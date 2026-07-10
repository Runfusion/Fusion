/**
 * FN-7704: `fn agent stop` / `fn agent start` completed their real work but
 * left the CLI process's event loop alive — `resolveProject()` cached an
 * unclosed `TaskStore` and `createAgentStore()` never closed the
 * `AgentStore` it opened. A caller bounding the subprocess with a timeout
 * (e.g. a recovery watcher) saw this as a "hang" until it force-killed the
 * process at its own 60s ceiling, on every single retry.
 *
 * This test exercises the REAL modules end-to-end (no `@fusion/core` or
 * `project-context.js` mocking) against a temp fixture `.fusion` project so
 * it reproduces the actual leaked-handle condition, not just a mocked
 * approximation of it. It asserts via `process.getActiveResourcesInfo()`
 * that `runAgentStop`/`runAgentStart` do not grow the set of active
 * (keep-alive) resources across the transition path AND the
 * already-in-target-state early-return path, for BOTH commands.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, AgentStore } from "@fusion/core";
import { runAgentStop, runAgentStart } from "../agent.js";

/** Strict bound the exit-determinism assertions must land within (< 15s per FN-7704's symptom-verification contract; the original failure window was 60s). */
const STRICT_BOUND_MS = 15_000;

describe("fn agent stop/start — deterministic process exit (FN-7704)", () => {
  let tempDir: string;
  let originalCwd: string;
  let agentId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fn-7704-agent-exit-"));

    // Bootstrap a real .fusion project dir (fusion.db) so CWD auto-detection
    // in resolveProject()/resolveProjectPathOnly() resolves this temp dir as
    // the project, exercising the REAL TaskStore construction/teardown path.
    const bootstrapStore = new TaskStore(tempDir);
    await bootstrapStore.init();
    await bootstrapStore.close();

    // Seed a real, non-ephemeral agent (starts "active") directly via
    // AgentStore so the CLI command under test operates on real state.
    const seedStore = new AgentStore({ rootDir: join(tempDir, ".fusion") });
    await seedStore.init();
    const agent = await seedStore.createAgent({ name: "fn-7704-fixture-agent", role: "executor" });
    agentId = agent.id;
    seedStore.close();

    originalCwd = process.cwd();
    process.chdir(tempDir);
  }, STRICT_BOUND_MS);

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "runAgentStop (transition path: active -> paused) leaves no net-new active resources",
    async () => {
      const before = process.getActiveResourcesInfo();
      await runAgentStop(agentId);
      const after = process.getActiveResourcesInfo();

      // FN-7704: before the fix, this call left an open AgentStore SQLite
      // handle (and a cached, unclosed TaskStore from project resolution)
      // registered as active resources, which is exactly what kept the CLI
      // process's event loop alive past the point where the real work was
      // done. After the fix, the command's own handles must all be closed
      // by the time it returns.
      expect(after.length).toBeLessThanOrEqual(before.length);
    },
    STRICT_BOUND_MS,
  );

  it(
    "runAgentStop (already-paused early-return path) leaves no net-new active resources",
    async () => {
      const before = process.getActiveResourcesInfo();
      // Agent is already "paused" from the previous test.
      await runAgentStop(agentId);
      const after = process.getActiveResourcesInfo();

      expect(after.length).toBeLessThanOrEqual(before.length);
    },
    STRICT_BOUND_MS,
  );

  it(
    "runAgentStart (transition path: paused -> active) leaves no net-new active resources",
    async () => {
      const before = process.getActiveResourcesInfo();
      await runAgentStart(agentId);
      const after = process.getActiveResourcesInfo();

      expect(after.length).toBeLessThanOrEqual(before.length);
    },
    STRICT_BOUND_MS,
  );

  it(
    "runAgentStart (already-active early-return path) leaves no net-new active resources",
    async () => {
      const before = process.getActiveResourcesInfo();
      // Agent is already "active" from the previous test.
      await runAgentStart(agentId);
      const after = process.getActiveResourcesInfo();

      expect(after.length).toBeLessThanOrEqual(before.length);
    },
    STRICT_BOUND_MS,
  );
});

import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BOUNDED_VERIFICATION_GUIDANCE,
  MARATHON_SOFT_CAP_SEC,
  MAX_TIMEOUT_SEC,
  createRunVerificationTool,
  detectMarathonVerification,
  normalizeVerificationCommand,
  runVerificationCommand,
  summarizeVerificationFailureOutput,
  __testOnlyReapVerificationProcessGroup,
  type RunVerificationOptions,
} from "../run-verification-tool.js";

// Some tests use platform-appropriate shell syntax. On Windows, sh-style
// quoting and pipes through `printf` are different — these tests are skipped
// when running on win32. The implementation itself is portable via
// `shell: true` (Node picks cmd.exe on Windows, /bin/sh on POSIX).
const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tests for runVerificationCommand - the core verification execution logic.
 * These tests validate basic command execution, output capture, and error handling.
 *
 * NOTE: Timeout testing is intentionally excluded because the tool enforces its
 * own timeouts which conflict with test timeouts. The timeout behavior is validated
 * during integration testing in the main test suite.
 */
// Pick a sandbox-safe cwd. On macOS/Linux we use "/tmp" rather than
// os.tmpdir() because some sandboxed runners cannot reach the per-user
// $TMPDIR (e.g. /var/folders/.../T on macOS). On Windows /tmp does not exist
// so we fall back to os.tmpdir() which is always C:\Users\…\Temp there.
describe("runVerificationCommand", { timeout: 30000 }, () => {
  const tempDir = onPosix ? "/tmp" : tmpdir();
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  describe("command normalization", () => {
    it("rewrites package test -- --run filters to direct vitest with package-relative files", () => {
      const result = normalizeVerificationCommand(
        [
          "pnpm --filter @fusion/dashboard test -- --run",
          "packages/dashboard/src/__tests__/routes-tasks.test.ts",
          "packages/dashboard/src/__tests__/routes-settings.test.ts",
        ].join(" "),
        workspaceRoot,
      );

      expect(result.command).toBe(
        [
          "pnpm --filter @fusion/dashboard exec vitest run",
          "src/__tests__/routes-tasks.test.ts",
          "src/__tests__/routes-settings.test.ts",
          "--silent=passed-only --reporter=dot",
        ].join(" "),
      );
      expect(result.warnings).toEqual([
        expect.stringContaining("rewrote package test file filter"),
      ]);
    });

    it("leaves ordinary package tests unchanged when no file filter is forwarded", () => {
      const command = "pnpm --filter @fusion/dashboard test";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("leaves commands with unterminated shell quotes unchanged", () => {
      const command = "pnpm --filter @fusion/dashboard test -- --run 'src/__tests__/routes-tasks.test.ts";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("preserves pnpm global flags that precede --filter", () => {
      const result = normalizeVerificationCommand(
        "pnpm -w --filter @fusion/dashboard test -- --run packages/dashboard/src/__tests__/routes-tasks.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm -w --filter @fusion/dashboard exec vitest run src/__tests__/routes-tasks.test.ts --silent=passed-only --reporter=dot",
      );
    });

    it("verifies the CLI package directory through package.json before rewriting", () => {
      const result = normalizeVerificationCommand(
        "pnpm --filter @runfusion/fusion test -- --run packages/cli/src/__tests__/cli.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm --filter @runfusion/fusion exec vitest run src/__tests__/cli.test.ts --silent=passed-only --reporter=dot",
      );
    });
  });

  describe("marathon verification detection", () => {
    it.each([
      ["pnpm test", "root workspace test suite"],
      ["pnpm -w test", "root workspace test suite"],
      ["pnpm test:full", "full workspace verification script"],
      ["pnpm verify:workspace", "full workspace verification script"],
      ["pnpm --filter @fusion/core test", "whole-package test script"],
      ["for i in $(seq 1 20); do pnpm --filter @fusion/core exec vitest run src/foo.test.ts; done", "shell loop repeats"],
      ["while true; do pnpm test; done", "shell loop repeats"],
      ["seq 1 20 | xargs -I{} pnpm --filter @fusion/core exec vitest run src/foo.test.ts", "seq/xargs pipeline"],
      ["pnpm --filter @fusion/core exec vitest run src/a.test.ts && pnpm --filter @fusion/core exec vitest run src/a.test.ts", "&& chain repeats"],
    ])("flags marathon command %s", (command, reason) => {
      const detection = detectMarathonVerification(command, "workspace");

      expect(detection.isMarathon).toBe(true);
      expect(detection.reason).toContain(reason);
      expect(detection.guidance).toContain("allowFullSuite");
    });

    it.each([
      "pnpm --filter @fusion/core exec vitest run src/__tests__/settings-consistency.test.ts --silent=passed-only --reporter=dot",
      "pnpm --filter @fusion/dashboard test -- --run src/__tests__/routes-tasks.test.ts",
      "pnpm lint",
      "pnpm build",
    ])("passes targeted or non-test command %s", (command) => {
      expect(detectMarathonVerification(command, "package").isMarathon).toBe(false);
    });
  });

  describe("tool verification budgets and marathon caps", () => {
    it("uses the project verification timeout default when provided", async () => {
      const onVerificationStart = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: 1_500,
        onVerificationStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await tool.execute("call-budget", { command: "exit 0", scope: "workspace" });

      expect(onVerificationStart).toHaveBeenCalledWith(2_000);
    });

    it("falls back to legacy package/workspace defaults when the setting is absent or disabled", async () => {
      const packageStart = vi.fn();
      const disabledWorkspaceStart = vi.fn();
      const packageTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: packageStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const disabledTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: 0,
        onVerificationStart: disabledWorkspaceStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await packageTool.execute("call-package-default", { command: "exit 0", scope: "package" });
      await disabledTool.execute("call-workspace-default", { command: "exit 0", scope: "workspace" });

      expect(packageStart).toHaveBeenCalledWith(300_000);
      expect(disabledWorkspaceStart).toHaveBeenCalledWith(900_000);
    });

    it("applies the hard timeout cap to configured defaults and explicit overrides", async () => {
      const configuredStart = vi.fn();
      const explicitStart = vi.fn();
      const configuredTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: (MAX_TIMEOUT_SEC + 60) * 1000,
        onVerificationStart: configuredStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const explicitTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: explicitStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await configuredTool.execute("call-configured-cap", { command: "exit 0", scope: "package" });
      await explicitTool.execute("call-explicit-cap", { command: "exit 0", scope: "package", timeoutSec: MAX_TIMEOUT_SEC + 1 });

      expect(configuredStart).toHaveBeenCalledWith(MAX_TIMEOUT_SEC * 1000);
      expect(explicitStart).toHaveBeenCalledWith(MAX_TIMEOUT_SEC * 1000);
    });

    itPosix("reports an actionable timeout without relying on stuck detection", async () => {
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: vi.fn(),
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await tool.execute("call-timeout", { command: "sh -c 'sleep 10 & wait'", scope: "package", timeoutSec: 1 });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(result.details).toEqual(expect.objectContaining({ success: false, timedOut: true }));
      expect(text).toContain("Command timed out after 1s");
      expect(text).toContain(BOUNDED_VERIFICATION_GUIDANCE);
    });

    itPosix("soft-caps marathon commands unless allowFullSuite is provided", async () => {
      const cappedStart = vi.fn();
      const allowedStart = vi.fn();
      const recordActivity = vi.fn();
      const command = "pnpm() { echo pulse; }; pnpm test";
      const cappedTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: cappedStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const allowedTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity,
        onVerificationStart: allowedStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const capped = await cappedTool.execute("call-capped", { command, scope: "workspace", timeoutSec: 600 });
      const allowed = await allowedTool.execute("call-allowed", { command, scope: "workspace", timeoutSec: 600, allowFullSuite: true });

      const cappedText = capped.content[0]?.type === "text" ? capped.content[0].text : "";
      const allowedText = allowed.content[0]?.type === "text" ? allowed.content[0].text : "";
      expect(cappedStart).toHaveBeenCalledWith(MARATHON_SOFT_CAP_SEC * 1000);
      expect(cappedText).toContain("marathon verification detected");
      expect(allowedStart).toHaveBeenCalledWith(600_000);
      expect(allowedText).toContain("allowFullSuite=true acknowledged");
      expect(allowed.details).toEqual(expect.objectContaining({ success: true, timedOut: false }));
      expect(recordActivity).toHaveBeenCalled();
    });
  });

  describe("tool verification lifecycle callbacks", () => {
    it("brackets a successful verification run with start and end callbacks", async () => {
      const onVerificationStart = vi.fn();
      const onVerificationEnd = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6598",
        recordActivity: vi.fn(),
        onVerificationStart,
        onVerificationEnd,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await tool.execute("call-1", { command: "exit 0", scope: "package" });

      expect(onVerificationStart).toHaveBeenCalledTimes(1);
      expect(onVerificationStart).toHaveBeenCalledWith(300_000);
      expect(onVerificationEnd).toHaveBeenCalledTimes(1);
      expect(onVerificationStart.mock.invocationCallOrder[0]).toBeLessThan(onVerificationEnd.mock.invocationCallOrder[0]);
    });

    it("fires the end callback when the verification command fails", async () => {
      const onVerificationStart = vi.fn();
      const onVerificationEnd = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6598",
        recordActivity: vi.fn(),
        onVerificationStart,
        onVerificationEnd,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await tool.execute("call-2", { command: "exit 7", scope: "package" });

      expect(result.details).toEqual(expect.objectContaining({ success: false, exitCode: 7 }));
      expect(onVerificationStart).toHaveBeenCalledTimes(1);
      expect(onVerificationEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("basic command execution", () => {
    it("executes a simple echo command and captures output", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo test-output",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test-output");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("returns correct exit code for failed command", async () => {
      // `exit N` is recognised by both POSIX sh and Windows cmd.exe.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 42",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    });

    it("returns success when expectFailure=true and command exits non-zero", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 3",
        cwd: tempDir,
        timeoutMs: 30000,
        expectFailure: true,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(3);
    });
  });

  describe("timeouts", () => {
    itPosix("times out and kills a quiet long-running process group", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "sh -c 'sleep 10 & wait'",
        cwd: tempDir,
        timeoutMs: 100,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(5_000);
    });

    itPosix("reaps background children after a command exits cleanly", async () => {
      /*
       * FNXC:Verification 2026-06-21-10:00:
       * A clean shell exit is not enough evidence that verification is fully done; background children must be gone too or later task completion can stall behind leaked test workers.
       */
      const childScript = "setInterval(() => {}, 1000)";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "console.log(child.pid);",
        "child.unref();",
      ].join(" ");
      const result = await runVerificationCommand({
        command: `${process.execPath} -e ${JSON.stringify(parentScript)}`,
        cwd: tempDir,
        timeoutMs: 30_000,
        onHeartbeat: vi.fn(),
      });

      expect(result.success).toBe(true);
      const leakedPid = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isFinite(leakedPid)).toBe(true);
      expect(result.timedOut).toBe(false);

      for (let i = 0; i < 15 && isProcessAlive(leakedPid); i++) {
        await sleep(100);
      }
      expect(isProcessAlive(leakedPid)).toBe(false);
    });

    it("escalates non-timeout process-group reaping with fake timers", () => {
      /*
       * FNXC:Verification 2026-06-21-10:26:
       * Keep timer assertions on a narrow seam with fake timers so the integration test above never polls wall-clock time while still pinning SIGTERM -> SIGKILL escalation.
       */
      vi.useFakeTimers();
      const kill = vi.fn();
      const supervised = { kill } as unknown as Parameters<typeof __testOnlyReapVerificationProcessGroup>[0];

      try {
        __testOnlyReapVerificationProcessGroup(supervised);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith("SIGTERM");

        vi.advanceTimersByTime(499);
        expect(kill).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        expect(kill).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("output capture", () => {
    itPosix("captures multi-line stdout (POSIX shell)", async () => {
      // POSIX uses `;` as a command separator; cmd.exe uses `&`. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo line1; echo line2; echo line3",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).toContain("line3");
    });

    itPosix("captures stderr separately (POSIX shell)", async () => {
      // `>&2` redirect syntax is POSIX-specific. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo to-stdout; echo to-stderr >&2",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("to-stdout");
      expect(result.stderr).toContain("to-stderr");
    });
  });

  describe("tool response output", () => {
    const createCompactTool = () =>
      createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-COMPACT",
        recordActivity: vi.fn(),
        onVerificationStart: vi.fn(),
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

    it("reduces noisy test failures to counts, failing tests, errors, and source locations", () => {
      const stdout = [
        "\u001b[41m FAIL \u001b[0m app/components/Widget.test.tsx > Widget > preserves focus",
        "AssertionError: expected false to be true",
        "Ignored nodes: comments, script, style",
        "<html>",
        "  <body>",
        "    <div class=\"entire-rendered-application\">",
        "      <input />",
        "      DOM-NOISE-THAT-MUST-NOT-REACH-THE-AGENT",
        "    </div>",
        "  </body>",
        "</html>",
        " ❯ app/components/Widget.test.tsx:42:7",
        " Test Files  1 failed | 12 passed (13)",
        "      Tests  1 failed | 650 passed (651)",
      ].join("\n");

      const summary = summarizeVerificationFailureOutput(stdout, "");

      expect(summary).toContain("FAIL app/components/Widget.test.tsx > Widget > preserves focus");
      expect(summary).toContain("AssertionError: expected false to be true");
      expect(summary).toContain("app/components/Widget.test.tsx:42:7");
      expect(summary).toContain("Test Files 1 failed | 12 passed (13)");
      expect(summary).toContain("Tests 1 failed | 650 passed (651)");
      expect(summary).not.toContain("DOM-NOISE-THAT-MUST-NOT-REACH-THE-AGENT");
      expect(summary).not.toContain("\u001b[");
    });

    it("keeps compiler diagnostics and caps generic failure output", () => {
      const diagnostic = "src/example.ts(12,4): error TS2322: Type 'number' is not assignable to type 'string'.";
      const stderr = [
        diagnostic,
        ...Array.from(
          { length: 200 },
          (_, index) =>
            `src/example-${index}.ts(12,4): error TS2322: ${"x".repeat(200)}`,
        ),
      ].join("\n");

      const summary = summarizeVerificationFailureOutput("", stderr);

      expect(summary).toContain(diagnostic);
      expect(summary.length).toBeLessThanOrEqual(8_000);
      expect(summary).toContain("output compacted");
    });

    it("retains actionable lint context ahead of a generic package-manager failure", () => {
      const stderr = [
        "/workspace/src/widget.ts",
        "  12:3  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any",
        "✖ 1 problem (1 error, 0 warnings)",
        "ELIFECYCLE Command failed with exit code 1.",
      ].join("\n");

      const summary = summarizeVerificationFailureOutput("", stderr);

      expect(summary).toContain("/workspace/src/widget.ts");
      expect(summary).toContain("12:3 error Unexpected any");
      expect(summary).toContain("@typescript-eslint/no-explicit-any");
      expect(summary).toContain("ELIFECYCLE Command failed with exit code 1.");
    });

    it("preserves failure details from both streams when one stream exceeds the cap", () => {
      const stderr = Array.from(
        { length: 100 },
        (_, index) => `src/error-${index}.ts(1,1): error TS2322: diagnostic ${index}`,
      ).join("\n");
      const stdout = [
        "[vite]: Rollup failed to resolve import \"missing-package\" from \"src/main.ts\".",
        "Command failed with exit code 1.",
      ].join("\n");

      const summary = summarizeVerificationFailureOutput(stdout, stderr);

      expect(summary).toContain("Rollup failed to resolve import");
      expect(summary).toContain("src/error-0.ts");
      expect(summary.length).toBeLessThanOrEqual(8_000);
    });

    it("preserves terminal totals when one stream has more high-signal lines than the cap", () => {
      const stdout = [
        ...Array.from(
          { length: 100 },
          (_, index) => `src/error-${index}.ts(1,1): error TS2322: diagnostic ${index}`,
        ),
        "Test Files  20 failed | 2 passed (22)",
        "Tests  100 failed | 10 passed (110)",
        "ELIFECYCLE Command failed with exit code 1.",
      ].join("\n");

      const summary = summarizeVerificationFailureOutput(stdout, "");

      expect(summary).toContain("src/error-0.ts");
      expect(summary).toContain("Test Files 20 failed | 2 passed (22)");
      expect(summary).toContain("Tests 100 failed | 10 passed (110)");
      expect(summary).toContain("ELIFECYCLE Command failed with exit code 1.");
      expect(summary.length).toBeLessThanOrEqual(8_000);
    });

    it("keeps a bounded assertion diff with an elided assertion headline", () => {
      const stdout = [
        "AssertionError: expected { …(5) } to deeply equal { …(5) }",
        "- Expected",
        "+ Received",
        "  Object {",
        "-   \"status\": \"ready\",",
        "+   \"status\": \"failed\",",
        "  }",
        " ❯ src/widget.test.ts:18:4",
      ].join("\n");

      const summary = summarizeVerificationFailureOutput(stdout, "");

      expect(summary).toContain("- Expected");
      expect(summary).toContain("+ Received");
      expect(summary).toContain("\"status\": \"failed\"");
      expect(summary).toContain("src/widget.test.ts:18:4");
    });

    itPosix("omits routine stdout from successful tool responses", async () => {
      const tool = createCompactTool();

      const result = await tool.execute("call-compact-success", {
        command:
          "printf 'routine build chatter\\nTests  0 failed | 20 passed (20)\\n100%% tests passed, 0 tests failed out of 5\\n'",
        scope: "package",
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Success: true");
      expect(text).not.toContain("routine build chatter");
      expect(text).not.toContain("Verification warning:");
      expect(text).not.toContain("--- stdout ---");
    });

    itPosix("retains zero-work warnings from commands that exit successfully", async () => {
      const tool = createCompactTool();

      const result = await tool.execute("call-compact-no-work", {
        command: "printf 'No projects matched the filters\\nroutine chatter\\n'",
        scope: "package",
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Success: true");
      expect(text).toContain("Verification warning:");
      expect(text).toContain("No projects matched the filters");
      expect(text).not.toContain("routine chatter");
    });

    itPosix("warns when an exit-zero command reports failed tests", async () => {
      const tool = createCompactTool();

      const result = await tool.execute("call-compact-green-while-red", {
        command: "printf 'Test Files  1 failed | 2 passed (3)\\nroutine chatter\\n'",
        scope: "package",
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Success: true");
      expect(text).toContain("Verification warning:");
      expect(text).toContain("Test Files 1 failed | 2 passed (3)");
      expect(text).not.toContain("routine chatter");
    });

    itPosix("returns only the compact summary for failed tool responses", async () => {
      const tool = createCompactTool();
      const script = [
        "console.log('FAIL src/widget.test.ts > Widget > reports the failure');",
        "console.log('Test Files  1 failed | 2 passed (3)');",
        "console.error('AssertionError: expected 1 to be 2');",
        "console.error('<div>DOM-NOISE-THAT-MUST-NOT-REACH-THE-AGENT</div>');",
        "process.exit(1);",
      ].join("");

      const result = await tool.execute("call-compact-failure", {
        command: `${process.execPath} -e ${JSON.stringify(script)}`,
        scope: "package",
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Failure summary:");
      expect(text).toContain("Widget > reports the failure");
      expect(text).toContain("AssertionError: expected 1 to be 2");
      expect(text).toContain("Test Files 1 failed | 2 passed (3)");
      expect(text).not.toContain("DOM-NOISE-THAT-MUST-NOT-REACH-THE-AGENT");
      expect(text).not.toContain("--- stdout ---");
      expect(text).not.toContain("--- stderr ---");
    });
  });

  describe("heartbeat callbacks", () => {
    itPosix("fires onHeartbeat for each output line (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo a; echo b; echo c",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      // Should call heartbeat at least once per line
      expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    itPosix("fires onLine callback with each line when provided (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const onLine = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo hello; echo world",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
        onLine,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(onLine.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("error handling", () => {
    itPosix("handles missing commands gracefully (POSIX sh reports exit 127)", async () => {
      // The implementation runs commands via the platform shell. POSIX sh
      // returns exit 127 for "command not found"; cmd.exe returns 1 (or
      // 9009 in some cases). This test pins the POSIX behaviour.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "/nonexistent/command/path",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.timedOut).toBe(false);
    });

    it("includes all result fields", async () => {
      // `exit 0` is portable across POSIX sh and cmd.exe; `true` is POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 0",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("durationMs");
      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("timedOut");
      expect(result).toHaveProperty("killed");
      expect(result).toHaveProperty("command");
      expect(result).toHaveProperty("cwd");
      expect(result).toHaveProperty("warnings");
    });

    it("preserves command and cwd in result", async () => {
      const onHeartbeat = vi.fn();
      const command = "echo preserved";
      const opts: RunVerificationOptions = {
        command,
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.command).toBe(command);
      expect(result.cwd).toBe(tempDir);
    });
  });

  describe("complex shell commands", () => {
    itPosix("handles piped commands (POSIX shell)", async () => {
      // The implementation runs commands through the platform shell. POSIX
      // pipes + printf differ from Windows cmd.exe syntax, so this test is
      // POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "printf 'test1\\ntest2\\ntest3\\n' | grep test",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("test1");
    });

    itPosix("executes commands with environment variables (POSIX shell)", async () => {
      // POSIX shell expansion ($USER) differs from Windows (%USERNAME%).
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo $USER",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      // Should have output (USER is typically set)
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });
  });
});

/**
 * FNXC:EngineDiagnostics 2026-07-26-08:17:
 * Contract tests that high-frequency steady-state chatter stays on `debug()` / FUSION_DEBUG,
 * so a reversion to info-level spam fails CI. Complements logger-debug-gating (framework) with
 * shipped call-site severity for known TUI flood classes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { logSeverityManifest } from "./log-severity-manifest.js";

const engineSrc = join(__dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(join(engineSrc, relative), "utf8");
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

/*
FNXC:EngineDiagnostics 2026-07-26-10:46:
FN-8603 pins every demoted engine call-site by a stable message anchor. The
source check rejects a reversion to log, warn, error, or bare console output.
*/
describe("log severity spam contract (source)", () => {
  it("keeps every manifest entry at its audited severity", () => {
    for (const entry of logSeverityManifest.filter((entry) => entry.pkg === "engine")) {
      const src = readSrc(entry.file);
      const matchingLines = src.split("\n").filter((line) => line.includes(entry.anchor));
      expect(matchingLines, `${entry.file}: ${entry.anchor}`).toHaveLength(1);
      const [line] = matchingLines;
      expect(line).toContain(`.${entry.severity}(`);
      expect(line).not.toMatch(/\.(log|warn|error)\(|console\.(log|warn|error)\(/);
    }
  });
  // Logger implementation is the sole adapter allowed to write severity-marked console output.
  const bareConsoleAllowlist = new Set([join(engineSrc, "logger.ts")]);

  it("routes production diagnostics through createLogger", () => {
    for (const file of sourceFiles(engineSrc)) {
      if (bareConsoleAllowlist.has(file)) continue;
      expect(withoutComments(readFileSync(file, "utf8")), file).not.toMatch(/console\.(log|warn|error)\(/);
    }
  });

  it("maintenance batch per-step success uses debug, not log", () => {
    const src = readSrc("self-healing.ts");
    expect(src).toMatch(/log\.debug\(`Maintenance batch 1 step "\$\{fn\.name\}" succeeded`\)/);
    expect(src).toMatch(/log\.debug\(`Maintenance batch 2 step "\$\{fn\.name\}" succeeded`\)/);
    expect(src).not.toMatch(/log\.log\(`Maintenance batch [123] step "\$\{fn\.name\}" succeeded`\)/);
  });

  it("all type=info skill diagnostics (Requested skill listings and not-found) route to debug", () => {
    const pi = readSrc("pi.ts");
    const resolver = readSrc("skill-resolver.ts");
    expect(pi).toMatch(/else if \(diag\.type === "info"\) piLog\.debug\(msg\)/);
    expect(resolver).toMatch(/isSkillInfoDiagnostic/);
    expect(resolver).toMatch(/else if \(isSkillInfoDiagnostic\(diag\)\) piLog\.debug\(msg\)/);
    expect(resolver).not.toMatch(/isRequestedSkillListingDiagnostic/);
  });

  it("activity-recorded heartbeats and periodic stuck poll use debug", () => {
    const src = readSrc("stuck-task-detector.ts");
    expect(src).toMatch(/stuckLog\.debug\(\s*`Activity recorded for/);
    expect(src).toMatch(/stuckLog\.debug\("Running periodic stuck task check \(polling\)"\)/);
    expect(src).not.toMatch(/stuckLog\.log\(\s*`Activity recorded for/);
    expect(src).not.toMatch(/stuckLog\.log\("Running periodic stuck task check \(polling\)"\)/);
  });

  it("heartbeat timer skip gates use debug", () => {
    const src = readSrc("agent-heartbeat.ts");
    expect(src).toMatch(/heartbeatLog\.debug\(`Timer tick skipped for \$\{agentId\} \(active run\)`\)/);
    expect(src).toMatch(/heartbeatLog\.debug\(`Timer tick skipped for \$\{agentId\} \(global pause active\)`\)/);
    expect(src).not.toMatch(/heartbeatLog\.log\(`Timer tick skipped for \$\{agentId\} \(active run\)`\)/);
  });

  it("cron multi-scope skip chatter uses debug; execute stays on log", () => {
    const src = readSrc("cron-runner.ts");
    expect(src).toMatch(/log\.debug\(`Skipping \$\{schedule\.name\}[\s\S]*already executed from another scope/);
    expect(src).toMatch(/log\.debug\(`Skipping \$\{schedule\.name\}[\s\S]*claim lost to another poller/);
    expect(src).toMatch(/log\.log\(`Executing \$\{schedule\.name\}/);
  });

  it("plugin skill contribution/merge chatter uses debug", () => {
    const src = readSrc("session-skill-context.ts");
    expect(src).toMatch(/piLog\.debug\(`\[skills\] Plugin \$\{pluginId\} contributes skill:/);
    expect(src).toMatch(/piLog\.debug\(\s*`\[skills\] Merged \$\{appendedPluginNames\.length\}/);
  });

  it("hold-release capacity race uses debug like deferred-no-slot", () => {
    const src = readSrc("hold-release.ts");
    expect(src).toMatch(/schedulerLog\.debug\(`Hold release for \$\{task\.id\} rejected on capacity/);
    expect(src).toMatch(/schedulerLog\.debug\(`Hold release for \$\{task\.id\} deferred — no reservable slot/);
  });

  it("routine-scheduler re-entrance and pause no-ops use debug", () => {
    const src = readSrc("routine-scheduler.ts");
    expect(src).toMatch(/logger\.debug\("Tick already in progress, skipping"\)/);
    expect(src).toMatch(/logger\.debug\(\s*`Paused: globalPause=/);
    expect(src).not.toMatch(/logger\.log\("Tick already in progress, skipping"\)/);
    expect(src).not.toMatch(/logger\.log\(\s*`Paused: globalPause=/);
  });

  it("peer-exchange zero-work sync cycle uses debug; non-zero/error stay on log", () => {
    const src = readSrc("peer-exchange-service.ts");
    expect(src).toMatch(/peerExchangeLog\.debug\(`Starting sync with \$\{onlineRemoteNodes\.length\} peers`\)/);
    expect(src).toMatch(/peerExchangeLog\.debug\(\s*`Sync complete: \$\{onlineRemoteNodes\.length\} peers synced\./);
    // Non-zero discovery path and error summary remain log
    expect(src).toMatch(/else if \(totalAdded > 0 \|\| totalUpdated > 0\) \{\s*peerExchangeLog\.log\(/);
    expect(src).toMatch(/if \(errors\.length > 0\) \{\s*peerExchangeLog\.log\(/);
    expect(src).not.toMatch(/peerExchangeLog\.log\(`Starting sync with \$\{onlineRemoteNodes\.length\} peers`\)/);
  });

  it("planning using-model engine log is debug; task activity marker remains", () => {
    const triage = readSrc("triage.ts");
    expect(triage).toMatch(/planLog\.debug\(`\$\{task\.id\}: using model \$\{modelDesc\}`\)/);
    expect(triage).toMatch(/Planning using model: \$\{modelDesc\}/);
    expect(triage).not.toMatch(/planLog\.log\(`\$\{task\.id\}: using model \$\{modelDesc\}`\)/);
  });

  /*
  FNXC:EngineDiagnostics 2026-08-01-18:11:
  Operator TUI review: replan-session setup chatter, track bookkeeping, intentional skill
  exclusions, zero-recovery no-ops, and metrics JSON must stay off default info/warn.
  */
  it("session setup, track bookkeeping, skill exclusion, and zero-recovery stay debug-gated", () => {
    const session = readSrc("agent-session-helpers.ts");
    const stuck = readSrc("stuck-task-detector.ts");
    const triage = readSrc("triage.ts");
    const resolver = readSrc("skill-resolver.ts");
    const selfHealing = readSrc("self-healing.ts");
    const mission = readSrc("mission-execution-loop.ts");
    const runtime = readSrc("runtimes/in-process-runtime.ts");
    const tokenUsage = readSrc("session-token-usage.ts");
    const executor = readSrc("executor.ts");

    expect(session).toMatch(/sessionLog\.debug\(\s*`\[\$\{sessionPurpose\}\] grok-cli fallback/);
    expect(session).toMatch(/sessionLog\.debug\(\s*`\[\$\{sessionPurpose\}\] Using runtime/);
    expect(session).not.toMatch(/sessionLog\.log\(\s*`\[\$\{sessionPurpose\}\] grok-cli fallback/);
    expect(session).not.toMatch(/sessionLog\.log\(\s*`\[\$\{sessionPurpose\}\] Using runtime/);

    expect(stuck).toMatch(/stuckLog\.debug\(`Tracking task \$\{trackingKey\}/);
    expect(stuck).not.toMatch(/stuckLog\.log\(`Tracking task \$\{trackingKey\}/);

    expect(triage).toMatch(/planLog\.debug\(`\$\{task\.id\}: planning in \$\{leanPlanning/);
    expect(triage).not.toMatch(/planLog\.log\(`\$\{task\.id\}: planning in \$\{leanPlanning/);
    expect(triage).toMatch(/if \(code === "ENOENT"\) \{\s*planLog\.debug\(`\$\{taskId\}: failed to read PROMPT\.md/);
    expect(triage).toMatch(/planLog\.warn\(`\$\{taskId\}: failed to read PROMPT\.md during \$\{context\}/);

    expect(resolver).toMatch(/exists but is disabled by project execution settings/);
    expect(resolver).toMatch(/type: "info" as ResourceDiagnostic\["type"\],\s*message: `Skill at '\$\{excludedPath\}' exists but is disabled/);

    expect(selfHealing).toMatch(/if \(clearedAgentIds\.size > 0\) \{\s*log\.log\(`Recovered \$\{clearedAgentIds\.size\} drifted/);
    expect(selfHealing).toMatch(/log\.debug\(`Recovered \$\{clearedAgentIds\.size\} drifted durable agent task link/);

    expect(mission).toMatch(/if \(recoveredCount > 0\) \{\s*loopLog\.log\(`Active mission recovery complete/);
    expect(mission).toMatch(/loopLog\.debug\(`Active mission recovery complete: recovered \$\{recoveredCount\} features`\)/);

    expect(runtime).toMatch(/runtimeLog\.debug\(`Specifying \$\{t\.id\}\.\.\.`\)/);
    expect(runtime).not.toMatch(/runtimeLog\.log\(`Specifying \$\{t\.id\}\.\.\.`\)/);

    expect(tokenUsage).toMatch(/cacheMetricsLog\.debug\(JSON\.stringify\(/);
    expect(tokenUsage).not.toMatch(/cacheMetricsLog\.log\(JSON\.stringify\(/);
    expect(executor).toMatch(/tokenCacheMetricsLog\.debug\(JSON\.stringify\(/);
    expect(executor).not.toMatch(/tokenCacheMetricsLog\.log\(JSON\.stringify\(/);
  });

  it("self-healing no-action/skip, worktree-pool probes, and ntfy bookkeeping use debug", () => {
    const sh = readSrc("self-healing.ts");
    const wt = readSrc("worktree-pool.ts");
    const ntfy = readSrc("notification/ntfy-provider.ts");
    const notify = readSrc("notification/notification-service.ts");
    expect(sh).toMatch(/log\.debug\(`\[\$\{stage\}\] \$\{task\.id\}: triple-proof not satisfied — no action/);
    expect(sh).toMatch(/log\.debug\("Started"\)/);
    expect(sh).toMatch(/log\.log\(`Recovered \$\{recovered\}/);
    expect(wt).toMatch(/worktreePoolLog\.debug\(`Rehydrate skipped \(not on disk\)/);
    expect(ntfy).toMatch(/schedulerLog\.debug\(\s*`NtfyNotificationProvider send event=/);
    expect(ntfy).toMatch(/schedulerLog\.debug\(\s*`NtfyNotificationProvider delivery event=/);
    expect(notify).toMatch(/schedulerLog\.debug\(`NotificationService\.maybeNotify suppressed duplicate key=/);
    expect(notify).toMatch(/schedulerLog\.log\(`NotificationService\.maybeNotify dispatch failed key=/);
  });

  it("pi session-purpose runtime routing and skip bookkeeping uses debug", () => {
    const runtime = readSrc("runtime-resolution.ts");
    const pi = readSrc("pi.ts");
    expect(runtime).toMatch(/runtimeLog\.debug\(`\[\$\{sessionPurpose\}\] No runtime hint configured/);
    expect(runtime).toMatch(/runtimeLog\.debug\(`\[\$\{sessionPurpose\}\] Runtime hint is "pi\/default"/);
    expect(runtime).toMatch(/runtimeLog\.debug\(`\[\$\{sessionPurpose\}\] Using configured plugin runtime/);
    expect(runtime).toMatch(/runtimeLog\.error\(`\[\$\{sessionPurpose\}\] Error resolving plugin runtime/);
    expect(pi).toMatch(/piLog\.debug\(`\$\{skipReason\} session — host extensions/);
    expect(pi).toMatch(/piLog\.debug\(`readonly session — MCP servers/);
  });

  it("checkpoint bookkeeping (self-improve + RETHINK rewind) uses debug", () => {
    const improve = readSrc("agent-self-improve.ts");
    const step = readSrc("step-runner.ts");
    expect(improve).toMatch(/selfImproveLog\.debug\(`Recorded self-improve checkpoint for/);
    expect(step).toMatch(/executorLog\.debug\(`\$\{taskId\}: RETHINK — session rewound to checkpoint/);
    expect(step).toMatch(/executorLog\.debug\(`\$\{taskId\}: RETHINK — no session checkpoint for step/);
    expect(step).toMatch(/executorLog\.error\(`\$\{taskId\}: RETHINK git reset failed/);
  });

  it("merger intermediate plumbing uses debug; outcomes stay at log", () => {
    const merger = readSrc("merger.ts");
    const conflict = readSrc("merger-conflict-resolution.ts");
    expect(conflict).toMatch(/mergerLog\.debug\(`Auto-resolved \$\{filePath\} using --ours`\)/);
    expect(merger).toMatch(/mergerLog\.debug\(`\$\{taskId\}: merge details stored/);
    expect(merger).toMatch(/mergerLog\.debug\(`\$\{taskId\}: git pull --rebase succeeded/);
    expect(merger).toMatch(/mergerLog\.debug\(`\$\{taskId\}: merge attempt \$\{attemptNum\}\/3/);
    expect(merger).toMatch(/mergerLog\.log\(`\$\{taskId\}: completeTask — clearing status, moving to done`\)/);
    expect(merger).toMatch(/mergerLog\.log\(`\$\{taskId\}: conflicts detected, AI will resolve`\)/);
    expect(merger).toMatch(/mergerLog\.log\(`\$\{taskId\}: pushed merged result/);
    expect(merger).not.toMatch(/mergerLog\.log\(`Auto-resolved \$\{filePath\} using --ours`\)/);
  });

  it("foreach step skip/rework and per-step success use debug", () => {
    const foreach = readSrc("workflow-graph-foreach.ts");
    const exec = readSrc("executor.ts");
    expect(foreach).toMatch(/schedulerLog\.debug\(\s*`foreach \$\{foreachNode\.id\} for task \$\{env\.task\.id\}: skipping step/);
    expect(foreach).toMatch(/schedulerLog\.debug\(\s*`foreach \$\{foreachNode\.id\} step \$\{inst\.stepIndex\}: integration-conflict/);
    expect(foreach).not.toMatch(/schedulerLog\.log\(\s*`foreach \$\{foreachNode\.id\} for task/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: step \$\{stepIndex\} succeeded/);
    expect(exec).toMatch(/executorLog\.log\(`\$\{task\.id\}: step \$\{stepIndex\} failed/);
  });

  it("executor high-frequency dispatch/session bookkeeping uses debug", () => {
    const src = readSrc("executor.ts");
    expect(src).toMatch(/executorLog\.debug\(`TaskExecutor constructed/);
    expect(src).toMatch(/executorLog\.debug\(`execute\(\) called for \$\{task\.id\} \(claimed=/);
    expect(src).toMatch(/executorLog\.debug\(`\$\{task\.id\}: worktree ready at/);
    expect(src).toMatch(/executorLog\.debug\(`\$\{task\.id\}: session registered/);
    expect(src).toMatch(/executorLog\.debug\(`\$\{task\.id\}: calling promptWithFallback/);
    expect(src).toMatch(/executorLog\.debug\(`\[workflow-graph\] \$\{event\.type\}/);
    expect(src).toMatch(/executorLog\.debug\(`\[workflow-column-boundary\]/);
    // Lifecycle outcomes stay at log
    expect(src).toMatch(/executorLog\.log\(`Starting \$\{task\.id\}:/);
    expect(src).not.toMatch(/executorLog\.log\(`execute\(\) called for \$\{task\.id\} \(claimed=/);
  });

  it("MCP server connected success chatter uses logger.debug", () => {
    const src = readSrc("mcp-session-tools.ts");
    expect(src).toMatch(/opts\.logger\.debug\(connectMsg\)/);
    expect(src).toMatch(/MCP server connected for pi session/);
    // Must not route the success line only through log without preferring debug.
    expect(src).toMatch(/if \(typeof opts\.logger\?\.debug === "function"\)/);
  });

  it("fn_run_verification and green verification result paths use debug", () => {
    const tool = readSrc("run-verification-tool.ts");
    const utils = readSrc("verification-utils.ts");
    const stuck = readSrc("stuck-task-detector.ts");
    const exec = readSrc("executor.ts");
    expect(tool).toMatch(/executorLog\.debug\(\s*`\[fn_run_verification\] command quiet for/);
    expect(tool).toMatch(/\(log\.debug \?\? log\.info\)\(/);
    expect(tool).toMatch(/if \(result\.success\) \{\s*\(log\.debug \?\? log\.info\)\(/);
    // Non-timeout command failures are routine agent loops; keep one done-line at info, detail at debug.
    expect(tool).toMatch(/executorLog\.debug\(`\[fn_run_verification\] command failed \(exit=/);
    expect(tool).not.toMatch(/executorLog\.warn\(`\[fn_run_verification\] command failed \(exit=/);
    expect(utils).toMatch(/debugLog\(`\$\{taskId\}: running \$\{type\} command:/);
    expect(utils).toMatch(/debugLog\(`\$\{taskId\}: \$\{type\} command succeeded in/);
    expect(utils).toMatch(/logger\.error\(`\$\{taskId\}: \$\{type\} command failed/);
    expect(stuck).toMatch(/stuckLog\.debug\(`Verification started for/);
    expect(stuck).toMatch(/stuckLog\.debug\(`Verification ended for/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: \[verification\] running deterministic verification/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: \[verification\] passed`\)/);
    expect(exec).toMatch(/executorLog\.log\(`\$\{task\.id\}: \[verification\] test failed/);
  });

  /*
  FNXC:EngineDiagnostics 2026-08-03-05:54:
  Screenshot audit: keep default TUI for lifecycle transitions; demote expected skips,
  schedule-trigger echoes, and session/setup bookkeeping.
  */
  it("busy-board lifecycle noise stays debug-gated; starts and creates stay log", () => {
    const scheduler = readSrc("scheduler.ts");
    const runtime = readSrc("runtimes/in-process-runtime.ts");
    const exec = readSrc("executor.ts");
    const heartbeat = readSrc("agent-heartbeat.ts");
    const autoClaim = readSrc("auto-claim-snapshot.ts");
    const worktree = readSrc("worktree-acquisition.ts");

    expect(scheduler).toMatch(/schedulerLog\.debug\(`No linked feature found for task/);
    expect(scheduler).toMatch(/schedulerLog\.debug\("Task created — triggering scheduling"\)/);
    expect(scheduler).toMatch(/schedulerLog\.debug\(`Task moved to \$\{to\} — triggering scheduling`\)/);
    expect(scheduler).toMatch(/schedulerLog\.log\(`Starting \$\{taskId\}:/);
    expect(scheduler).not.toMatch(/schedulerLog\.log\(`No linked feature found for task/);

    expect(runtime).toMatch(/runtimeLog\.debug\(`Scheduled task \$\{task\.id\}`\)/);
    expect(runtime).toMatch(/runtimeLog\.debug\(`Started executing task \$\{task\.id\} in \$\{worktreePath\}`\)/);
    expect(runtime).not.toMatch(/runtimeLog\.log\(`Scheduled task \$\{task\.id\}`\)/);

    expect(exec).toMatch(/executorLog\.log\(`Starting \$\{task\.id\}:/);
    expect(exec).toMatch(/executorLog\.log\(`Worktree created:/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: executor runtime env injected/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: captured baseCommitSha/);
    expect(exec).toMatch(/executorLog\.debug\(`\$\{task\.id\}: workflow node '\$\{nodeId\}' acquired worktree/);
    expect(exec).not.toMatch(/executorLog\.log\(`\$\{task\.id\}: executor runtime env injected/);

    expect(heartbeat).toMatch(/heartbeatLog\.debug\(`Assignment trigger skipped for \$\{agent\.id\} \(ephemeral\/internal\)`\)/);
    expect(heartbeat).not.toMatch(/heartbeatLog\.log\(`Assignment trigger skipped for \$\{agent\.id\} \(ephemeral\/internal\)`\)/);

    expect(autoClaim).toMatch(/this\.logger\.debug\(`invalidate reason=\$\{reason\}`\)/);
    expect(autoClaim).not.toMatch(/this\.logger\.log\(`invalidate reason=\$\{reason\}`\)/);


    expect(worktree).toMatch(/logger\.debug\(`Reusing existing worktree: \$\{path\}`\)/);
    expect(worktree).toMatch(/logger\.debug\(`Reusing existing worktree: \$\{worktreePath\}`\)/);
    expect(worktree).not.toMatch(/logger\?\.log\(`Reusing existing worktree:/);
  });
});

describe("log severity spam contract (runtime gating)", () => {
  const original = process.env.FUSION_DEBUG;

  beforeEach(() => {
    delete process.env.FUSION_DEBUG;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUSION_DEBUG;
    else process.env.FUSION_DEBUG = original;
  });

  it("createLogger debug is silent without FUSION_DEBUG and emits when opted in", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("stuck-detector");

    log.debug("Activity recorded for FN-1 (sinceProgress=1)");
    expect(errorSpy).not.toHaveBeenCalled();

    process.env.FUSION_DEBUG = "stuck-detector";
    log.debug("Activity recorded for FN-1 (sinceProgress=1)");
    expect(errorSpy).toHaveBeenCalled();
    const payload = String(errorSpy.mock.calls[0]![0]);
    expect(payload).toContain("[stuck-detector]");
    expect(payload).toContain("Activity recorded");

    errorSpy.mockRestore();
  });

  it("log/warn/error remain ungated by FUSION_DEBUG", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("heartbeat");

    log.log("Executing heartbeat for agent-1 (source=timer)");
    log.warn("something needs attention");
    log.error("hard failure");

    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("routine-scheduler and peer-exchange debug channels stay silent without FUSION_DEBUG", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const routineLog = createLogger("routine-scheduler");
    const peerLog = createLogger("peer-exchange");

    routineLog.debug("Tick already in progress, skipping");
    routineLog.debug("Paused: globalPause=true, enginePaused=false");
    peerLog.debug("Starting sync with 2 peers");
    peerLog.debug("Sync complete: 2 peers synced. 0 new peers discovered, 0 updated.");
    expect(errorSpy).not.toHaveBeenCalled();

    process.env.FUSION_DEBUG = "routine-scheduler,peer-exchange";
    routineLog.debug("Tick already in progress, skipping");
    peerLog.debug("Starting sync with 2 peers");
    expect(errorSpy).toHaveBeenCalled();
    const joined = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("[routine-scheduler]");
    expect(joined).toContain("[peer-exchange]");

    errorSpy.mockRestore();
  });
});

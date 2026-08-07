/*
FNXC:EngineDiagnostics 2026-07-26-10:46:
FN-8603 requires routine and expected diagnostic sites to default to debug so a
single accidental severity reversion cannot flood the operator log pane.
*/
export type SeverityManifestEntry = {
  pkg: "engine" | "core" | "dashboard";
  file: string;
  anchor: string;
  priorSeverity: "log" | "warn" | "error" | "console";
  severity: "debug" | "warn";
};

export const logSeverityManifest: SeverityManifestEntry[] = [
  { pkg: "engine", file: "plugin-runner.ts", anchor: "condition evaluated false", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Executor runtime environment event: ${event}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Tool execution event: ${event}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Runtime instantiation event: ${event}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "debug: (...args: unknown[]) => this.log.debug(prefix, ...args)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Tools cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Routes cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "UI slots cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "UI contributions cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Runtimes cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "CLI provider contributions cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Skills cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "MCP servers cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Workflow steps cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Workflow extensions cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Workflow step templates cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Plugin traits cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Prompt contributions cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "plugin-runner.ts", anchor: "Setup cache invalidated", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "Cleaned ${cleaned} stale AI merge temp worktree(s)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "cleanup-old-chats\" removed stale data", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "cleanup-old-mail\" removed stale data", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "Auto-archiving ${stale.length}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "auto-archive: archived", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "self-healing.ts", anchor: "Auto-archived ${archived} stale done task(s)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "pty-native.ts", anchor: "Pre-loaded native module via dlopen", priorSeverity: "console", severity: "debug" },
  { pkg: "engine", file: "pty-native.ts", anchor: "dlopen pre-load failed (continuing)", priorSeverity: "console", severity: "debug" },
  { pkg: "engine", file: "goal-anchoring-audit.ts", anchor: "goal retrieval audit emission skipped", priorSeverity: "console", severity: "debug" },
  { pkg: "engine", file: "runtimes/child-process-worker.ts", anchor: "Child process worker starting", priorSeverity: "log", severity: "debug" },
  /*
  FNXC:EngineDiagnostics 2026-07-30-04:00:
  REMOVED: the `local reattached project ${project.id}` demotion in central-core.ts. Its call site was
  deleted by 5ae6332563 ("collapse dead SQLite dual-path code") — verified absent from all of
  packages/core/src, not merely moved — so the entry pinned a demotion that no longer exists and the
  contract test could only ever fail on it. A manifest row for deleted code cannot ratchet anything.
  */
  { pkg: "core", file: "docker/docker-provisioning.ts", anchor: "Pulling image ${imageRef}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "docker/docker-provisioning.ts", anchor: "provisioned successfully in ${durationMs}ms", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "docker/docker-provisioning.ts", anchor: "deprovisioned", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Cleanup: removed ${cleanedRateLimits} rate limit entries", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Creating agent session...", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Failed to initialize AI agent - no session", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Agent session created, sending prompt...", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Session error: ${errorMsg}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Prompt sent, extracting response from messages...", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Total messages: ${messages.length}, Assistant messages: ${assistantMessages.length}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Extracted raw title: \"${title}\"", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "AI returned empty/unusable response", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Title generation successful: \"${sanitized}\"", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Unexpected error: ${message}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "log.debug(\"AI engine not available\");", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "AI engine not available for commit body", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Commit-body session error: ${session.state.error}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Commit-body generation failed: ${message}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "AI engine not available for commit subject", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Commit-subject session error: ${session.state.error}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "ai/ai-summarize.ts", anchor: "Commit-subject generation failed: ${message}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "severityAuditLog.debug(\"[memory-compaction] AI engine not available\");", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Creating agent session", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Failed to initialize AI agent - no session", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Agent session created, sending prompt", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Session error: ${errorMsg}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Prompt sent, extracting response", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Total messages: ${messages.length}", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Extracted compacted content length", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "AI returned empty response", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Memory compaction successful", priorSeverity: "console", severity: "debug" },
  { pkg: "core", file: "memory/memory-compaction.ts", anchor: "Unexpected error: ${message}", priorSeverity: "console", severity: "debug" },
  { pkg: "dashboard", file: "ai-refine.ts", anchor: "Cleanup: removed ${cleanedRateLimits}", priorSeverity: "console", severity: "debug" },
  { pkg: "dashboard", file: "sse.ts", anchor: "sseLog.debug(message)", priorSeverity: "console", severity: "debug" },
  { pkg: "dashboard", file: "terminal-service.ts", anchor: "Working directory is not a directory: ${cwd}", priorSeverity: "warn", severity: "debug" },
  { pkg: "dashboard", file: "terminal-service.ts", anchor: "Working directory does not exist: ${cwd}", priorSeverity: "warn", severity: "debug" },
  { pkg: "dashboard", file: "terminal-service.ts", anchor: "terminalLog.debug(`Session ${sessionId} not found`);", priorSeverity: "warn", severity: "debug" },
  { pkg: "dashboard", file: "terminal-service.ts", anchor: "Session ${sessionId} not found for resize", priorSeverity: "warn", severity: "debug" },
  /*
  FNXC:EngineDiagnostics 2026-08-01-18:11:
  TUI flood demotions from operator log review. Anchors must share a source line with
  `.debug(` (manifest is line-scoped). Multi-line sessionLog.debug setups, Tracking-task
  triple sites, and zero-recovery gates are pinned in the spam-contract suite instead.
  */
  { pkg: "engine", file: "triage.ts", anchor: "planLog.debug(`${task.id}: planning in ${leanPlanning ? \"fast\" : \"standard\"} mode`)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "session-token-usage.ts", anchor: "cacheMetricsLog.debug(JSON.stringify({", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "tokenCacheMetricsLog.debug(JSON.stringify({", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "runtimes/in-process-runtime.ts", anchor: "runtimeLog.debug(`Specifying ${t.id}...`)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "triage.ts", anchor: "planLog.debug(`${taskId}: failed to read PROMPT.md during ${context} (${promptPath}): ${msg}`)", priorSeverity: "warn", severity: "debug" },
  /*
  FNXC:EngineDiagnostics 2026-08-03-05:54:
  Operator TUI audit of a busy board: demote expected skips, schedule-trigger echoes,
  session/setup bookkeeping, and routine verification command-fail detail so default
  severity stays lifecycle transitions (Starting/Specifying/Worktree created/merge/move).
  */
  { pkg: "engine", file: "scheduler.ts", anchor: "No linked feature found for task ${taskId}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "scheduler.ts", anchor: "Task created — triggering scheduling", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "scheduler.ts", anchor: "Task moved to ${to} — triggering scheduling", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "auto-claim-snapshot.ts", anchor: "invalidate reason=${reason}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "agent-heartbeat.ts", anchor: "Assignment trigger skipped for ${agent.id} (ephemeral/internal)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "agent-heartbeat.ts", anchor: "Assignment trigger skipped for ${agent.id} (disabled)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "agent-heartbeat.ts", anchor: "Assignment trigger skipped for ${agent.id} (active run)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "runtimes/in-process-runtime.ts", anchor: "Scheduled task ${task.id}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "runtimes/in-process-runtime.ts", anchor: "Started executing task ${task.id} in ${worktreePath}", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "executorLog.debug(`${task.id}: executor runtime env injected", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "executorLog.debug(`${live.id}: graph node '${node.id}' runtime env injected", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "executorLog.debug(`${task.id}: workflow node '${nodeId}' acquired worktree", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "executorLog.debug(`${task.id}: captured baseCommitSha ${baseCommitSha.slice(0, 7)}`)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "executor.ts", anchor: "executorLog.debug(`${taskId}: reconcile step source governed by parse-steps", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "run-verification-tool.ts", anchor: "executorLog.debug(`[fn_run_verification] command failed (exit=", priorSeverity: "warn", severity: "debug" },
  { pkg: "engine", file: "worktree-acquisition.ts", anchor: "logger.debug(`Reusing existing worktree: ${path}`)", priorSeverity: "log", severity: "debug" },
  { pkg: "engine", file: "worktree-acquisition.ts", anchor: "logger.debug(`Reusing existing worktree: ${worktreePath}`)", priorSeverity: "log", severity: "debug" },
  { pkg: "core", file: "postgres/embedded-lifecycle.ts", anchor: "log.debug(`embedded postgres: already running on port", priorSeverity: "log", severity: "debug" },
];

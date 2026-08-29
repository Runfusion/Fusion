/**
 * FNXC:CodeOrganization 2026-07-22-18:00:
 * Domain folder layout for @fusion/engine (mirrors core/src organization).
 *
 * Root keepers (large entrypoints + public index):
 *   index.ts, executor.ts, merger.ts, self-healing.ts, triage.ts, scheduler.ts,
 *   project-engine.ts, project-engine-manager.ts, agent-tools.ts, agent-heartbeat.ts,
 *   pi.ts, logger.ts
 *
 * Domain folders:
 *   agents/ auth/ cli-runtime/ concurrency/ errors/ execution/ merge/
 *   missions/ overseer/ plugins/ project/ scheduling/ healing/ triage-domain/
 *   workflows/ worktree/ goals/ eval/ mcp/ util/ research/
 *
 * Pre-existing packages: cli-agent/, runtimes/, sandbox/, recovery/, ipc/, …
 * Import via @fusion/engine barrel when possible.
 */
export {};

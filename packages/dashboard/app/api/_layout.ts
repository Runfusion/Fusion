/**
 * FNXC:CodeOrganization 2026-07-22-16:00:
 * Domain folder layout for dashboard client API modules.
 *
 * client/    — fetch wrapper, health, dedupe, SSE
 * tasks/     — task CRUD, lifecycle, content, diff, steer
 * agents/    — agents, import/generation, run-audit/org
 * git/       — git remotes/PRs, github/gitlab import
 * missions/  — missions + interview streams
 * planning/  — planning mode, AI text/sessions, models, dev-server
 * projects/  — projects, remote, workspace files, board workflows
 * settings/  — settings, global/pi, provider status
 * chat/      — chat + messaging
 * system/    — system panel, insights, research, memory, todo, scheduling, workflows, plugins, report
 *
 * Stable public paths: app/api.ts → legacy.ts barrel; thin shims at old paths where needed.
 */
export {};

/**
 * FNXC:CodeOrganization 2026-07-22-16:00:
 * Domain folder layout for browser-safe core types (Vite aliases @fusion/core → types.ts).
 *
 * board/      — columns, priorities, board config
 * task/       — task model, logs, review, tracking, documents, todos
 * agents/     — agent entity, permissions, state
 * settings/   — global/project settings scope
 * merge/      — merge policy and merge queue
 * workflow/   — workflow steps and presets
 * messaging/  — mailbox/message types
 * mesh/       — multi-project, docker nodes, archive/planning mesh types
 * audit/      — run-audit and planner intervention
 * plugins/    — plugin activation
 * ui/         — execution modes, themes, locales
 *
 * Stable public path remains packages/core/src/types.ts (re-export barrel).
 */
export {};

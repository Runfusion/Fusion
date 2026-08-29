/**
 * The 14 built-in traits (U2, R7) from the Trait Vocabulary table. Behavior for
 * each trait lands in later units; here we ship the definitions (flags + config
 * schema + hook descriptors) and register them into the shared trait registry.
 *
 * The `merge` trait's config schema is a STUB here (shape only — strategy /
 * fileScope / squash / conflictStrategy); its behavior is U7.
 *
 * Registration is idempotent at module scope (registered once on import). Tests
 * that need a clean slate use `__resetTraitRegistryForTests()` +
 * `registerBuiltinTraits(registry)`.
 */

import type { TraitDefinition } from "./trait-types.js";
import { TraitRegistry, getTraitRegistry } from "./trait-registry.js";

/** The ids of the 14 built-in traits, in vocabulary-table order. */
export const BUILTIN_TRAIT_IDS = [
  "intake",
  "complete",
  "archived",
  "merge-blocker",
  "wip",
  "hold",
  "human-review",
  "gate",
  "merge",
  "abort-on-exit",
  "reset-on-entry",
  "timing",
  "stall-detection",
  "notify",
] as const;

export type BuiltinTraitId = (typeof BUILTIN_TRAIT_IDS)[number];

/** The built-in trait definitions. */
export const BUILTIN_TRAIT_DEFINITIONS: TraitDefinition[] = [
  {
    id: "intake",
    name: "Intake",
    description: "Where new cards land; exactly one per workflow.",
    builtin: true,
    flags: { intake: true },
    configSchema: {
      fields: [{ key: "autoTriage", type: "boolean", description: "Auto-triage new cards" }],
    },
  },
  {
    id: "complete",
    name: "Complete",
    description: "Terminal success; satisfies dependencies. Restricted flag.",
    builtin: true,
    flags: { complete: true },
  },
  {
    id: "archived",
    name: "Archived",
    description: "Hidden from board; global semantics. Restricted flag.",
    builtin: true,
    flags: { archived: true, hiddenFromBoard: true },
  },
  {
    id: "merge-blocker",
    name: "Merge blocker",
    description:
      "Generalized FN-5147: entry to complete-bound columns blocked until the merge-class node completed.",
    builtin: true,
    flags: { mergeBlocker: true },
    hooks: { guard: true },
  },
  {
    id: "wip",
    name: "WIP / capacity",
    description: "Substrate-enforced in-txn capacity limit; never bypassable (KTD-10).",
    builtin: true,
    flags: { countsTowardWip: true },
    configSchema: {
      fields: [
        { key: "limit", type: "number", description: "Max concurrent cards" },
        {
          key: "limitSetting",
          type: "enum",
          enumValues: ["maxConcurrent"],
          description: "Project setting that supplies the capacity limit",
        },
        { key: "countPending", type: "boolean", description: "Count mid-transition cards" },
      ],
    },
  },
  {
    id: "hold",
    name: "Hold",
    description: "Passive dwell; released by a configured condition.",
    builtin: true,
    flags: { hold: true },
    hooks: { releaseCondition: true },
    configSchema: {
      fields: [
        {
          key: "release",
          type: "enum",
          required: true,
          enumValues: ["manual", "timer", "capacity", "dependency", "external-event"],
          description: "Release condition kind (matches WorkflowHoldRelease)",
        },
      ],
    },
  },
  {
    id: "human-review",
    name: "Human review",
    description:
      "Card cannot leave until explicit human approval (approval state is a DB read — sync-safe). Not on the default workflow.",
    builtin: true,
    flags: { humanReview: true },
    hooks: { guard: true },
    configSchema: {
      fields: [
        { key: "approvers", type: "array", description: "Allowed approver ids" },
        { key: "checklist", type: "array", description: "Required checklist items" },
      ],
    },
  },
  {
    id: "gate",
    name: "Gate",
    description:
      "Workflow-step gate semantics generalized to columns; the plugin-facing gate surface. Blocking gates fail closed.",
    builtin: true,
    flags: { gate: true },
    hooks: { gate: true },
    configSchema: {
      fields: [
        {
          key: "gateMode",
          type: "enum",
          required: true,
          enumValues: ["blocking", "advisory"],
          description: "Blocking gates fail closed; advisory gates record and allow",
        },
        { key: "prompt", type: "string", description: "Gate prompt" },
        { key: "script", type: "string", description: "Gate script" },
      ],
    },
  },
  {
    id: "merge",
    name: "Merge",
    description:
      "Enqueues onto the merge-request queue; configures merge policy (U7). The lost-work guard trio stays capability-level and is unreachable from this config (KTD-6).",
    builtin: true,
    flags: { mergeOrchestration: true },
    hooks: { onEnter: true, onExit: true },
    configSchema: {
      fields: [
        {
          key: "strategy",
          type: "enum",
          // Direct-merge commit strategies (`DirectMergeCommitStrategy`) plus
          // `pr-only` (maps onto `mergeStrategy: "pull-request"`). Absent →
          // settings read-through (back-compat for the default workflow).
          enumValues: ["always-squash", "auto", "always-rebase", "pr-only"],
          description: "Merge strategy",
        },
        {
          key: "fileScope",
          type: "enum",
          // strict = throw on zero-overlap (today); warn = log + proceed (audit
          // carries the violating file list); off = skip the throw + emit one
          // per-merge "scope enforcement disabled" audit (per-task scopeOverride
          // is a documented no-op here); custom = evaluate `rules` in place of
          // the task's File Scope section.
          enumValues: ["strict", "warn", "off", "custom"],
          description: "File-scope enforcement mode",
        },
        {
          key: "rules",
          type: "array",
          description: "Custom file-scope glob/path rules (used when fileScope === 'custom')",
        },
        { key: "squash", type: "boolean", description: "Squash posture" },
        {
          key: "conflictStrategy",
          type: "string",
          description: "Conflict resolution strategy",
        },
      ],
    },
  },
  {
    id: "abort-on-exit",
    name: "Abort on exit",
    description: "Generalized hard-cancel; bypassed by engine-sourced moves (KTD-9).",
    builtin: true,
    flags: { abortOnExit: true },
    hooks: { onExit: true },
    configSchema: {
      fields: [
        {
          key: "direction",
          type: "enum",
          enumValues: ["backward", "any"],
          description: "Which exits trigger abort",
        },
        { key: "confirm", type: "boolean", description: "Require user confirmation" },
      ],
    },
  },
  {
    id: "reset-on-entry",
    name: "Reset on entry",
    description: "Legacy reopen-to-todo field/step resets.",
    builtin: true,
    flags: { resetOnEntry: true },
    hooks: { onEnter: true },
    configSchema: {
      fields: [
        { key: "preserveProgress", type: "boolean", description: "Keep progress fields" },
      ],
    },
  },
  {
    id: "timing",
    name: "Timing",
    description: "cumulativeActiveMs accounting generalized.",
    builtin: true,
    flags: { timing: true },
    hooks: { onEnter: true, onExit: true },
  },
  {
    id: "stall-detection",
    name: "Stall detection",
    description: "In-review stall signals generalized to any column (sweep-evaluated).",
    builtin: true,
    flags: { stallDetection: true },
    configSchema: {
      fields: [
        { key: "timeoutMs", type: "number", required: true, description: "Stall threshold" },
        {
          key: "action",
          type: "enum",
          enumValues: ["annotate", "notify", "move"],
          description: "Action on stall",
        },
      ],
    },
  },
  {
    id: "notify",
    name: "Notify",
    description: "Basic notifications; richer notification traits are the canonical plugin example.",
    builtin: true,
    flags: { notify: true },
    hooks: { onEnter: true, onExit: true },
    configSchema: {
      fields: [
        { key: "events", type: "array", description: "Events to notify on" },
        { key: "channel", type: "string", description: "Notification channel" },
      ],
    },
  },
];

/** Register all 14 built-in traits into the given registry (defaults to the
 *  shared registry). Idempotent guard for the shared instance lives in the
 *  module-scope registration below. */
export function registerBuiltinTraits(registry: TraitRegistry = getTraitRegistry()): void {
  for (const def of BUILTIN_TRAIT_DEFINITIONS) {
    if (registry.has(def.id)) continue;
    registry.register(def);
  }
}

// Register into the shared registry on import (idempotent via `has`).
registerBuiltinTraits();

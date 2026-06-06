/**
 * Board-team seeding (company-model U2, R8).
 *
 * Flag-gated step (`experimentalFeatures.companyModel`) that auto-creates the
 * durable named agents the company model relies on:
 *  - one project-level **CEO** (the global-chat router), and
 *  - per-board **Lead / Executor / Reviewer** staffed onto the board's three
 *    mandatory role columns (todo / in-progress / in-review) via
 *    {@link WorkflowColumnAgent} bindings in mode `"defer"` — so an advanced
 *    per-task agent/model override still wins (KTD column-agent precedence).
 *
 * Two entry points share one idempotent core:
 *  - {@link seedBoardTeam} — call at project registration (seeds CEO + every
 *    existing board) and as a startup backfill for projects created flag-off;
 *  - {@link seedBoardTeamForBoard} — call at board creation (seeds just that
 *    board's Lead/Executor/Reviewer).
 *
 * Idempotency (per `docs/solutions/logic-errors/branch-group-name-collision-strands-mission-triage.md`):
 * seeded agents carry stable identity in `metadata.companyRole` (+ `metadata.boardId`
 * for per-board roles), so re-running never duplicates. Display names are derived
 * from the board name but are NOT the identity key, so a board rename does not
 * orphan or re-create the team. A same-named USER agent that lacks the role marker
 * is adopted/promoted when it already has the matching role capability, else the
 * seed picks a disambiguated name — it is never blindly inserted on top of a
 * collision and never strands a binding to a non-existent agent.
 *
 * Permission policies are NEVER the unrestricted default (KTD): the CEO gets a
 * task-routing-only policy; Lead and Reviewer get policies that block command
 * execution (and git writes — spec/review work needs no shell); the Executor
 * carries the project's normal execution policy (`permissionPolicy` left unset
 * so it resolves to the project default).
 */

import type { AgentStore } from "./agent-store.js";
import type { TaskStore } from "./store.js";
import type { Agent, AgentCapability, AgentPermissionPolicy, Settings } from "./types.js";
import type { WorkflowIr, WorkflowIrColumn } from "./workflow-ir-types.js";
import { isExperimentalFeatureEnabled } from "./experimental-features.js";
import { normalizeAgentPermissionPolicy } from "./agent-permission-policy.js";
import { resolveWorkflowIrById } from "./workflow-ir-resolver.js";

/** The three mandatory role columns every company-model board carries, mapped to
 *  the role that staffs each one (R1). Column ids match the built-in coding IR. */
export const MANDATORY_ROLE_COLUMNS = [
  { columnId: "todo", role: "lead" as const, label: "Lead" },
  { columnId: "in-progress", role: "executor" as const, label: "Executor" },
  { columnId: "in-review", role: "reviewer" as const, label: "Reviewer" },
] as const;

/** The mandatory role-column ids, for staffing-constraint validation (U2). */
export const MANDATORY_ROLE_COLUMN_IDS: readonly string[] = MANDATORY_ROLE_COLUMNS.map(
  (c) => c.columnId,
);

/** Metadata marker keys identifying a seeded company-model agent. */
const COMPANY_ROLE_META = "companyRole";
const COMPANY_BOARD_META = "companyBoardId";

/**
 * Permission policy for a seeded role. Returns `undefined` for the Executor so
 * it resolves to the project's normal execution policy at runtime. Every other
 * role gets an explicit non-unrestricted `custom` policy.
 *
 * Category vocabulary: git_write / file_write_delete / command_execution /
 * network_api / task_agent_mutation. A blocked category denies the action class
 * outright; an allowed one passes it through.
 */
function policyForRole(role: AgentCapability): AgentPermissionPolicy | undefined {
  switch (role) {
    case "ceo":
      // Task-routing only: may create/route tasks; no shell, no git, no file or
      // network mutation. The CEO never executes work — it homes it on a board.
      return normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: {
          git_write: "block",
          file_write_delete: "block",
          command_execution: "block",
          network_api: "block",
          task_agent_mutation: "allow",
        },
      });
    case "lead":
      // Structures work (writes the spec/PROMPT.md, routes onward) but runs no
      // shell and touches no git — spec authoring needs neither.
      return normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: {
          git_write: "block",
          file_write_delete: "allow",
          command_execution: "block",
          network_api: "block",
          task_agent_mutation: "allow",
        },
      });
    case "reviewer":
      // Judges done and records feedback; no shell, no git. May write its
      // verdict/feedback (file_write_delete) and move the task (task_agent_mutation).
      return normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: {
          git_write: "block",
          file_write_delete: "allow",
          command_execution: "block",
          network_api: "block",
          task_agent_mutation: "allow",
        },
      });
    case "executor":
    default:
      // Carries the project's normal execution policy — left unset so
      // resolveEffectiveAgentPermissionPolicy applies the project default.
      return undefined;
  }
}

/** Result of a seeding pass: the resolved role→agentId map plus whether the
 *  flag gated it off (nothing seeded). */
export interface BoardTeamSeedResult {
  /** True when the company-model flag was off and nothing was created. */
  skipped: boolean;
  /** The CEO agent id (project-level), when seeded/resolved. */
  ceoAgentId?: string;
  /** Per-board role→agentId maps keyed by boardId. */
  boards: Record<string, Record<string, string>>;
}

/** Find a previously-seeded company-model agent by its stable role marker. */
function findSeededAgent(
  agents: Agent[],
  role: AgentCapability,
  boardId: string | null,
): Agent | undefined {
  return agents.find(
    (a) =>
      a.metadata?.[COMPANY_ROLE_META] === role &&
      (boardId === null
        ? a.metadata?.[COMPANY_BOARD_META] == null
        : a.metadata?.[COMPANY_BOARD_META] === boardId),
  );
}

/**
 * Resolve (creating if needed) the durable agent for one role, idempotently.
 *
 * Collision handling for a same-named USER agent that lacks our marker:
 *  - if it already carries the matching role capability, ADOPT it (stamp the
 *    seed markers so future runs recognize it) — never a duplicate;
 *  - otherwise pick a disambiguated name (` (Lead)` suffix, then numeric) so the
 *    user's agent is left untouched and the role is still staffed.
 */
async function ensureRoleAgent(
  agentStore: AgentStore,
  existing: Agent[],
  args: {
    role: AgentCapability;
    boardId: string | null;
    preferredName: string;
    roleLabel: string;
    soul: string;
  },
): Promise<Agent> {
  // 1. Already seeded under our marker → reuse verbatim.
  const seeded = findSeededAgent(existing, args.role, args.boardId);
  if (seeded) return seeded;

  const baseMeta: Record<string, unknown> = {
    [COMPANY_ROLE_META]: args.role,
    ...(args.boardId !== null ? { [COMPANY_BOARD_META]: args.boardId } : {}),
  };

  // 2. Same-named user agent without our marker.
  const collision = await agentStore.findAgentByName(args.preferredName);
  if (collision) {
    if (collision.role === args.role) {
      // Adopt/promote: stamp the markers so we recognize it next pass.
      return agentStore.updateAgent(collision.id, {
        metadata: { ...collision.metadata, ...baseMeta },
      });
    }
    // 3. Disambiguate — leave the user's agent untouched.
    const disambiguated = await resolveDisambiguatedName(agentStore, args.preferredName);
    return agentStore.createAgent({
      name: disambiguated,
      role: args.role,
      soul: args.soul,
      metadata: baseMeta,
      ...(policyForRole(args.role) ? { permissionPolicy: policyForRole(args.role) } : {}),
    });
  }

  // 4. Fresh create.
  return agentStore.createAgent({
    name: args.preferredName,
    role: args.role,
    soul: args.soul,
    metadata: baseMeta,
    ...(policyForRole(args.role) ? { permissionPolicy: policyForRole(args.role) } : {}),
  });
}

/** Pick the first non-colliding name `Base (n)` starting at 2. */
async function resolveDisambiguatedName(agentStore: AgentStore, base: string): Promise<string> {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!(await agentStore.hasNonEphemeralAgentWithName(candidate))) return candidate;
  }
  // Extremely unlikely; fall back to a unique-ish suffix.
  return `${base} (${Date.now()})`;
}

/**
 * Stamp `agent` column bindings (mode `"defer"`) onto the role columns of `ir`,
 * returning a new IR. Columns absent from the IR are skipped (a board converted
 * from a non-default workflow may not carry every role column yet — U3 owns the
 * template; this seam only staffs columns that exist).
 */
function applyTeamBindings(
  ir: WorkflowIr,
  roleAgentIds: Record<string, string>,
): WorkflowIr {
  // parseWorkflowIr upgrades v1→v2, so resolved IRs carry columns; guard the
  // type-union anyway (a v1 graph has no columns to staff).
  if (ir.version !== "v2") return ir;
  const columns: WorkflowIrColumn[] = ir.columns.map((col) => {
    const match = MANDATORY_ROLE_COLUMNS.find((c) => c.columnId === col.id);
    if (!match) return col;
    const agentId = roleAgentIds[match.role];
    if (!agentId) return col;
    return { ...col, agent: { agentId, mode: "defer" } };
  });
  return { ...ir, columns };
}

/**
 * Persist the team bindings for one board: resolve the board's IR, stamp the
 * role columns, and store it as a board-owned custom workflow that the board
 * points at. Idempotent — re-running re-stamps the same agent ids (no churn of
 * identity) and reuses the board's existing seeded workflow when present.
 *
 * Returns the role→agentId map actually staffed.
 */
async function staffBoardColumns(
  taskStore: TaskStore,
  agentStore: AgentStore,
  boardId: string,
  existingAgents: Agent[],
): Promise<Record<string, string>> {
  const boardStore = taskStore.getBoardStore();
  const board = boardStore.getBoard(boardId);
  if (!board) return {};

  // Resolve the agents for each role (idempotent).
  const roleAgentIds: Record<string, string> = {};
  for (const { role, label } of MANDATORY_ROLE_COLUMNS) {
    const agent = await ensureRoleAgent(agentStore, existingAgents, {
      role,
      boardId,
      preferredName: `${label} (${board.name})`,
      roleLabel: label,
      soul: `The ${label} for board "${board.name}".`,
    });
    roleAgentIds[role] = agent.id;
    // Keep the in-memory roster fresh so a second role on the same pass sees it.
    if (!existingAgents.some((a) => a.id === agent.id)) existingAgents.push(agent);
  }

  // Resolve the board's current IR and stamp the bindings.
  const baseIr = await resolveWorkflowIrById(taskStore, board.workflowId);
  const stampedIr = applyTeamBindings(baseIr, roleAgentIds);

  // Persist as a board-owned workflow when the board still points at a built-in
  // (or a workflow that doesn't yet carry our bindings). A board that already
  // points at a seeded custom workflow is updated in place.
  const ownsCustomWorkflow =
    !isBuiltinish(board.workflowId) && (await workflowCarriesTeam(taskStore, board.workflowId, roleAgentIds));
  if (ownsCustomWorkflow) {
    return roleAgentIds;
  }

  if (isBuiltinish(board.workflowId)) {
    const def = await taskStore.createWorkflowDefinition({
      name: `${board.name} — team`,
      description: `Auto-seeded company-model team workflow for board "${board.name}".`,
      ir: stampedIr,
    });
    boardStore.updateBoard(boardId, { workflowId: def.id });
  } else {
    await taskStore.updateWorkflowDefinition(board.workflowId, { ir: stampedIr });
  }
  return roleAgentIds;
}

/** True for a built-in workflow id the board should be re-pointed off of. */
function isBuiltinish(workflowId: string): boolean {
  return workflowId.startsWith("builtin:");
}

/** True when the named workflow's role columns already bind the given agents. */
async function workflowCarriesTeam(
  taskStore: TaskStore,
  workflowId: string,
  roleAgentIds: Record<string, string>,
): Promise<boolean> {
  const ir = await resolveWorkflowIrById(taskStore, workflowId);
  if (ir.version !== "v2") return false;
  return MANDATORY_ROLE_COLUMNS.every(({ columnId, role }) => {
    const col = ir.columns.find((c) => c.id === columnId);
    return col?.agent?.agentId === roleAgentIds[role];
  });
}

/**
 * Seed (or backfill) a project's company-model team: one CEO plus every existing
 * board's Lead/Executor/Reviewer. Idempotent and flag-gated.
 *
 * @returns a {@link BoardTeamSeedResult}; `skipped: true` when the flag is off.
 */
export async function seedBoardTeam(args: {
  taskStore: TaskStore;
  agentStore: AgentStore;
  settings: Pick<Settings, "experimentalFeatures">;
}): Promise<BoardTeamSeedResult> {
  const { taskStore, agentStore, settings } = args;
  if (!isExperimentalFeatureEnabled(settings, "companyModel")) {
    return { skipped: true, boards: {} };
  }

  const existingAgents = await agentStore.listAgents({ includeEphemeral: false });

  // 1. Project-level CEO (one per project).
  const ceo = await ensureRoleAgent(agentStore, existingAgents, {
    role: "ceo",
    boardId: null,
    preferredName: "CEO",
    roleLabel: "CEO",
    soul: "The project CEO: routes global-chat requests onto the right board's Todo queue.",
  });
  if (!existingAgents.some((a) => a.id === ceo.id)) existingAgents.push(ceo);

  // 2. Per-board teams.
  const boards = taskStore.getBoardStore().listBoards();
  const boardMaps: Record<string, Record<string, string>> = {};
  for (const board of boards) {
    boardMaps[board.id] = await staffBoardColumns(taskStore, agentStore, board.id, existingAgents);
  }

  return { skipped: false, ceoAgentId: ceo.id, boards: boardMaps };
}

/**
 * Seed one board's team (Lead/Executor/Reviewer) at board-creation time.
 * Assumes the project-level CEO already exists (seeded at registration); does
 * not create it. Flag-gated and idempotent.
 */
export async function seedBoardTeamForBoard(args: {
  taskStore: TaskStore;
  agentStore: AgentStore;
  settings: Pick<Settings, "experimentalFeatures">;
  boardId: string;
}): Promise<Record<string, string>> {
  const { taskStore, agentStore, settings, boardId } = args;
  if (!isExperimentalFeatureEnabled(settings, "companyModel")) return {};
  const existingAgents = await agentStore.listAgents({ includeEphemeral: false });
  return staffBoardColumns(taskStore, agentStore, boardId, existingAgents);
}

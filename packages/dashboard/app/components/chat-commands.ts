/**
 * Generic slash-command registry for chat composers.
 *
 * This module is deliberately small and additive: it defines the shape of a
 * dispatchable chat command and a starter registry containing exactly one
 * entry (`/steer`). Adding the next command (e.g. `/retry`) is a matter of
 * appending another `ChatCommand` entry — no changes to the matching/
 * filtering helpers below are required.
 *
 * The registry is consumed by composer hosts (e.g. ChatView.tsx,
 * TaskPlannerChatTab.tsx) which own:
 *   - trigger detection / menu rendering (reusing the existing "/" trigger
 *     scaffolding already used for skill autocomplete), and
 *   - dispatch-on-submit (deciding whether the current composer text
 *     matches a registered command and, if so, calling `run()` instead of
 *     sending a normal chat message).
 *
 * `/steer` specifically requires a bound task with a running/active agent;
 * callers are responsible for gating dispatch on that (this module has no
 * opinion on task/agent state — it only matches text and executes actions).
 */
import { addSteeringComment } from "../api";

/** Context passed to a command's `run()` at dispatch time. */
export interface CommandContext {
  /** The task this composer is bound to. */
  taskId: string;
  /** Optional project scope, forwarded to API calls exactly like existing composers do. */
  projectId?: string;
  /** Text following the trigger (and separating space), already trimmed. */
  remainder: string;
}

export interface ChatCommand {
  /** Slash trigger, including the leading "/" (e.g. "/steer"). Matched at the start of composer text only — never mid-message. */
  trigger: string;
  /** Short identifier (without the leading "/") used for menu filtering. */
  name: string;
  /** Human-readable description shown in the "/" menu. */
  description: string;
  /** Executes the command's action. Resolves/rejects to let the caller show success/error feedback. */
  run(ctx: CommandContext): Promise<unknown>;
}

/**
 * The command registry. `/steer` sends the remainder text to the task's
 * running agent via the existing steering endpoint (`addSteeringComment`),
 * exactly as the task-detail Activity composer already does — this is a new
 * entry point into that same, already-shipped mechanism, not a new backend
 * behavior.
 */
export const CHAT_COMMANDS: ChatCommand[] = [
  {
    trigger: "/steer",
    name: "steer",
    description: "Send context to the running agent without interrupting it",
    run(ctx: CommandContext) {
      return addSteeringComment(ctx.taskId, ctx.remainder, ctx.projectId);
    },
  },
];

export interface ChatCommandMatch {
  command: ChatCommand;
  remainder: string;
}

/**
 * Matches composer text against a registered command trigger for
 * dispatch-on-submit.
 *
 * Only matches when:
 *   - the trigger appears at the very start of the text (never mid-message —
 *     e.g. "hey /steer this" does not match), and
 *   - the trigger is followed by a space and at least one non-whitespace
 *     remainder character (e.g. "/steer" alone with nothing after it is not
 *     a dispatchable match and falls through to normal send behavior).
 */
export function matchChatCommand(text: string, commands: ChatCommand[] = CHAT_COMMANDS): ChatCommandMatch | null {
  for (const command of commands) {
    const prefix = `${command.trigger} `;
    if (!text.startsWith(prefix)) {
      continue;
    }
    const remainder = text.slice(prefix.length).trim();
    if (remainder.length === 0) {
      continue;
    }
    return { command, remainder };
  }
  return null;
}

/**
 * Filters the command registry using the same free-text filter already
 * derived from the "/" skill-trigger match (the text typed after the
 * slash), so the menu can show commands and skills side by side using one
 * shared filter value.
 */
export function filterChatCommands(filter: string, commands: ChatCommand[] = CHAT_COMMANDS): ChatCommand[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) {
    return commands;
  }
  return commands.filter((command) =>
    command.name.toLowerCase().includes(normalized)
    || command.trigger.slice(1).toLowerCase().includes(normalized),
  );
}

export interface SlashTriggerMatch {
  /** Text typed after the "/" (used to filter both skills and commands). */
  filter: string;
  start: number;
  end: number;
}

/**
 * Shared "/" trigger-detection helper reused by every chat composer that
 * wants the command/skill menu (ChatView.tsx's own `getSkillTriggerMatch` is
 * a thin alias of this function so there is exactly one implementation of
 * this regex in the dashboard package, not a second divergent copy).
 *
 * Matches a "/" at the start of the text or after whitespace, followed by
 * zero or more non-whitespace characters, anchored at the end of the value
 * (i.e. the trigger must be the token the caret is currently typing).
 */
export function getSlashTriggerMatch(value: string): SlashTriggerMatch | null {
  const triggerMatch = /(^|[\s])\/([^\s]*)$/.exec(value);
  if (!triggerMatch) {
    return null;
  }

  const prefix = triggerMatch[1] ?? "";
  const filter = triggerMatch[2] ?? "";
  const start = triggerMatch.index + prefix.length;
  return {
    filter,
    start,
    end: value.length,
  };
}

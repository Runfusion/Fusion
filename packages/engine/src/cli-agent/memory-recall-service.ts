/**
 * Per-turn memory recall service for CLI-agent chat turns (RUFU-128, Step 6).
 *
 * Thin wrapper over the RUFU-120 core (`buildPerTurnMemoryRecallCue`) for the
 * CLI-agent PTY chat path: the `/api/cli-agent/memory-recall` route (and,
 * transitively, the Claude `UserPromptSubmit` hook / pi `before_agent_start`
 * extension it serves) calls this with the operator prompt as the topic.
 *
 * Contract:
 *
 * - Session key `cli:<sessionId>`: the core's session-scoped dedup registry
 *   keeps an already-injected cue from being repeated within the same CLI
 *   session while a different session still gets its own cue.
 * - FRESH settings per call (the caller passes the just-read settings — no
 *   caching here): a live memory toggle takes effect on the next prompt.
 * - top-K comes from the per-turn recall setting INSIDE the core
 *   (`memoryPerTurnRecallTopK`) — no separate knob is added here.
 * - NEVER throws: the core's silent-skip contract returns "" (settings off,
 *   no keywords, backend unavailable, no surviving results); the try/catch is
 *   belt-and-braces so the route's 202-empty-cue guarantee holds even for a
 *   future core regression.
 */

import { buildPerTurnMemoryRecallCue } from "@fusion/core";
import type { Settings } from "@fusion/core";

export interface MemoryRecallChatTurnInput {
  /** Project root to resolve the memory backend against. */
  rootDir: string;
  /** Current-topic text (the operator prompt the CLI agent is processing). */
  topic: string;
  /** Live CLI session id (dedup key becomes `cli:<sessionId>`). */
  sessionId: string;
  /** Fresh settings read for this call (absent → core defaults). */
  settings?: Partial<Settings> | null;
}

/**
 * Run one per-turn memory recall for a CLI chat turn. Resolves to the cue
 * string, or "" on silent skip. Never rejects.
 */
export async function recallForChatTurn(input: MemoryRecallChatTurnInput): Promise<string> {
  try {
    return await buildPerTurnMemoryRecallCue({
      rootDir: input.rootDir,
      topic: input.topic,
      // The core's option is `Partial<Settings> | undefined` — normalize a
      // `null` settings read (a failed/cleared getter) to undefined.
      settings: input.settings ?? undefined,
      sessionKey: `cli:${input.sessionId}`,
    });
  } catch {
    return "";
  }
}

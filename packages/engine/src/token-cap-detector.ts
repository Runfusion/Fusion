/**
 * Token cap detector for proactive context compaction.
 *
 * Monitors token usage during agent execution and triggers context compaction
 * when the token count reaches a configurable cap. This prevents context
 * overflow errors and improves reliability of long-running tasks.
 *
 * When no cap is configured (tokenCap is undefined), the system behaves as
 * before — compacting only on overflow errors via the existing error handler.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { executorLog } from "./logger.js";

/** Result of a token cap check-and-compact operation. */
export interface TokenCapCheckResult {
  /** Whether compaction was triggered. */
  triggered: boolean;
  /** Token count before compaction (only set when triggered). */
  tokensBefore?: number;
  /** Human-readable description of what happened. */
  message?: string;
}

/**
 * Detects when token usage exceeds a configurable cap and triggers context compaction.
 *
 * This enables proactive context management before the model's context window fills up,
 * preventing overflow errors and improving reliability of long-running tasks.
 */
export class TokenCapDetector {
  /**
   * Check if token usage exceeds the cap and compact if needed.
   *
   * @param session - The agent session to check and potentially compact
   * @param taskId - Task ID for logging
   * @param tokenCap - The configured token cap, or undefined if not set
   * @param compactFn - Function to call for compaction (injectable for testing)
   * @returns Result indicating whether compaction was triggered
   */
  async checkAndCompact(
    session: AgentSession,
    taskId: string,
    tokenCap: number | undefined,
    compactFn: (session: AgentSession) => Promise<{ tokensBefore: number } | null>,
  ): Promise<TokenCapCheckResult> {
    // No cap configured - don't check
    if (tokenCap === undefined) {
      return { triggered: false, message: "token cap not configured" };
    }

    const usage = session.getContextUsage();

    // Can't determine usage - don't attempt compaction
    if (!usage || usage.tokens === null) {
      return { triggered: false, message: "context usage unknown" };
    }

    const currentTokens = usage.tokens;

    // Token count is below cap - no action needed
    if (currentTokens < tokenCap) {
      executorLog.log(`${taskId} token check: ${currentTokens} < ${tokenCap} — no action`);
      return { triggered: false, message: `tokens ${currentTokens} < cap ${tokenCap}` };
    }

    // Token count at or above cap - trigger compaction
    executorLog.log(`${taskId} token cap reached (${currentTokens} >= ${tokenCap}) — compacting context`);

    const result = await compactFn(session);
    if (result) {
      return {
        triggered: true,
        tokensBefore: result.tokensBefore,
        message: `compacted at ${result.tokensBefore} tokens`,
      };
    }

    return { triggered: false, message: "compaction failed or unavailable" };
  }
}

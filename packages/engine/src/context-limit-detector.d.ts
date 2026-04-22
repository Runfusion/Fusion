/**
 * Context limit error detection.
 *
 * Classifies errors from LLM providers that indicate the conversation context
 * has grown too large for the model's window. Used by the executor to trigger
 * compact-and-resume recovery before falling back to kill/requeue.
 *
 * Patterns are intentionally conservative — we only match errors that
 * explicitly reference context/token overflow, NOT generic rate limits or
 * server errors (those are handled by usage-limit-detector and transient-error-detector).
 */
/**
 * Check if an error message indicates a context-window overflow.
 *
 * Returns true only when the message explicitly references context overflow
 * from a known LLM provider pattern. Returns false for:
 * - Rate limit errors (handled by usage-limit-detector)
 * - Transient network errors (handled by transient-error-detector)
 * - Generic "limit exceeded" without context keywords (false positive prevention)
 * - "Aborted" errors without context signal
 *
 * @param message — The error message string to classify
 * @returns true if the message indicates a context overflow
 */
export declare function isContextLimitError(message: string): boolean;
//# sourceMappingURL=context-limit-detector.d.ts.map
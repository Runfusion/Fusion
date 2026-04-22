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
/** Patterns that indicate a context-window overflow from the LLM provider. */
const CONTEXT_OVERFLOW_PATTERNS = [
    // Anthropic: "prompt is too long: X tokens > Y maximum"
    /prompt is too long/i,
    // OpenAI (Completions & Responses): "exceeds the context window"
    /exceeds?\s+the\s+context\s+window/i,
    // Google Gemini: "input token count exceeds the maximum"
    /input token count exceeds/i,
    // xAI (Grok): "maximum prompt length is X but request contains Y"
    /maximum prompt length/i,
    // Groq: "reduce the length of the messages"
    /reduce the length of the messages/i,
    // Mistral: "too large for model with Y maximum context length"
    /too large for model with.*maximum context length/i,
    // OpenRouter (all backends): "maximum context length is X tokens"
    /maximum context length is \d+ tokens/i,
    // llama.cpp: "exceeds the available context size"
    /exceeds?\s+the\s+available\s+context\s+size/i,
    // LM Studio: "greater than the context length"
    /greater than the context length/i,
    // Kimi: "exceeded model token limit"
    /exceeded model token limit/i,
    // Generic catch-all: "context length exceeded" / "context window exceeded"
    /context (?:length|window|size) exceeded/i,
    // Token limit patterns with context keywords
    /token limit.*context/i,
    /too many tokens/i,
    // Anthropic variant: "messages with that many tokens would exceed"
    /tokens? would exceed/i,
    // Provider JSON error envelope variant: "context window exceeds limit (2013)"
    // Matches when "context window" and "exceeds" appear together (order-flexible)
    /context\s+window\s+exceeds/i,
];
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
export function isContextLimitError(message) {
    if (!message)
        return false;
    return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}
//# sourceMappingURL=context-limit-detector.js.map
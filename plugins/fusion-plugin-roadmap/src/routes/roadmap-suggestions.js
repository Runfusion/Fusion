let injectedCreateAiSession;
export const MILESTONE_SUGGESTION_SYSTEM_PROMPT = `You are a milestone planning assistant for a product roadmap system.

Your job is to suggest logical milestones that would help achieve a user's roadmap goal.

## Guidelines

1. **Think about phases**: Break the goal into logical phases
2. **Use clear titles**: Milestone titles should be concise and descriptive
3. **Add context**: Include a brief description explaining what this milestone encompasses
4. **Order matters**: List milestones in the order they should be completed
5. **Realistic scope**: Each milestone should be achievable in 2-4 weeks

## Output Format

Respond with ONLY a valid JSON array of milestone suggestions.`;
const MAX_GOAL_PROMPT_LENGTH = 4000;
export const SUGGESTION_TIMEOUT_MS = 120_000;
const DEFAULT_SUGGESTION_COUNT = 5;
const MAX_SUGGESTION_COUNT = 10;
const MIN_SUGGESTION_COUNT = 1;
const MAX_PARSE_RETRIES = 1;
export function validateSuggestionInput(input) {
    if (!input || typeof input !== "object") {
        throw new ValidationError("Request body must be an object");
    }
    const { goalPrompt, count } = input;
    if (typeof goalPrompt !== "string" || !goalPrompt.trim()) {
        throw new ValidationError("goalPrompt is required and must be a non-empty string");
    }
    if (goalPrompt.length > MAX_GOAL_PROMPT_LENGTH) {
        throw new ValidationError(`goalPrompt exceeds maximum length of ${MAX_GOAL_PROMPT_LENGTH} characters`);
    }
    if (count !== undefined) {
        if (typeof count !== "number" || !Number.isInteger(count))
            throw new ValidationError("count must be an integer");
        if (count < MIN_SUGGESTION_COUNT || count > MAX_SUGGESTION_COUNT) {
            throw new ValidationError(`count must be between ${MIN_SUGGESTION_COUNT} and ${MAX_SUGGESTION_COUNT}`);
        }
    }
}
function extractJsonCandidate(text) {
    if (!text || !text.trim())
        return null;
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const source = codeBlockMatch?.[1]?.trim() || text.trim();
    const startIndex = source.indexOf("[");
    if (startIndex < 0)
        return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < source.length; index++) {
        const char = source[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "[")
            depth++;
        if (char === "]") {
            depth--;
            if (depth === 0) {
                return source.slice(startIndex, index + 1).trim();
            }
        }
    }
    return source.slice(startIndex).trim();
}
function repairJson(text) {
    let repaired = text.replace(/,\s*([}\]])/g, "$1");
    let depthBraces = 0;
    let depthBrackets = 0;
    for (const ch of repaired) {
        if (ch === "{")
            depthBraces++;
        if (ch === "}")
            depthBraces--;
        if (ch === "[")
            depthBrackets++;
        if (ch === "]")
            depthBrackets--;
    }
    repaired += "]".repeat(Math.max(0, depthBrackets));
    repaired += "}".repeat(Math.max(0, depthBraces));
    return repaired;
}
function parseMilestoneSuggestions(text) {
    const candidate = extractJsonCandidate(text);
    if (!candidate)
        throw new ParseError("AI returned no valid JSON. Please try again.");
    let parsed;
    try {
        parsed = JSON.parse(candidate);
    }
    catch {
        parsed = JSON.parse(repairJson(candidate));
    }
    if (!Array.isArray(parsed)) {
        throw new ParseError("AI response must be a JSON array of milestone suggestions");
    }
    const suggestions = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object")
            continue;
        const row = item;
        if (typeof row.title !== "string" || !row.title.trim())
            continue;
        suggestions.push({
            title: row.title.trim(),
            description: typeof row.description === "string" && row.description.trim() ? row.description.trim() : undefined,
        });
    }
    if (suggestions.length === 0)
        throw new ParseError("AI returned no valid milestone suggestions");
    return suggestions;
}
function pickFactory(explicit) {
    return explicit ?? injectedCreateAiSession;
}
async function runPrompt(createAiSession, options, prompt) {
    const agent = await createAiSession(options);
    await agent.session.prompt(prompt);
    const lastMessage = agent.session.state.messages
        .filter((m) => m.role === "assistant")
        .pop();
    let text = "";
    if (lastMessage?.content) {
        if (typeof lastMessage.content === "string")
            text = lastMessage.content;
        else {
            text = lastMessage.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("");
        }
    }
    return { text, dispose: agent.session.dispose };
}
export async function generateMilestoneSuggestions(goalPrompt, count = DEFAULT_SUGGESTION_COUNT, rootDir, modelProvider, modelId, createAiSession) {
    const factory = pickFactory(createAiSession);
    if (!factory)
        throw new ServiceUnavailableError("AI service is not available");
    if (!rootDir)
        throw new Error("rootDir is required for AI-powered suggestion generation");
    const result = await Promise.race([
        (async () => {
            let dispose;
            try {
                let response = await runPrompt(factory, {
                    cwd: rootDir,
                    systemPrompt: MILESTONE_SUGGESTION_SYSTEM_PROMPT,
                    tools: "readonly",
                    ...(modelProvider && modelId ? { defaultProvider: modelProvider, defaultModelId: modelId } : {}),
                }, `Please suggest ${count} milestones for the following roadmap goal:\n\n${goalPrompt.trim()}`);
                dispose = response.dispose;
                let suggestions;
                let lastError;
                for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
                    try {
                        suggestions = parseMilestoneSuggestions(response.text);
                        break;
                    }
                    catch (error) {
                        lastError = error instanceof Error ? error : new Error(String(error));
                        if (attempt === MAX_PARSE_RETRIES)
                            break;
                        response = await runPrompt(factory, {
                            cwd: rootDir,
                            systemPrompt: MILESTONE_SUGGESTION_SYSTEM_PROMPT,
                            tools: "readonly",
                            ...(modelProvider && modelId ? { defaultProvider: modelProvider, defaultModelId: modelId } : {}),
                        }, "Your previous response could not be parsed as JSON. Respond with only a JSON array.");
                        dispose = response.dispose;
                    }
                }
                if (!suggestions) {
                    throw new ParseError(`Failed to parse AI response after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError?.message ?? "Unknown error"}`);
                }
                return suggestions.slice(0, count);
            }
            finally {
                dispose?.();
            }
        })(),
        new Promise((_, reject) => globalThis.setTimeout(() => reject(new ServiceUnavailableError("AI suggestion generation timed out. Please try again.")), SUGGESTION_TIMEOUT_MS)),
    ]);
    return result;
}
export const FEATURE_SUGGESTION_SYSTEM_PROMPT = `You are a feature planning assistant for a product roadmap system.`;
const MAX_FEATURE_PROMPT_LENGTH = 2000;
export function validateFeatureSuggestionInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ValidationError("Request body must be an object");
    const { prompt, count } = input;
    if (prompt !== undefined) {
        if (typeof prompt !== "string")
            throw new ValidationError("prompt must be a string");
        if (prompt.length > MAX_FEATURE_PROMPT_LENGTH)
            throw new ValidationError(`prompt exceeds maximum length of ${MAX_FEATURE_PROMPT_LENGTH} characters`);
    }
    if (count !== undefined) {
        if (typeof count !== "number" || !Number.isInteger(count))
            throw new ValidationError("count must be an integer");
        if (count < MIN_SUGGESTION_COUNT || count > MAX_SUGGESTION_COUNT) {
            throw new ValidationError(`count must be between ${MIN_SUGGESTION_COUNT} and ${MAX_SUGGESTION_COUNT}`);
        }
    }
}
function buildMilestoneContextString(context) {
    const lines = [];
    lines.push(`Roadmap: ${context.roadmapTitle}`);
    if (context.roadmapDescription)
        lines.push(`Description: ${context.roadmapDescription}`);
    lines.push("", `Milestone: ${context.milestoneTitle}`);
    if (context.milestoneDescription)
        lines.push(`Description: ${context.milestoneDescription}`);
    if (context.existingFeatureTitles.length > 0) {
        lines.push("", "Existing features in this milestone:");
        for (const title of context.existingFeatureTitles)
            lines.push(`  - ${title}`);
    }
    return lines.join("\n");
}
function parseFeatureSuggestions(text) {
    return parseMilestoneSuggestions(text);
}
export async function generateFeatureSuggestions(context, count = DEFAULT_SUGGESTION_COUNT, prompt, rootDir, modelProvider, modelId, createAiSession) {
    const factory = pickFactory(createAiSession);
    if (!factory)
        throw new ServiceUnavailableError("AI service is not available");
    if (!rootDir)
        throw new Error("rootDir is required for AI-powered suggestion generation");
    const systemPrompt = `${FEATURE_SUGGESTION_SYSTEM_PROMPT}\n\n${buildMilestoneContextString(context)}`;
    const userMessage = prompt?.trim()
        ? `Please suggest ${count} features for the milestone described above.\n\nAdditional guidance:\n${prompt.trim()}`
        : `Please suggest ${count} features for the milestone described above.`;
    const result = await Promise.race([
        (async () => {
            const { text, dispose } = await runPrompt(factory, {
                cwd: rootDir,
                systemPrompt,
                tools: "readonly",
                ...(modelProvider && modelId ? { defaultProvider: modelProvider, defaultModelId: modelId } : {}),
            }, userMessage);
            try {
                return parseFeatureSuggestions(text).slice(0, count);
            }
            finally {
                dispose?.();
            }
        })(),
        new Promise((_, reject) => globalThis.setTimeout(() => reject(new ServiceUnavailableError("AI suggestion generation timed out. Please try again.")), SUGGESTION_TIMEOUT_MS)),
    ]);
    return result;
}
export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValidationError";
    }
}
export class ParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "ParseError";
    }
}
export class ServiceUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "ServiceUnavailableError";
    }
}
export function __resetSuggestionState() {
    injectedCreateAiSession = undefined;
}
export function __setCreateFnAgent(mock) {
    if (!mock) {
        injectedCreateAiSession = undefined;
        return;
    }
    injectedCreateAiSession = async (options) => mock(options);
}
export function __setCreateAiSessionFactory(mock) {
    injectedCreateAiSession = mock;
}
//# sourceMappingURL=roadmap-suggestions.js.map
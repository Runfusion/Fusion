import type { CreateAiSessionFactory } from "@fusion/core";
type LegacyCreateFnAgent = (options: {
    cwd: string;
    systemPrompt: string;
    tools?: "coding" | "readonly";
    defaultProvider?: string;
    defaultModelId?: string;
    onThinking?: () => void;
    onText?: () => void;
}) => Promise<{
    session: {
        prompt(text: string): Promise<void>;
        state: {
            messages: Array<{
                role: string;
                content?: string | Array<{
                    type: string;
                    text: string;
                }>;
            }>;
        };
        dispose?: () => void;
    };
}>;
export interface GenerateMilestoneSuggestionsInput {
    goalPrompt: string;
    count?: number;
}
export interface MilestoneSuggestion {
    title: string;
    description?: string;
}
export declare const MILESTONE_SUGGESTION_SYSTEM_PROMPT = "You are a milestone planning assistant for a product roadmap system.\n\nYour job is to suggest logical milestones that would help achieve a user's roadmap goal.\n\n## Guidelines\n\n1. **Think about phases**: Break the goal into logical phases\n2. **Use clear titles**: Milestone titles should be concise and descriptive\n3. **Add context**: Include a brief description explaining what this milestone encompasses\n4. **Order matters**: List milestones in the order they should be completed\n5. **Realistic scope**: Each milestone should be achievable in 2-4 weeks\n\n## Output Format\n\nRespond with ONLY a valid JSON array of milestone suggestions.";
export declare const SUGGESTION_TIMEOUT_MS = 120000;
export declare function validateSuggestionInput(input: unknown): asserts input is GenerateMilestoneSuggestionsInput;
export declare function generateMilestoneSuggestions(goalPrompt: string, count?: number, rootDir?: string, modelProvider?: string, modelId?: string, createAiSession?: CreateAiSessionFactory): Promise<MilestoneSuggestion[]>;
export interface GenerateFeatureSuggestionsInput {
    prompt?: string;
    count?: number;
}
export interface FeatureSuggestion {
    title: string;
    description?: string;
}
export interface FeatureSuggestionContext {
    roadmapTitle: string;
    roadmapDescription?: string;
    milestoneTitle: string;
    milestoneDescription?: string;
    existingFeatureTitles: string[];
}
export declare const FEATURE_SUGGESTION_SYSTEM_PROMPT = "You are a feature planning assistant for a product roadmap system.";
export declare function validateFeatureSuggestionInput(input: unknown): asserts input is GenerateFeatureSuggestionsInput;
export declare function generateFeatureSuggestions(context: FeatureSuggestionContext, count?: number, prompt?: string, rootDir?: string, modelProvider?: string, modelId?: string, createAiSession?: CreateAiSessionFactory): Promise<FeatureSuggestion[]>;
export declare class ValidationError extends Error {
    constructor(message: string);
}
export declare class ParseError extends Error {
    constructor(message: string);
}
export declare class ServiceUnavailableError extends Error {
    constructor(message: string);
}
export declare function __resetSuggestionState(): void;
export declare function __setCreateFnAgent(mock: LegacyCreateFnAgent | undefined): void;
export declare function __setCreateAiSessionFactory(mock: CreateAiSessionFactory | undefined): void;
export {};
//# sourceMappingURL=roadmap-suggestions.d.ts.map
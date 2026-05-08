import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const roadmapSuggestions = require("../../../plugins/fusion-plugin-roadmap/src/routes/roadmap-suggestions.js") as Record<string, unknown>;

export const FEATURE_SUGGESTION_SYSTEM_PROMPT = roadmapSuggestions.FEATURE_SUGGESTION_SYSTEM_PROMPT as string;
export const MILESTONE_SUGGESTION_SYSTEM_PROMPT = roadmapSuggestions.MILESTONE_SUGGESTION_SYSTEM_PROMPT as string;
export const ParseError = roadmapSuggestions.ParseError as new (message: string) => Error;
export const ServiceUnavailableError = roadmapSuggestions.ServiceUnavailableError as new (message: string) => Error;
export const SUGGESTION_TIMEOUT_MS = roadmapSuggestions.SUGGESTION_TIMEOUT_MS as number;
export const ValidationError = roadmapSuggestions.ValidationError as new (message: string) => Error;
export const __resetSuggestionState = roadmapSuggestions.__resetSuggestionState as () => void;
export const __setCreateAiSessionFactory = roadmapSuggestions.__setCreateAiSessionFactory as (factory: unknown) => void;
export const __setCreateFnAgent = roadmapSuggestions.__setCreateFnAgent as (factory: unknown) => void;
export const generateFeatureSuggestions = roadmapSuggestions.generateFeatureSuggestions as (...args: unknown[]) => Promise<unknown>;
export const generateMilestoneSuggestions = roadmapSuggestions.generateMilestoneSuggestions as (...args: unknown[]) => Promise<unknown>;
export const validateFeatureSuggestionInput = roadmapSuggestions.validateFeatureSuggestionInput as (input: unknown) => void;
export const validateSuggestionInput = roadmapSuggestions.validateSuggestionInput as (input: unknown) => void;

import type { ResearchProviderConfig, ResearchSource, ResearchSynthesisRequest, ResearchSynthesisResult, ResolvedModelSelection } from "@fusion/core";
import type { ResearchProvider } from "../../research-step-runner.js";
import { createLogger } from "../../logger.js";
import { createFnAgent, promptWithFallback } from "../../pi.js";
import { ResearchProviderError } from "../types.js";

const log = createLogger("research:llm-synthesis");
const DEFAULT_TIMEOUT_MS = 120_000;
const LARGE_MODEL_CONTEXT_CHARS = 100_000;
const SMALL_MODEL_CONTEXT_CHARS = 30_000;

export interface LLMSynthesisProviderOptions {
  projectRoot: string;
  timeoutMs?: number;
}

export class LLMSynthesisProvider implements ResearchProvider {
  readonly type = "llm-synthesis";

  constructor(private readonly options: LLMSynthesisProviderOptions) {}

  isConfigured(): boolean {
    return true;
  }

  async search(_query: string, _options: ResearchProviderConfig = {}, _signal?: AbortSignal): Promise<ResearchSource[]> {
    return [];
  }

  async fetchContent(
    _url: string,
    _options: ResearchProviderConfig = {},
    _signal?: AbortSignal,
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    return { content: "", metadata: {} };
  }

  async synthesize(
    request: ResearchSynthesisRequest,
    modelSelection: ResolvedModelSelection,
    signal?: AbortSignal,
  ): Promise<ResearchSynthesisResult> {
    if (!modelSelection?.provider || !modelSelection?.modelId) {
      throw new ResearchProviderError({ providerType: "llm-synthesis", code: "provider-unavailable", message: "Synthesis model is not configured" });
    }

    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      const cappedSources = this.applySourceBudget(request.sources, modelSelection);
      const prompt = buildSynthesisPrompt(request, cappedSources);

      const { session } = await createFnAgent({
        cwd: this.options.projectRoot,
        tools: "readonly",
        systemPrompt: "You synthesize research findings into concise, cited outputs.",
        defaultProvider: modelSelection.provider,
        defaultModelId: modelSelection.modelId,
      });

      try {
        await Promise.race([
          promptWithFallback(session, prompt),
          new Promise<never>((_, reject) => {
            requestSignal.addEventListener(
              "abort",
              () => reject(new ResearchProviderError({
                providerType: "llm-synthesis",
                code: signal?.aborted ? "abort" : "timeout",
                message: signal?.aborted ? "Synthesis aborted" : "Synthesis timed out",
                retryable: !signal?.aborted,
              })),
              { once: true },
            );
          }),
        ]);

        if (requestSignal.aborted) {
          throw new ResearchProviderError({ providerType: "llm-synthesis", code: signal?.aborted ? "abort" : "timeout", message: signal?.aborted ? "Synthesis aborted" : "Synthesis timed out", retryable: !signal?.aborted });
        }

        const responseText = extractAssistantText(session);
        if (!responseText) {
          throw new ResearchProviderError({ providerType: "llm-synthesis", code: "provider-unavailable", message: "No synthesis response received" });
        }

        return {
          output: responseText,
          citations: extractCitations(responseText, cappedSources),
          confidence: extractConfidence(responseText),
          metadata: {
            sourceCount: cappedSources.length,
            truncated: cappedSources.length < request.sources.length,
          },
        };
      } finally {
        session.dispose();
      }
    } catch (error) {
      if (error instanceof ResearchProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ResearchProviderError({ providerType: "llm-synthesis", code: "abort", message: "Synthesis aborted", cause: error });
      }
      log.warn("llm synthesis failed", { error });
      throw new ResearchProviderError({
        providerType: "llm-synthesis",
        code: "provider-unavailable",
        message: error instanceof Error ? error.message : "Synthesis failed",
        retryable: true,
        cause: error,
      });
    }
  }

  private applySourceBudget(sources: ResearchSource[], modelSelection: ResolvedModelSelection): ResearchSource[] {
    // Approximation: 1 token ~= 4 English chars. We cap at 80% of an estimated
    // context window to preserve room for prompt/instructions and response.
    const contextChars = isLargeModel(modelSelection.modelId) ? LARGE_MODEL_CONTEXT_CHARS : SMALL_MODEL_CONTEXT_CHARS;
    const budget = Math.floor(contextChars * 0.8);
    const ordered = [...sources].sort((a, b) => scoreSource(b) - scoreSource(a));

    let total = 0;
    const kept: ResearchSource[] = [];
    for (const source of ordered) {
      const chunk = `${source.title ?? ""}\n${source.excerpt ?? ""}\n${source.content ?? ""}`;
      if (total + chunk.length > budget) continue;
      total += chunk.length;
      kept.push(source);
    }

    return kept.length > 0 ? kept : ordered.slice(0, 1);
  }
}

function isLargeModel(modelId?: string): boolean {
  const id = modelId?.toLowerCase() ?? "";
  return id.includes("gpt-5") || id.includes("claude-opus") || id.includes("gemini-2.5-pro") || id.includes("sonnet");
}

function scoreSource(source: ResearchSource): number {
  const confidence = typeof source.metadata?.confidence === "number" ? source.metadata.confidence : 0;
  const hasContent = source.content ? 1 : 0;
  return confidence * 10 + hasContent;
}

function buildSynthesisPrompt(request: ResearchSynthesisRequest, sources: ResearchSource[]): string {
  const format = request.desiredFormat ?? "markdown";
  const renderedSources = sources
    .map(
      (source, index) => `Source [${index + 1}]\nTitle: ${source.title ?? source.reference}\nReference: ${source.reference}\nExcerpt: ${source.excerpt ?? ""}\nContent: ${source.content ?? ""}`,
    )
    .join("\n\n");

  return [
    "You are a research synthesis assistant.",
    `Query: ${request.query}`,
    `Round: ${request.round}`,
    `Desired format: ${format}`,
    "Analyze the provided sources and produce: summary, key findings, contradictions, confidence, and follow-up queries.",
    "Cite source references inline using [n] notation where n is source number.",
    request.instructions ? `Additional instructions: ${request.instructions}` : "",
    "Sources:",
    renderedSources,
    'Return valid JSON: {"summary": string, "findings": [{"statement": string, "citations": string[]}], "confidence": number, "followUps": string[]}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractAssistantText(session: { state?: { messages?: Array<{ role?: string; content?: unknown }> } }): string | undefined {
  const messages = session.state?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
  }
  return undefined;
}

function extractCitations(text: string, sources: ResearchSource[]): string[] {
  const matches = text.match(/\[(\d+)\]/g) ?? [];
  const refs = new Set<string>();
  for (const match of matches) {
    const idx = Number.parseInt(match.replace(/\D/g, ""), 10) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < sources.length) {
      refs.add(sources[idx].reference);
    }
  }
  return [...refs];
}

function extractConfidence(text: string): number | undefined {
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonBlock);
    if (typeof parsed.confidence === "number") return parsed.confidence;
  } catch {
    const match = text.match(/"confidence"\s*:\s*([0-9]*\.?[0-9]+)/i);
    if (match) {
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export { buildSynthesisPrompt, extractCitations };

import type { CreateAiSessionFactory, PluginContext } from "@fusion/core";
import { DEFAULT_REVIEW_PROMPT } from "./settings.js";
import type {
  CombinedReview,
  IndividualReview,
  ReviewFailure,
  ReviewPanelMember,
  ReviewVerdict,
  RunReviewPanelInput,
} from "./review-types.js";
import { ReviewPanelError, ReviewParseError, ReviewTimeoutError } from "./review-types.js";

let injectedCreateAiSession: CreateAiSessionFactory | undefined;

const MAX_PARSE_RETRIES = 1;
const MAX_MERGED_ITEMS = 25;
export const REVIEW_TIMEOUT_MS = 120_000;

interface AgentMessage {
  role: string;
  content?: string | Array<{ type: string; text: string }>;
}

function pickFactory(ctx: PluginContext): CreateAiSessionFactory | undefined {
  return injectedCreateAiSession ?? ctx.createAiSession;
}

function getReviewPromptTemplate(reviewerId: string, settings: Record<string, unknown>): string {
  const templates = settings.reviewPromptTemplates;
  if (templates && typeof templates === "object" && !Array.isArray(templates)) {
    const candidate = (templates as Record<string, unknown>)[reviewerId];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const reviewPrompt = settings.reviewPrompt;
  if (typeof reviewPrompt === "string" && reviewPrompt.trim()) return reviewPrompt.trim();
  return DEFAULT_REVIEW_PROMPT;
}

function buildSystemPrompt(member: ReviewPanelMember, settings: Record<string, unknown>): string {
  const templateId = member.promptTemplateId ?? member.id;
  const template = getReviewPromptTemplate(templateId, settings);
  return `${template}\n\nReviewer perspective: ${member.perspective}`;
}

function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = codeBlockMatch?.[1]?.trim() ?? text.trim();

  const startIndex = source.indexOf("{");
  if (startIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return source.slice(startIndex, index + 1).trim();
    }
  }

  return source.slice(startIndex).trim();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function parseReviewPayload(text: string): Omit<IndividualReview, "memberId" | "memberName" | "perspective" | "durationMs" | "rawText"> {
  const candidate = extractJsonCandidate(text);
  if (!candidate) throw new ReviewParseError("No JSON object found in reviewer response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new ReviewParseError("Reviewer response is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewParseError("Reviewer response must be a JSON object");
  }

  const row = parsed as Record<string, unknown>;
  const verdict = row.verdict;
  const summary = row.summary;
  if (verdict !== "approve" && verdict !== "revise" && verdict !== "reject") {
    throw new ReviewParseError("Reviewer verdict must be approve, revise, or reject");
  }
  if (typeof summary !== "string" || !summary.trim()) {
    throw new ReviewParseError("Reviewer summary must be a non-empty string");
  }

  return {
    verdict,
    summary: summary.trim(),
    highlights: asStringArray(row.highlights),
    lowlights: asStringArray(row.lowlights),
    suggestions: asStringArray(row.suggestions),
  };
}

function getAssistantText(messages: AgentMessage[]): string {
  const lastMessage = messages.filter((message) => message.role === "assistant").pop();
  if (!lastMessage?.content) return "";
  if (typeof lastMessage.content === "string") return lastMessage.content;
  return lastMessage.content
    .filter((chunk): chunk is { type: "text"; text: string } => chunk.type === "text")
    .map((chunk) => chunk.text)
    .join("");
}

function toFailure(memberId: string, error: unknown): ReviewFailure {
  if (error instanceof ReviewTimeoutError) {
    return { memberId, reason: "timeout", message: error.message };
  }
  if (error instanceof ReviewParseError) {
    return { memberId, reason: "parse_error", message: error.message };
  }
  if (error instanceof ReviewPanelError && error.reason === "session_unavailable") {
    return { memberId, reason: "session_unavailable", message: error.message };
  }
  return {
    memberId,
    reason: "exception",
    message: error instanceof Error ? error.message : String(error),
  };
}

function timeoutAfter(ms: number, memberName: string): Promise<never> {
  return new Promise((_, reject) => {
    globalThis.setTimeout(() => {
      reject(new ReviewTimeoutError(`Review timed out for ${memberName} after ${ms}ms`));
    }, ms);
  });
}

function dedupeMerged(items: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
    if (merged.length >= MAX_MERGED_ITEMS) break;
  }
  return merged;
}

function getVerdictRank(verdict: ReviewVerdict): number {
  if (verdict === "reject") return 2;
  if (verdict === "revise") return 1;
  return 0;
}

export function combineReviews(individual: IndividualReview[], failures: ReviewFailure[]): CombinedReview {
  if (individual.length === 0) {
    return {
      overallVerdict: "reject",
      consensusSummary: "Review panel could not produce feedback because all reviewers failed.",
      mergedHighlights: [],
      mergedLowlights: [],
      mergedSuggestions: [],
      individual,
      failures,
    };
  }

  const worstVerdict = individual.reduce<ReviewVerdict>((current, review) =>
    getVerdictRank(review.verdict) > getVerdictRank(current) ? review.verdict : current,
  "approve");

  const consensusSummary = individual
    .map((review) => `${review.perspective}: ${review.summary}`)
    .join(" | ");

  return {
    overallVerdict: worstVerdict,
    consensusSummary,
    mergedHighlights: dedupeMerged(individual.flatMap((review) => review.highlights)),
    mergedLowlights: dedupeMerged(individual.flatMap((review) => review.lowlights)),
    mergedSuggestions: dedupeMerged(individual.flatMap((review) => review.suggestions)),
    individual,
    failures,
  };
}

async function runSingleReview(member: ReviewPanelMember, input: RunReviewPanelInput, createAiSession: CreateAiSessionFactory, settings: Record<string, unknown>): Promise<IndividualReview> {
  const startedAt = Date.now();
  const userPrompt = [
    "Review the following generated report draft.",
    "Return only strict JSON with keys: verdict, summary, highlights, lowlights, suggestions.",
    "Do not include markdown fences or extra commentary.",
    "",
    `reportId: ${input.reportMetadata.reportId}`,
    `cadence: ${input.reportMetadata.cadence}`,
    `periodStart: ${input.reportMetadata.periodStart}`,
    `periodEnd: ${input.reportMetadata.periodEnd}`,
    "",
    "reportDraft:",
    input.reportDraft,
  ].join("\n");

  const response = await Promise.race([
    (async () => {
      const agent = await createAiSession({
        cwd: input.cwd,
        systemPrompt: buildSystemPrompt(member, settings),
        tools: "readonly",
        ...(member.provider && member.modelId ? { defaultProvider: member.provider, defaultModelId: member.modelId } : {}),
      });

      try {
        await agent.session.prompt(userPrompt);
        let text = getAssistantText(agent.session.state.messages as AgentMessage[]);

        let parsed: Omit<IndividualReview, "memberId" | "memberName" | "perspective" | "durationMs" | "rawText"> | undefined;
        let lastParseError: Error | undefined;
        for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
          try {
            parsed = parseReviewPayload(text);
            break;
          } catch (error) {
            lastParseError = error instanceof Error ? error : new Error(String(error));
            if (attempt === MAX_PARSE_RETRIES) break;
            await agent.session.prompt("Your previous response was not valid JSON. Respond with only a valid JSON object.");
            text = getAssistantText(agent.session.state.messages as AgentMessage[]);
          }
        }

        if (!parsed) {
          throw new ReviewParseError(`Failed to parse reviewer response: ${lastParseError?.message ?? "unknown error"}`);
        }

        return {
          memberId: member.id,
          memberName: member.name,
          perspective: member.perspective,
          rawText: text,
          durationMs: Date.now() - startedAt,
          ...parsed,
        };
      } finally {
        (agent.session as { dispose?: () => void }).dispose?.();
      }
    })(),
    timeoutAfter(REVIEW_TIMEOUT_MS, member.name),
  ]);

  return response;
}

export async function runReviewPanel(input: RunReviewPanelInput, ctx: PluginContext): Promise<CombinedReview> {
  const createAiSession = pickFactory(ctx);
  if (!createAiSession) {
    throw new ReviewPanelError("session_unavailable", "AI session factory is unavailable");
  }

  const settled = await Promise.allSettled(input.panel.map((member) => runSingleReview(member, input, createAiSession, ctx.settings)));

  const individual: IndividualReview[] = [];
  const failures: ReviewFailure[] = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const member = input.panel[index];
    if (result.status === "fulfilled") individual.push(result.value);
    else failures.push(toFailure(member.id, result.reason));
  }

  return combineReviews(individual, failures);
}

export function __setCreateAiSessionFactory(factory: CreateAiSessionFactory | undefined): void {
  injectedCreateAiSession = factory;
}

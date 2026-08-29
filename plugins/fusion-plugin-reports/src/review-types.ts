export type ReviewVerdict = "approve" | "revise" | "reject";

export interface ReviewPanelMember {
  id: string;
  name: string;
  perspective: string;
  promptTemplateId?: string;
  provider?: string;
  modelId?: string;
}

export interface IndividualReview {
  memberId: string;
  memberName: string;
  perspective: string;
  verdict: ReviewVerdict;
  summary: string;
  highlights: string[];
  lowlights: string[];
  suggestions: string[];
  rawText: string;
  durationMs: number;
}

export interface ReviewFailure {
  memberId: string;
  reason: "timeout" | "parse_error" | "session_unavailable" | "exception";
  message: string;
}

export interface CombinedReview {
  overallVerdict: ReviewVerdict;
  consensusSummary: string;
  mergedHighlights: string[];
  mergedLowlights: string[];
  mergedSuggestions: string[];
  individual: IndividualReview[];
  failures: ReviewFailure[];
}

export interface RunReviewPanelInput {
  reportDraft: string;
  reportMetadata: {
    reportId: string;
    cadence: "daily" | "weekly";
    periodStart: string;
    periodEnd: string;
  };
  panel: ReviewPanelMember[];
  cwd: string;
}

export class ReviewPanelError extends Error {
  constructor(
    public readonly reason: "session_unavailable" | "exception",
    message: string,
  ) {
    super(message);
    this.name = "ReviewPanelError";
  }
}

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewParseError";
  }
}

export class ReviewTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewTimeoutError";
  }
}

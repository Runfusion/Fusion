import type { ResearchEvent, ResearchRun, ResearchRunStatus } from "@fusion/core";

export type ResearchProviderOption =
  | "web-search"
  | "page-fetch"
  | "github"
  | "local-docs"
  | "llm-synthesis";

export interface ResearchAvailability {
  available: boolean;
  code?: "unavailable" | "not-configured" | "feature-disabled";
  reason?: string;
  setupInstructions?: string;
  supportedProviders?: ResearchProviderOption[];
  supportedExportFormats?: Array<"markdown" | "json" | "html">;
}

export interface ResearchRunListItem {
  id: string;
  query: string;
  title: string;
  status: ResearchRunStatus;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchRunDetail extends ResearchRun {
  title: string;
}

export type ResearchRunEvent = ResearchEvent;

export interface ResearchRunsResponse {
  runs: ResearchRunListItem[];
  availability: ResearchAvailability;
}

export interface ResearchRunResponse {
  run: ResearchRunDetail;
  availability: ResearchAvailability;
}

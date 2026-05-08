export type FusionColumn = "triage" | "todo" | "in-progress" | "in-review" | "done" | "archived";

export interface FusionTask {
  id: string;
  title?: string;
  description: string;
  column: FusionColumn;
  priority?: string;
  assignedAgentId?: string;
  assigneeUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CardTone = "triage" | "todo" | "in-progress" | "in-review" | "done" | "neutral";

export interface CardStatusBadge {
  label: string;
  tone: CardTone;
}

export interface GlassesCard {
  id: string;
  kind: "summary" | "task";
  title: string;
  lines: string[];
  badge: CardStatusBadge;
  taskId?: string;
  updatedAt: string;
}

export interface BoardSummary {
  counts: Record<string, number>;
  updatedAt: string | null;
}

export interface CardDeck {
  cards: GlassesCard[];
  summary: BoardSummary;
}

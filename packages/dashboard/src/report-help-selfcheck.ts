export interface HelpKnowledgeResult {
  title: string;
  summary?: string | null;
  content?: string;
}

/** Deterministic adapter used by the report route before Help is escalated. */
export async function selfCheckHelp(question: string, query: (question: string) => Promise<HelpKnowledgeResult[]>): Promise<{ answered: boolean; answer?: HelpKnowledgeResult }> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("A help question is required.");
  const pages = await query(trimmed);
  return pages.length > 0 ? { answered: true, answer: pages[0] } : { answered: false };
}

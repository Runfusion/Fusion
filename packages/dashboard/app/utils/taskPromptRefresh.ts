export type TaskPromptRefreshDecision =
  | {action: "adopt"; prompt: string}
  | {action: "retain"}
  | {action: "adopt-empty"};

/*
FNXC:TaskDetailPlan 2026-08-28-15:31:
The narrow Definition read is degradable: an unreadable or momentarily absent PROMPT.md can resolve successfully without usable content. It may refresh a plan but may not destroy a retained one; only an authoritative full-detail snapshot can prove that the plan was genuinely cleared.
*/
export function decideTaskPromptRefresh({
  retainedPrompt,
  responsePrompt,
}: {
  retainedPrompt: string | undefined;
  responsePrompt: string | undefined;
}): TaskPromptRefreshDecision {
  if (responsePrompt?.trim()) return {action: "adopt", prompt: responsePrompt};
  if (retainedPrompt?.trim()) return {action: "retain"};
  return {action: "adopt-empty"};
}

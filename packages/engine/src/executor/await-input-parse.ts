/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * Await-input parsers peeled from executor.ts (wave18 / U4 Slice A).
 */

/**
 * Sentinel a skill running in a Fusion workflow step emits when it needs to ask
 * the user a blocking question (it has no synchronous question tool — see the CE
 * skills' "Running inside Fusion" sections). The executor detects this in the
 * step's output and parks the task `awaiting-user-input`, reusing the same
 * pause/resume machinery as an `awaitInput` node (U6). Returns the question text,
 * or null when no well-formed sentinel is present.
 */
export function parseAwaitInputSentinel(output: string | undefined): string | null {
  if (!output) return null;
  const m = output.match(/===FUSION_AWAIT_INPUT===\s*([\s\S]*?)\s*===END_FUSION_AWAIT_INPUT===/);
  const question = m?.[1]?.trim();
  return question ? question : null;
}

const USER_QUESTION_TOOL_NAMES = new Set([
  "askuserquestion",
  "ask_user",
  "ask_followup_question",
  "request_user_input",
  "elicit",
  "ask_question",
  "fn_ask_question",
]);

/**
 * Normalize a question-tool invocation into the same durable await-input
 * contract used by skill sentinels. Some runtimes expose an interactive
 * question tool even though Fusion workflow-step sessions have no synchronous
 * listener; detecting the call at the session event boundary prevents the
 * task from continuing after the unanswered question is rendered.
 */
export function parseAwaitInputQuestionToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!USER_QUESTION_TOOL_NAMES.has(toolName.trim().toLowerCase()) || !args) return null;

  const records = Array.isArray(args.questions) ? args.questions : [args];
  const questions = records.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const question = [record.question, record.prompt, record.message, record.text, record.title]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
      ?.trim();
    return question ? [question] : [];
  });

  return questions.length > 0 ? questions.join("\n\n") : null;
}

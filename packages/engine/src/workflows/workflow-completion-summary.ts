import { resolveTaskOutputLanguage, type ResolvedTaskOutputLanguage, type Settings, type TaskDetail } from "@fusion/core";

export interface WorkflowCompletionSummaryStore {
  updateTask?: (taskId: string, updates: { summary: string }) => Promise<unknown> | unknown;
  logEntry?: (taskId: string, action: string, detail?: string) => Promise<unknown> | unknown;
}

export interface WorkflowCompletionSummaryInput {
  reason: string;
  workflowId?: string;
  runId?: string;
  /** Captured invocation settings; callers must not re-read mutable settings during completion. */
  settings?: Partial<Settings>;
  /** Original user input captured with the invocation; input mode must not infer from an AI title. */
  originalInput?: string;
  /** Resolved invocation target, retained by resumable workflow paths. */
  outputLanguage?: ResolvedTaskOutputLanguage;
}

function truncateList(values: string[], limit: number, locale: string): string {
  const head = values.slice(0, limit);
  const remaining = values.length - head.length;
  const more = locale === "fr" ? ` et ${remaining} autres`
    : locale === "es" ? ` y ${remaining} más`
      : locale === "pt-BR" ? ` e mais ${remaining}`
        : locale === "ko" ? ` 외 ${remaining}개`
          : locale === "zh-CN" || locale === "zh-TW" ? `，另有 ${remaining} 个`
            : ` and ${remaining} more`;
  return remaining > 0 ? `${head.join(", ")}${more}` : head.join(", ");
}

function completionCopy(locale: string, doneSteps: number, stepCount: number, passedChecks: number, checkCount: number, files: string, reason: string, workflowId?: string): string[] {
  const source = `${reason}${workflowId ? ` (${workflowId})` : ""}`;
  if (locale === "fr") return [
    `Flux de travail terminé`,
    `Étapes de tâche terminées : ${doneSteps}/${stepCount}.`,
    `Contrôles du flux de travail réussis ou ignorés : ${passedChecks}/${checkCount}.`,
    `Fichiers modifiés : ${files}.`,
    `Source de fin : ${source}.`,
  ];
  if (locale === "es") return [
    "Flujo de trabajo completado",
    `Pasos de tarea completados: ${doneSteps}/${stepCount}.`,
    `Comprobaciones del flujo aprobadas u omitidas: ${passedChecks}/${checkCount}.`,
    `Archivos modificados: ${files}.`,
    `Origen de finalización: ${source}.`,
  ];
  if (locale === "pt-BR") return [
    "Fluxo de trabalho concluído",
    `Etapas da tarefa concluídas: ${doneSteps}/${stepCount}.`,
    `Verificações do fluxo aprovadas ou ignoradas: ${passedChecks}/${checkCount}.`,
    `Arquivos alterados: ${files}.`,
    `Origem da conclusão: ${source}.`,
  ];
  if (locale === "ko") return [
    "워크플로가 완료되었습니다",
    `완료된 작업 단계: ${doneSteps}/${stepCount}.`,
    `통과 또는 건너뛴 워크플로 검사: ${passedChecks}/${checkCount}.`,
    `변경된 파일: ${files}.`,
    `완료 출처: ${source}.`,
  ];
  if (locale === "zh-CN") return [
    "工作流已完成",
    `已完成的任务步骤：${doneSteps}/${stepCount}。`,
    `已通过或跳过的工作流检查：${passedChecks}/${checkCount}。`,
    `已更改文件：${files}。`,
    `完成来源：${source}。`,
  ];
  if (locale === "zh-TW") return [
    "工作流程已完成",
    `已完成的工作步驟：${doneSteps}/${stepCount}。`,
    `已通過或略過的工作流程檢查：${passedChecks}/${checkCount}。`,
    `已變更檔案：${files}。`,
    `完成來源：${source}。`,
  ];
  return [
    "Workflow completed",
    `Completed ${doneSteps}/${stepCount} task step${stepCount === 1 ? "" : "s"}.`,
    `Recorded ${passedChecks}/${checkCount} workflow check${checkCount === 1 ? "" : "s"} as passed or skipped.`,
    `Changed files: ${files}.`,
    `Completion source: ${source}.`,
  ];
}

export function buildWorkflowCompletionSummary(
  task: Pick<TaskDetail, "id" | "title" | "description" | "steps" | "modifiedFiles" | "workflowStepResults">,
  input: WorkflowCompletionSummaryInput,
): string {
  const title = task.title?.trim() || task.id;
  const steps = task.steps ?? [];
  const doneSteps = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const workflowResults = task.workflowStepResults ?? [];
  const passedWorkflowSteps = workflowResults.filter((step) => step.status === "passed" || step.status === "skipped").length;
  const files = (task.modifiedFiles ?? []).filter((file) => file.trim().length > 0);

  /* FNXC:TaskOutputLanguage 2026-08-19-15:47: Deterministic fallback localizes every human-readable clause from the captured target and original input, never an AI-authored title. */
  const locale = (input.outputLanguage ?? resolveTaskOutputLanguage(input.settings, input.originalInput ?? task.description ?? "")).locale ?? "en";
  const [completed, stepCopy, checkCopy, filesCopy, sourceCopy] = completionCopy(
    locale,
    doneSteps,
    steps.length,
    passedWorkflowSteps,
    workflowResults.length,
    truncateList(files, 6, locale),
    input.reason,
    input.workflowId,
  );
  const parts = [`${completed}: ${title}.`];
  if (steps.length > 0) parts.push(stepCopy);
  if (workflowResults.length > 0) parts.push(checkCopy);
  if (files.length > 0) parts.push(filesCopy);
  parts.push(sourceCopy);
  return parts.join(" ");
}

export async function ensureWorkflowCompletionSummary(
  store: WorkflowCompletionSummaryStore,
  task: TaskDetail,
  input: WorkflowCompletionSummaryInput,
): Promise<void> {
  if (task.summary?.trim()) return;
  if (!store.updateTask) return;

  /*
   * FNXC:WorkflowCompletion 2026-06-29-10:58:
   * Workflow-owned tasks can finish through graph nodes and resumable merge work
   * items without an agent calling `fn_task_done`. Persist a deterministic
   * completion summary at the workflow lifecycle boundary so Done/Review cards,
   * GitHub tracking, evals, and archival views see the same `task.summary`
   * contract as legacy executor completions. Existing agent-authored summaries
   * remain authoritative.
   */
  const summary = buildWorkflowCompletionSummary(task, input);
  await store.updateTask(task.id, { summary });
  await store.logEntry?.(
    task.id,
    "Workflow completion summary recorded",
    JSON.stringify({
      reason: input.reason,
      workflowId: input.workflowId,
      runId: input.runId,
    }),
  );
}

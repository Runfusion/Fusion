import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalSettings, ProjectSettings, Settings, Task, TaskStore } from "@fusion/core";
import { isValidTaskBranchName, resolveTaskPrHeadBranch, resolveTitleSummarizerSettingsModel } from "@fusion/core";
import { createFnAgent, resolveMcpServersForStore } from "@fusion/engine";

const execAsync = promisify(execCb);
export const PR_METADATA_TIMEOUT_MS = 60_000;

/*
FNXC:PrMetadataGeneration 2026-06-28-00:09:
The Create PR AI prompt must produce operator-ready metadata grounded in the commit log and diff stat while preserving the strict JSON schema consumed by parseAiResult, buildBody, and fillTemplate. Keep the schema stable so later configurable-prompt work can reuse this default without changing downstream body assembly.
*/
export const PR_METADATA_SYSTEM_PROMPT = [
  "You generate GitHub pull request metadata for Fusion tasks.",
  "Respond with STRICT JSON ONLY: no markdown fences, no commentary, no prose outside the JSON object.",
  "Use exactly this schema: {\"title\": string, \"summary\": string, \"changes\": string, \"testing\": string, \"linkedTask\": string}.",
  "Title: concise imperative conventional-commit style, at most 72 characters, no trailing period, with a scope when the change clearly suggests one.",
  "Summary: 1-3 short plain-sentence paragraphs explaining what changed and why; be specific and avoid marketing fluff.",
  "Changes: a tight markdown bullet list of concrete, verifiable changes supported by the commit log or diff stat; do not speculate.",
  "Testing: markdown bullets naming actual verification shown in the evidence; if no testing evidence exists, say '- Not provided.' or '- Not run (not provided).'.",
  "LinkedTask: set to the task ID exactly as provided.",
  "Ground every field in the commit log and diff stat first, then use the task title, task description, and task prompt only as supporting context.",
].join("\n");

export interface GeneratedPrMetadata {
  title: string;
  body: string;
  templateUsed: boolean;
}

interface AiMetadataResult {
  title: string;
  summary: string;
  changes: string;
  testing: string;
  linkedTask: string;
}

export function buildFallbackPrMetadata(task: Task): GeneratedPrMetadata {
  return {
    title: task.title ?? task.id,
    body: [
      "## Summary",
      "",
      task.description?.trim() || "Summary unavailable.",
      "",
      "## Changes",
      "",
      "- Details unavailable.",
      "",
      "## Testing",
      "",
      "- Not provided.",
      "",
      "## Linked Task",
      "",
      `Closes ${task.id}`,
    ].join("\n"),
    templateUsed: false,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAiResult(raw: string): AiMetadataResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AiMetadataResult>;
    const title = asString(parsed.title);
    const summary = asString(parsed.summary);
    const changes = asString(parsed.changes);
    const testing = asString(parsed.testing);
    const linkedTask = asString(parsed.linkedTask);
    if (!title || !summary || !changes || !testing) {
      return null;
    }
    return { title, summary, changes, testing, linkedTask };
  } catch {
    return null;
  }
}

/*
FNXC:PrMetadataGeneration 2026-09-19-21:38:
A generated linked-task field can already contain the task-closing directive. Normalize it before
assembly so completed templates and canonical bodies retain exactly one closing reference.
*/
function appendSingleClosingReference(body: string, taskId: string): string {
  const closingReference = `Closes ${taskId}`;
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutClosingReferences = body
    .replace(new RegExp(`^\\s*Closes\\s+${escapedTaskId}\\s*$(?:\\r?\\n)?`, "gim"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [withoutClosingReferences, closingReference].filter(Boolean).join("\n\n");
}

function buildBody(result: AiMetadataResult, taskId: string): string {
  return appendSingleClosingReference([
    "## Summary",
    "",
    result.summary,
    "",
    "## Changes",
    "",
    result.changes,
    "",
    "## Testing",
    "",
    result.testing,
    "",
    "## Linked Task",
    "",
    result.linkedTask,
  ].join("\n"), taskId);
}

function getTemplateHeadings(template: string): string[] {
  return template
    .split(/\r?\n/)
    .flatMap((line) => [line.match(/^(##+)\s+(\S.*)$/)?.[2]])
    .filter((heading): heading is string => Boolean(heading));
}

function fillTemplate(template: string, result: AiMetadataResult, taskId: string): string | null {
  const headingLines = template.split(/\r?\n/).filter((line) => /^(##+)\s+\S/.test(line));
  if (headingLines.length === 0) return null;

  const contentForHeading = (heading: string): string => {
    const normalized = heading.trim().toLowerCase();
    if (normalized.includes("test")) return result.testing;
    if (normalized.includes("change") || normalized.includes("implementation")) return result.changes;
    if (normalized.includes("task") || normalized.includes("issue") || normalized.includes("link")) {
      return [result.linkedTask, `Closes ${taskId}`].filter(Boolean).join("\n\n");
    }
    return result.summary;
  };

  const out: string[] = [];
  for (const line of headingLines) {
    const headingMatch = line.match(/^(##+)\s+(.*)$/);
    if (!headingMatch) continue;
    out.push(line, "", contentForHeading(headingMatch[2]));
  }

  if (!out.some((line) => /^##+\s+(?:linked task|task|issue|link)$/i.test(line))) {
    out.push("", "## Linked Task");
  }
  return appendSingleClosingReference(out.join("\n"), taskId);
}

async function runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const commandPromise = execAsync(command, {
    cwd,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  const { stdout } = signal ? await raceWithAbort(commandPromise, signal) : await commandPromise;
  return stdout.trim();
}

function createAbortError(): Error {
  const error = new Error("PR metadata generation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError();
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError();
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function disposeSessionBestEffort(session: { dispose?: () => void | Promise<void> }): void {
  try {
    const disposeResult = session.dispose?.();
    if (disposeResult && typeof (disposeResult as Promise<void>).catch === "function") {
      void (disposeResult as Promise<void>).catch(() => undefined);
    }
  } catch {
    // best effort
  }
}

function isAbortLikeError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && ("name" in error ? (error as { name?: unknown }).name === "AbortError" : false),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

async function resolveBaseBranch(task: Task, repoRoot: string, signal?: AbortSignal): Promise<string> {
  if (task.prInfo?.baseBranch) {
    return task.prInfo.baseBranch;
  }

  try {
    const stdout = await runCommand("gh repo view --json defaultBranchRef -q .defaultBranchRef.name", repoRoot, signal);
    if (stdout) return stdout;
  } catch {
    // fallback below
  }
  return "main";
}

export async function generatePrMetadata(input: {
  task: Task;
  repoRoot: string;
  settings: ProjectSettings & GlobalSettings;
  store?: TaskStore;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GeneratedPrMetadata> {
  const { task, repoRoot, settings, store, signal, timeoutMs = PR_METADATA_TIMEOUT_MS } = input;
  const fallback = buildFallbackPrMetadata(task);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason instanceof Error ? signal.reason : createAbortError());
  /*
  FNXC:PrMetadataGeneration 2026-06-23-00:00:
  The Create PR dialog must receive usable title/body metadata within its UX budget even when git, template reads, provider startup, prompt streaming, or disposal misbehaves. Race every awaited operation against one shared abort signal so provider/session hangs degrade to deterministic fallback content instead of leaving the modal spinner pending indefinitely.
  */
  const timeoutId = setTimeout(() => controller.abort(createAbortError()), timeoutMs);
  const combinedSignal = controller.signal;
  const callerSignalWasActive = Boolean(signal && !signal.aborted);

  if (signal) {
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  try {
    throwIfAborted(combinedSignal);

    const baseBranch = await raceWithAbort(resolveBaseBranch(task, repoRoot, combinedSignal), combinedSignal);
    const headBranch = resolveTaskPrHeadBranch(task);
    const safeBaseBranch = isValidTaskBranchName(baseBranch) ? baseBranch : undefined;
    const safeHeadBranch = isValidTaskBranchName(headBranch) ? headBranch : undefined;
    /*
    FNXC:PrMetadataGeneration 2026-09-19-20:16:
    PR metadata must describe the persisted task head, not this process checkout. Validate both
    refs before shell construction; invalid persisted data yields explicit empty evidence rather
    than executing an interpolated ref or silently substituting HEAD.
    */
    const evidenceRange = safeBaseBranch && safeHeadBranch
      ? `${shellQuote(safeBaseBranch)}..${shellQuote(safeHeadBranch)}`
      : undefined;
    const [logOut, diffStatOut] = await raceWithAbort(Promise.all([
      evidenceRange
        ? runCommand(`git log --no-merges ${evidenceRange} --format=%s%n%b`, repoRoot, combinedSignal).catch(() => "")
        : Promise.resolve(""),
      evidenceRange
        ? runCommand(`git diff --stat ${evidenceRange}`, repoRoot, combinedSignal).catch(() => "")
        : Promise.resolve(""),
    ]), combinedSignal);

    let promptContent = "";
    try {
      const promptPath = join(repoRoot, ".fusion", "tasks", task.id, "PROMPT.md");
      promptContent = (await raceWithAbort(readFile(promptPath, "utf8"), combinedSignal)).trim();
    } catch {
      promptContent = "";
    }

    const templatePath = join(repoRoot, ".github", "pull_request_template.md");
    const templateExists = await raceWithAbort(access(templatePath).then(() => true).catch(() => false), combinedSignal);
    const template = templateExists ? await raceWithAbort(readFile(templatePath, "utf8"), combinedSignal) : "";
    const templateHeadings = getTemplateHeadings(template);

    const model = resolveTitleSummarizerSettingsModel(settings as Partial<Settings>);
    const systemPrompt = [PR_METADATA_SYSTEM_PROMPT];
    const titleGuidance = settings.prTitlePromptInstructions?.trim();
    const descriptionGuidance = settings.prDescriptionPromptInstructions?.trim();
    /*
     * FNXC:PrMetadataGeneration 2026-06-27-00:00:
     * Custom project guidance augments the Create PR metadata generator only after trimming; unset or whitespace-only values must leave the base three-line strict-JSON system prompt byte-for-byte unchanged so existing parse/fallback behavior remains stable.
     */
    if (titleGuidance) {
      systemPrompt.push(`Title guidance: ${titleGuidance}`);
    }
    if (descriptionGuidance) {
      systemPrompt.push(`Description guidance: ${descriptionGuidance}`);
    }
    const mcpServers = (await raceWithAbort(resolveMcpServersForStore(store ?? {}), combinedSignal)).servers;
    let aiText = "";
    const { session } = await raceWithAbort(createFnAgent({
      cwd: repoRoot,
      tools: "readonly",
      /*
       * FNXC:McpConfig 2026-06-26-16:58:
       * PR metadata generation is a readonly dashboard helper with a strict modal timeout. Resolve MCP through the request-scoped TaskStore inside the abort budget and forward only the materialized in-memory server set; no-store fallbacks stay empty and secret values must not be logged.
       */
      mcpServers,
      defaultProvider: model.provider,
      defaultModelId: model.modelId,
      systemPrompt: systemPrompt.join("\n"),
      onText: (delta: string) => {
        aiText += delta;
      },
    }), combinedSignal);

    try {
      const contextPrompt = [
        "Source-of-truth guidance:",
        "- Ground the PR title, summary, changes, and testing in the commit log and diff stat below.",
        "- Use task title, task description, and task prompt only to clarify intent when the git evidence supports it.",
        "- Omit speculation; when evidence for testing or a change is absent, say so instead of inventing details.",
        "- Return only strict JSON matching the required schema.",
        ...(templateHeadings.length > 0
          ? [`Repository PR template sections to complete (do not reproduce its instructions): ${templateHeadings.join(" | ")}`]
          : []),
        `Task ID: ${task.id}`,
        `Task title: ${task.title}`,
        `Task description: ${task.description ?? ""}`,
        `Base branch: ${safeBaseBranch ?? "(invalid or unavailable)"}`,
        `Head branch: ${safeHeadBranch ?? "(invalid or unavailable)"}`,
        "Commit log (source of truth):",
        logOut || "(none)",
        "Diff stat (source of truth):",
        diffStatOut || "(none)",
        "Task prompt (supporting context):",
        promptContent || "(none)",
      ].join("\n\n");

      throwIfAborted(combinedSignal);
      await raceWithAbort(
        (session.prompt as (prompt: string, options?: { signal?: AbortSignal }) => Promise<unknown>)(contextPrompt, { signal: combinedSignal }),
        combinedSignal,
      );
    } finally {
      disposeSessionBestEffort(session);
    }

    const parsed = parseAiResult(aiText);
    if (!parsed) {
      return fallback;
    }

    const completedTemplate = templateExists ? fillTemplate(template, parsed, task.id) : null;
    return {
      title: parsed.title,
      body: completedTemplate ?? buildBody(parsed, task.id),
      templateUsed: completedTemplate !== null,
    };
  } catch (error) {
    if (isAbortLikeError(error)) {
      return fallback;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignalWasActive) {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

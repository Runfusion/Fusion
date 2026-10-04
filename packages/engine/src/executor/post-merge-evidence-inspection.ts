import { readPostMergeArtifact } from "./read-post-merge-artifact.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SharedWorkerToolsDeps } from "./shared-worker-tools.js";

const execFileAsync = promisify(execFile);
const parameters = Type.Object({
  operation: Type.Union([
    "git_status", "git_ref", "git_log", "git_show", "git_file", "git_diff", "git_ancestor",
    "github_repository", "github_runs", "github_run", "github_jobs", "github_artifacts", "github_artifact_contents", "github_job_log",
  ].map((value) => Type.Literal(value))),
  ref: Type.Optional(Type.String({ description: "Commit SHA or branch, e.g. main" })),
  otherRef: Type.Optional(Type.String({ description: "Second ref for diff or ancestry" })),
  path: Type.Optional(Type.String({ description: "Repository-relative file path" })),
  workspaceRepository: Type.Optional(Type.String({ description: "Recorded task workspace repository key; omit for project root" })),
  repository: Type.Optional(Type.String({ description: "GitHub owner/repository, required for GitHub run operations" })),
  runId: Type.Optional(Type.Integer({ minimum: 1 })),
  artifactId: Type.Optional(Type.Integer({ minimum: 1 })),
  jobId: Type.Optional(Type.Integer({ minimum: 1 })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  outputOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for another bounded output page" })),
}, { additionalProperties: false });

type InspectionInput = Static<typeof parameters>;
type Run = (binary: string, args: string[], options: {
  cwd: string; encoding: "utf8"; timeout: number; maxBuffer: number; signal?: AbortSignal;
}) => Promise<{ stdout: string; stderr: string }>;

function ref(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)) throw new Error("Use a commit SHA or branch name for each ref.");
  return value;
}
function filePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) throw new Error("Use a repository-relative file path without parent traversal.");
  return value;
}
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Run, job and page IDs must be positive integers.");
  return value;
}

function githubRepository(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error("Use GitHub owner/repository, not a URL.");
  return value;
}

function command(params: InspectionInput): { binary: string; args: string[] } {
  let args: string[];
  switch (params.operation) {
    case "git_status": args = ["status", "--porcelain=v1", "--untracked-files=all"]; break;
    case "git_ref": args = ["rev-parse", "--verify", `${ref(params.ref)}^{commit}`]; break;
    case "git_log": args = ["log", "--max-count=30", "--format=fuller", ref(params.ref), "--"]; break;
    case "git_show": args = ["show", "--no-ext-diff", "--no-textconv", "--format=fuller", ref(params.ref), "--", ...(params.path ? [filePath(params.path)] : [])]; break;
    case "git_file": args = ["show", "--no-ext-diff", "--no-textconv", `${ref(params.ref)}:${filePath(params.path)}`]; break;
    case "git_diff": args = ["diff", "--no-ext-diff", "--no-textconv", ref(params.ref), ref(params.otherRef), "--", ...(params.path ? [filePath(params.path)] : [])]; break;
    case "git_ancestor": args = ["merge-base", "--is-ancestor", ref(params.ref), ref(params.otherRef)]; break;
    case "github_repository": return { binary: "gh", args: ["repo", "view", "--json", "nameWithOwner,url"] };
    case "github_runs":
    case "github_run":
    case "github_jobs":
    case "github_artifacts":
    case "github_job_log": {
      const repository = githubRepository(params.repository);
      const page = positiveInteger(params.page ?? 1);
      if (page > 100) throw new Error("Page must be at most 100.");
      const base = `repos/${repository}/actions`;
      const pagination = `?per_page=100&page=${page}`;
      const endpoint = params.operation === "github_runs" ? `${base}/runs${pagination}`
        : params.operation === "github_job_log" ? `${base}/jobs/${positiveInteger(params.jobId)}/logs`
        : `${base}/runs/${positiveInteger(params.runId)}${params.operation === "github_jobs" ? `/jobs${pagination}` : params.operation === "github_artifacts" ? `/artifacts${pagination}` : ""}`;
      return { binary: "gh", args: ["api", "--method", "GET", endpoint] };
    }
    default: throw new Error("Unsupported evidence inspection operation.");
  }
  return { binary: "git", args: ["--no-optional-locks", ...args] };
}

/** Fixed read operations keep verification useful without restoring arbitrary shell or code writes. */
export function createPostMergeInspectionTool(
  deps: Pick<SharedWorkerToolsDeps, "rootDir" | "store">,
  taskId: string,
  run: Run = execFileAsync,
): ToolDefinition {
  return {
    name: "fn_post_merge_inspect",
    label: "Inspect Landed Evidence",
    description: "Read committed Git evidence and GitHub Actions runs, jobs, logs and artifact metadata. No arbitrary commands, code writes or URLs. Artifact contents are read from a bounded temporary download. Use github_repository to discover owner/repository, github_runs to find the first post-landing run, then github_run/jobs/artifacts/job_log; github_artifact_contents reads a selected artifact by artifactId. Git operations use the project root or a recorded workspace repository. Output is paged at 8,000 characters; use outputOffset for remaining evidence.",
    parameters,
    execute: async (_id, params: InspectionInput, signal) => {
      try {
        const artifact = params.operation === "github_artifact_contents"
          ? { repository: githubRepository(params.repository), artifactId: positiveInteger(params.artifactId) }
          : undefined;
        const inspection = artifact ? undefined : command(params);
        const offset = params.outputOffset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Output offset must be a nonnegative integer.");
        let cwd = deps.rootDir;
        if (params.workspaceRepository) {
          const task = await deps.store.getTask(taskId);
          const checkout = task.workspaceWorktrees?.[params.workspaceRepository];
          if (!checkout?.worktreePath) throw new Error("Workspace repository must be recorded on this task.");
          cwd = checkout.worktreePath;
        }
        let output: string;
        try {
          if (artifact) output = await readPostMergeArtifact({ ...artifact, cwd, signal });
          else {
            const result = await run(inspection!.binary, inspection!.args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal });
            output = params.operation === "git_ancestor" ? "true" : result.stdout;
          }
        } catch (error) {
          if (params.operation !== "git_ancestor" || (error as { code?: unknown }).code !== 1) throw error;
          output = "false";
        }
        const page = output.slice(offset, offset + 8_000);
        const nextOffset = offset + page.length < output.length ? offset + page.length : undefined;
        return { content: [{ type: "text" as const, text: `${nextOffset !== undefined ? `[More evidence available: repeat with outputOffset=${nextOffset}]\n` : ""}${page || "(empty output)"}` }], details: { output: page, ...(nextOffset !== undefined ? { nextOffset } : {}) } };
      } catch (error) {
        const message = `Evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
        return { isError: true, content: [{ type: "text" as const, text: message }], details: { error: message } };
      }
    },
  };
}

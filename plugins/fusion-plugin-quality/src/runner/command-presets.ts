import type { QualityPresetId } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Allowlisted preset id → command mapping. Server resolves only; clients never supply command/argv/cwd.
full-suite requires explicit confirmFullSuite. file-scoped builds from server-side path list.
*/

export const QUALITY_PRESET_IDS: readonly QualityPresetId[] = [
  "project-test",
  "test-gate",
  "verify-fast",
  "file-scoped",
  "full-suite",
] as const;

export function isQualityPresetId(value: unknown): value is QualityPresetId {
  return typeof value === "string" && (QUALITY_PRESET_IDS as readonly string[]).includes(value);
}

export interface ResolvePresetInput {
  preset: QualityPresetId;
  /** Project settings.testCommand when set */
  testCommand?: string | null;
  /** Absolute project root */
  projectRoot: string;
  /** File paths relative to project/worktree for file-scoped preset */
  filePaths?: string[];
  confirmFullSuite?: boolean;
}

export type ResolvePresetResult =
  | { ok: true; command: string; label: string }
  | { ok: false; reason: string; code: "unknown_preset" | "disabled" | "confirm_required" | "empty_files" };

/**
 * Reject path tokens that could escape the worktree or inject shell metacharacters.
 * Paths must be relative POSIX-ish worktree tokens — no absolute UNIX/Windows forms.
 */
export function isSafeFilePathToken(pathToken: string): boolean {
  if (!pathToken || typeof pathToken !== "string") return false;
  if (pathToken.includes("\0") || pathToken.includes("\n") || pathToken.includes("\r")) return false;
  // Absolute UNIX, Windows drive, UNC, or env-var absolute forms.
  if (
    pathToken.startsWith("/")
    || pathToken.startsWith("\\")
    || /^[a-zA-Z]:[\\/]/.test(pathToken)
    || pathToken.startsWith("%")
    || pathToken.includes("..")
  ) {
    return false;
  }
  // Disallow shell metacharacters when paths are joined into a shell command string.
  if (/[;&|`$<>]/.test(pathToken)) return false;
  return true;
}

export function resolvePresetCommand(input: ResolvePresetInput): ResolvePresetResult {
  switch (input.preset) {
    case "project-test": {
      const cmd = (input.testCommand ?? "").trim();
      if (!cmd) {
        return {
          ok: false,
          reason: "Project testCommand is not configured",
          code: "disabled",
        };
      }
      return { ok: true, command: cmd, label: "Project test" };
    }
    case "test-gate":
      return { ok: true, command: "pnpm test:gate", label: "Merge gate tests" };
    case "verify-fast":
      return { ok: true, command: "pnpm verify:fast", label: "Verify fast (test-free)" };
    case "file-scoped": {
      const paths = (input.filePaths ?? []).map((p) => p.trim()).filter(Boolean);
      if (paths.length === 0) {
        return { ok: false, reason: "No changed files for file-scoped run", code: "empty_files" };
      }
      const safe = paths.filter(isSafeFilePathToken);
      if (safe.length === 0) {
        return { ok: false, reason: "No safe file paths for file-scoped run", code: "empty_files" };
      }
      // Prefer vitest path list; keep command server-built.
      const joined = safe.map((p) => JSON.stringify(p)).join(" ");
      return {
        ok: true,
        command: `pnpm exec vitest run ${joined}`,
        label: "File-scoped tests",
      };
    }
    case "full-suite": {
      if (!input.confirmFullSuite) {
        return {
          ok: false,
          reason: "full-suite requires confirmFullSuite: true",
          code: "confirm_required",
        };
      }
      return { ok: true, command: "pnpm test:full", label: "Full suite (opt-in)" };
    }
    default:
      return { ok: false, reason: "Unknown preset", code: "unknown_preset" };
  }
}

export function listPresetCatalog(): Array<{ id: QualityPresetId; label: string; needsConfirm?: boolean }> {
  return [
    { id: "project-test", label: "Project test" },
    { id: "test-gate", label: "Merge gate (test:gate)" },
    { id: "verify-fast", label: "Verify fast" },
    { id: "file-scoped", label: "File-scoped" },
    { id: "full-suite", label: "Full suite", needsConfirm: true },
  ];
}

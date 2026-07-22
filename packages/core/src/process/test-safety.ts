import { realpathSync, type PathLike } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function pathLikeToString(pathValue: PathLike): string {
  if (typeof pathValue === "string") return pathValue;
  if (pathValue instanceof URL) return fileURLToPath(pathValue);
  return pathValue.toString();
}

function resolveGuardPath(pathValue: PathLike): string {
  const raw = pathLikeToString(pathValue);
  if (!raw || raw === ":memory:") return raw;
  try {
    return realpathSync(raw);
  } catch {
    return resolve(raw);
  }
}

export function getProtectedFusionDir(): string | null {
  const root = process.env.FUSION_TEST_REAL_ROOT;
  if (!root) return null;

  const resolvedRoot = resolveGuardPath(root);
  if (!resolvedRoot) return null;
  return join(resolvedRoot, ".fusion");
}

export function isWithinProtectedFusionDir(pathValue: PathLike): boolean {
  const protectedFusionDir = getProtectedFusionDir();
  if (!protectedFusionDir) return false;

  const candidate = resolveGuardPath(pathValue);
  if (!candidate || candidate === ":memory:") return false;
  return candidate === protectedFusionDir || candidate.startsWith(protectedFusionDir + sep);
}

export function assertOutsideRealFusionPath(pathValue: PathLike, context = "operation"): void {
  const protectedFusionDir = getProtectedFusionDir();
  if (!protectedFusionDir) return;

  const candidate = resolveGuardPath(pathValue);
  if (!candidate || candidate === ":memory:") return;
  if (!isWithinProtectedFusionDir(candidate)) return;

  throw new Error(
    `[test-safety] ${context} targeted protected repo .fusion directory: ${candidate}\n` +
    "Tests must operate inside a temp directory. Use tempWorkspace() or useIsolatedCwd().",
  );
}

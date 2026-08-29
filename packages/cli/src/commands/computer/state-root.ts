import { resolve } from "node:path";
import { findKbDir } from "../../project-resolver.js";

/**
 * FNXC:ComputerUse 2026-08-13-22:34:
 * Computer-use state is project-local rather than cwd-local because capture and
 * replay run in separate processes from different directories in one project.
 * This function is called at exactly one runComputer boundary so snapshots,
 * latest pointers, and screenshots always use the same state root.
 */
export function resolveComputerStateRoot(startPath: string): string {
  const resolvedStartPath = resolve(startPath);
  try {
    return findKbDir(resolvedStartPath) ?? resolvedStartPath;
  } catch {
    return resolvedStartPath;
  }
}

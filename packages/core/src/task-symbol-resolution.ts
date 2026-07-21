import type { Task } from "./types.js";
import { normalizeSymbolLockKey } from "./task-store/symbol-locks.js";

/**
 * FNXC:SymbolLock 2026-07-31-10:00:
 * FN-8305 normalizes caller-provided locks but tasks need a durable declaration
 * source. File Scope is deliberately never converted into symbols: overlapping
 * paths may still contain disjoint declarations. Write hydration is presence-based
 * and store resolution is durable-only so an explicit clear cannot be undone by
 * re-reading PROMPT.md. Work items resolve through their owning task in TaskStore.
 */
export type TaskSymbolResolutionSource = "declared" | "prompt" | "none";
export type TaskSymbolResolution =
  | { resolvable: true; symbols: string[]; source: Exclude<TaskSymbolResolutionSource, "none"> }
  | { resolvable: false; symbols: []; source: TaskSymbolResolutionSource; reason: "empty" | "missing-task" | "invalid-only" };

export function hasOwnDeclaredSymbols(obj: object): boolean {
  return Object.prototype.hasOwnProperty.call(obj, "declaredSymbols");
}

export function normalizeDeclaredSymbols(raw: readonly string[]): string[] {
  const values = new Set<string>();
  for (const symbol of raw) {
    try { values.add(normalizeSymbolLockKey(symbol)); } catch { /* fail-soft declaration lists */ }
  }
  return [...values].sort();
}

export function extractDeclaredSymbolsFromPrompt(content: string): string[] {
  const heading = content.match(/^##\s+Declared\s+Symbols\s*$/m);
  if (!heading) return [];
  const rest = content.slice(heading.index! + heading[0].length);
  const next = rest.search(/\n##?\s/);
  return Array.from((next === -1 ? rest : rest.slice(0, next)).matchAll(/`([^`]+)`/g), match => match[1]);
}

/** Own property absence alone permits create-time prompt hydration. */
export function resolveCreateDeclaredSymbols(input: object, promptContent?: string | null): string[] | undefined {
  if (hasOwnDeclaredSymbols(input)) {
    const raw = (input as { declaredSymbols?: string[] }).declaredSymbols;
    const normalized = normalizeDeclaredSymbols(Array.isArray(raw) ? raw : []);
    return normalized.length ? normalized : undefined;
  }
  const normalized = promptContent ? normalizeDeclaredSymbols(extractDeclaredSymbolsFromPrompt(promptContent)) : [];
  return normalized.length ? normalized : undefined;
}

/** Offline-only source composition; creation must use resolveCreateDeclaredSymbols. */
export function resolveTaskSymbolsFromSources(input: { declaredSymbols?: readonly string[] | null; promptContent?: string | null }): TaskSymbolResolution {
  const declaredRaw = input.declaredSymbols ?? [];
  const declared = normalizeDeclaredSymbols(declaredRaw);
  if (declared.length) return { resolvable: true, symbols: declared, source: "declared" };
  const promptRaw = input.promptContent ? extractDeclaredSymbolsFromPrompt(input.promptContent) : [];
  const prompt = normalizeDeclaredSymbols(promptRaw);
  if (prompt.length) return { resolvable: true, symbols: prompt, source: "prompt" };
  if (declaredRaw.length > 0) return { resolvable: false, symbols: [], source: "declared", reason: "invalid-only" };
  if (promptRaw.length > 0) return { resolvable: false, symbols: [], source: "prompt", reason: "invalid-only" };
  return { resolvable: false, symbols: [], source: "none", reason: "empty" };
}

/** Resolves only the durable field; callers must not pass prompt content. */
export function resolveTaskSymbolsForTask(task: Pick<Task, "declaredSymbols"> | null): TaskSymbolResolution {
  if (!task) return { resolvable: false, symbols: [], source: "none", reason: "missing-task" };
  return resolveTaskSymbolsFromSources({ declaredSymbols: task.declaredSymbols });
}

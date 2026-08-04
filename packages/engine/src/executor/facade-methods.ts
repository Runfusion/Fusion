/**
 * FNXC:CodeOrganization 2026-08-03-21:25:
 * Compact TaskExecutor facade deps wiring (U4).
 *
 * Large free-function peels take many host methods as deps callbacks. Writing each as
 * `(...args) => (this as any).name(...args)` bloats the facade. This helper builds the
 * same bound bag from a name list so facades stay thin without changing call semantics.
 */
export function facadeMethods<const K extends string>(
  host: object,
  names: readonly K[],
): { [P in K]: (...args: unknown[]) => unknown } {
  const out = {} as { [P in K]: (...args: unknown[]) => unknown };
  for (const name of names) {
    out[name] = (...args: unknown[]) => (host as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  }
  return out;
}

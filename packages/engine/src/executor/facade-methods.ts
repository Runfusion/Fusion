/**
 * FNXC:CodeOrganization 2026-08-03-21:25:
 * Compact TaskExecutor facade deps wiring (U4).
 *
 * Large free-function peels take many host methods as deps callbacks. Writing each as
 * `(...args) => (this as any).name(...args)` bloats the facade. This helper builds the
 * same bound bag from a name list so facades stay thin without changing call semantics.
 *
 * FNXC:CodeOrganization 2026-08-03-21:40:
 * Returns `any` deliberately so spread into typed deps bags does not force `as any` at
 * every call site (eslint no-explicit-any would fire on each cast). The host methods are
 * private TaskExecutor members; the free-fn deps types are the real contract.
 *
 * FNXC:CodeOrganization 2026-08-04-04:15:
 * FacadeRestArgs strips the leading deps bag from a free-fn signature so multi-arg
 * TaskExecutor facades can forward with `...args` instead of re-declaring long parameter
 * lists (defaults remain on the free function).
 */

/** Args after the deps bag for a free function of shape `(deps, ...args) => R`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-fn deps bag is always first
export type FacadeRestArgs<F> = F extends (deps: any, ...args: infer A) => any ? A : never;

/** Args after the first positional arg (store / rootDir / worktreePath) for free peels. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- first positional is host-owned
export type FacadeAfterFirst<F> = F extends (first: any, ...args: infer A) => any ? A : never;

/** Args after two fixed host positionals (rootDir, store). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- first two positionals are host-owned
export type FacadeAfterSecond<F> = F extends (a: any, b: any, ...args: infer A) => any ? A : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see FNXC above
export function facadeMethods(host: object, names: readonly string[]): any {
  const out: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of names) {
    out[name] = (...args: unknown[]) =>
      (host as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  }
  return out;
}

/*
FNXC:CodeOrganization 2026-08-03-22:15:
Pick host fields by name for free-fn deps bags. Complements facadeMethods for
the field-heavy executeWorkflowGraph / handleGraphFailure / runImplementation facades.
Returns any for the same spread-into-typed-deps reason as facadeMethods.
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see FNXC above
export function facadeFields(host: object, names: readonly string[]): any {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = (host as Record<string, unknown>)[name];
  }
  return out;
}

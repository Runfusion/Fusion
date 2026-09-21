/*
FNXC:DevRuntime 2026-09-21-09:30:
Resolve hook for dev-source-condition-fallback.mjs; only retries after a not-found failure.
*/
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !context.conditions?.includes("source")) throw error;
    return nextResolve(specifier, {
      ...context,
      conditions: context.conditions.filter((condition) => condition !== "source"),
    });
  }
}

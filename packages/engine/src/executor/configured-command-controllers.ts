/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * register/unregister configured-command AbortControllers peeled from TaskExecutor (U4).
 */

export function registerConfiguredCommandController(
  activeConfiguredCommandControllers: Map<string, Set<AbortController>>,
  taskId: string,
  controller: AbortController,
): void {
  const controllers = activeConfiguredCommandControllers.get(taskId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeConfiguredCommandControllers.set(taskId, controllers);
}

export function unregisterConfiguredCommandController(
  activeConfiguredCommandControllers: Map<string, Set<AbortController>>,
  taskId: string,
  controller: AbortController,
): void {
  const controllers = activeConfiguredCommandControllers.get(taskId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) {
    activeConfiguredCommandControllers.delete(taskId);
  }
}

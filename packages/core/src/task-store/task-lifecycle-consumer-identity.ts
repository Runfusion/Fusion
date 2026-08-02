export const TASK_LIFECYCLE_CONSUMER_ROLES = [
  "engine",
  "dashboard",
  "cli",
  "child-process-worker",
  "remote-node",
] as const;

export type TaskLifecycleConsumerRole = (typeof TASK_LIFECYCLE_CONSUMER_ROLES)[number];

const INSTANCE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/*
FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
Consumer identity validation covers role and string format only. A helper cannot distinguish a
persisted node ID from a UUID minted at boot, so restart durability is a wiring-site provenance
obligation that must be proven where the instance key originates.
*/
/** Build a stable durable-consumer identity. */
export function buildConsumerId(
  role: TaskLifecycleConsumerRole,
  instanceKey?: string,
): string {
  if (!TASK_LIFECYCLE_CONSUMER_ROLES.includes(role)) {
    throw new Error(`Unknown task lifecycle consumer role: ${String(role)}`);
  }
  if (instanceKey === undefined) return role;
  if (instanceKey.trim() !== instanceKey || !INSTANCE_KEY_PATTERN.test(instanceKey)) {
    throw new Error("Task lifecycle consumer instance key must be a trimmed 1-128 character safe identifier");
  }
  return `${role}:${instanceKey}`;
}

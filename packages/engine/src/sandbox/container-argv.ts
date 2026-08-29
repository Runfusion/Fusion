import type { SandboxPolicy, SandboxRunOptions } from "./types.js";

const DEFAULT_CONTAINER_IMAGE = "docker.io/library/alpine:3.20";

/**
 * Builds runtime argv for containerized sandbox command execution.
 */
export function buildContainerArgv(
  runtime: "podman" | "docker",
  command: string,
  options: SandboxRunOptions,
  policy: SandboxPolicy,
): string[] {
  const argv = [runtime, "run", "--rm", "-i", "--workdir", "/work", "--volume", `${options.cwd}:/work`];

  if (runtime === "podman") {
    argv.push("--userns=keep-id");
  } else {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (typeof uid === "number" && typeof gid === "number") {
      argv.push("--user", `${uid}:${gid}`);
    }
  }

  if (!policy.allowNetwork) {
    argv.push("--network=none");
  }

  const mergedEnv: NodeJS.ProcessEnv = {
    ...(policy.env ?? {}),
    ...(options.env ?? {}),
  };

  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) {
      continue;
    }
    argv.push("--env", `${key}=${value}`);
  }

  argv.push(process.env.FUSION_SANDBOX_CONTAINER_IMAGE ?? DEFAULT_CONTAINER_IMAGE, "sh", "-c", command);
  return argv;
}

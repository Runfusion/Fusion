import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContainerArgv } from "../container-argv.js";
import type { SandboxPolicy, SandboxRunOptions } from "../types.js";

describe("buildContainerArgv", () => {
  const options: SandboxRunOptions = {
    cwd: "/tmp/worktree",
    timeoutMs: 1_000,
    maxBuffer: 1024,
  };

  const policy: SandboxPolicy = {
    allowNetwork: true,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses podman keep-id userns and docker uid:gid", () => {
    const podmanArgv = buildContainerArgv("podman", "echo hi", options, policy);
    expect(podmanArgv).toContain("--userns=keep-id");

    const dockerArgv = buildContainerArgv("docker", "echo hi", options, policy);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (typeof uid === "number" && typeof gid === "number") {
      expect(dockerArgv).toContain("--user");
      expect(dockerArgv).toContain(`${uid}:${gid}`);
      return;
    }
    expect(dockerArgv).not.toContain("--user");
  });

  it("adds network none only when network is disallowed", () => {
    const noNetwork = buildContainerArgv("podman", "echo hi", options, { ...policy, allowNetwork: false });
    expect(noNetwork).toContain("--network=none");

    const networkAllowed = buildContainerArgv("podman", "echo hi", options, policy);
    expect(networkAllowed).not.toContain("--network=none");
  });

  it("merges policy and options env with options overriding duplicates", () => {
    const argv = buildContainerArgv(
      "podman",
      "echo hi",
      {
        ...options,
        env: {
          SHARED: "from-options",
          OPTIONS_ONLY: "present",
        },
      },
      {
        ...policy,
        env: {
          SHARED: "from-policy",
          POLICY_ONLY: "present",
        },
      },
    );

    expect(argv).toEqual(
      expect.arrayContaining([
        "--env",
        "SHARED=from-options",
        "--env",
        "POLICY_ONLY=present",
        "--env",
        "OPTIONS_ONLY=present",
      ]),
    );
    expect(argv).not.toContain("SHARED=from-policy");
  });

  it("bind mounts cwd and sets /work workdir", () => {
    const argv = buildContainerArgv("podman", "echo hi", options, policy);
    expect(argv).toEqual(expect.arrayContaining(["--workdir", "/work", "--volume", "/tmp/worktree:/work"]));
  });

  it("honors image override from env", () => {
    vi.stubEnv("FUSION_SANDBOX_CONTAINER_IMAGE", "ghcr.io/example/sandbox:latest");
    const argv = buildContainerArgv("podman", "echo hi", options, policy);
    expect(argv).toContain("ghcr.io/example/sandbox:latest");
  });

  it("passes command through sh -c with command as single element", () => {
    const command = "echo hello && echo world";
    const argv = buildContainerArgv("podman", command, options, policy);
    expect(argv.slice(-3)).toEqual(["sh", "-c", command]);
  });
});

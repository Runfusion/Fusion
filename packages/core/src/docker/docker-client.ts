import { exec } from "node:child_process";
import type Docker from "dockerode";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerContextInfo,
  DockerHostConfig,
  DockerVolumeMount,
} from "../types.js";

const EXEC_OPTIONS = {
  timeout: 15_000,
  maxBuffer: 5 * 1024 * 1024,
} as const;

type DockerodeModule = typeof import("dockerode");
type DockerConstructor = DockerodeModule extends { default: infer T } ? T : DockerodeModule;

let dockerodeConstructorPromise: Promise<DockerConstructor> | null = null;

function isLocalDaemonHost(host?: string): boolean {
  return !host || host.trim() === "" || host === "unix:///var/run/docker.sock";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isDockerodeMissingModuleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error ? (error as Error & { code?: string }).code : undefined;
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /cannot find (package|module) ['"]dockerode['"]/i.test(error.message)
  );
}

async function loadDockerode(): Promise<DockerConstructor> {
  if (!dockerodeConstructorPromise) {
    dockerodeConstructorPromise = import("dockerode")
      .then((mod) => ("default" in mod && mod.default ? mod.default : mod) as DockerConstructor)
      .catch((error: unknown) => {
        // Clear the cache on any failure so a later retry can succeed after environment changes.
        dockerodeConstructorPromise = null;

        if (isDockerodeMissingModuleError(error)) {
          throw new Error("Docker support requires the optional 'dockerode' package. Install it with: npm install dockerode", {
            cause: error,
          });
        }

        throw new Error(`Failed to load 'dockerode': ${toErrorMessage(error)}`, {
          cause: error,
        });
      });
  }

  return dockerodeConstructorPromise;
}

interface DockerContextCliEntry {
  Name?: string;
  Description?: string;
  DockerEndpoint?: string;
  DockerHost?: string;
  Current?: boolean;
  Error?: string;
}

export class DockerClientService {
  private dockerInstance: Docker | null = null;

  constructor(private readonly defaultHostConfig?: DockerHostConfig) {}

  private async createDockerInstance(hostConfig?: DockerHostConfig): Promise<Docker> {
    if (hostConfig?.context) {
      const contextName = hostConfig.context.trim();
      if (!contextName) throw new Error("Docker context name cannot be empty");

      let stdout: string;
      try {
        ({ stdout } = await promisify(exec)(`docker context inspect ${JSON.stringify(contextName)}`, EXEC_OPTIONS));
      } catch (error) {
        throw new Error(`Failed to inspect Docker context "${contextName}": ${toErrorMessage(error)}`);
      }

      const parsed = JSON.parse(stdout) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
      const dockerHost = parsed[0]?.Endpoints?.docker?.Host;
      if (!dockerHost) throw new Error(`Docker context "${contextName}" does not define a Docker endpoint host`);
      const Docker = await loadDockerode();
      return new Docker({ host: dockerHost });
    }

    if (hostConfig?.host) {
      const options: {
        host: string;
        ca?: Buffer;
        cert?: Buffer;
        key?: Buffer;
        rejectUnauthorized?: boolean;
      } = {
        host: hostConfig.host,
      };

      if (hostConfig.tlsCaPath) options.ca = await readFile(hostConfig.tlsCaPath);
      if (hostConfig.tlsCertPath) options.cert = await readFile(hostConfig.tlsCertPath);
      if (hostConfig.tlsKeyPath) options.key = await readFile(hostConfig.tlsKeyPath);
      if (hostConfig.tlsVerify === false) options.rejectUnauthorized = false;

      const Docker = await loadDockerode();
      return new Docker(options);
    }

    const Docker = await loadDockerode();
    return new Docker();
  }

  async testConnection(hostConfig?: DockerHostConfig): Promise<DockerConnectivityResult> {
    const isLocalDaemon = isLocalDaemonHost(hostConfig?.host) && !hostConfig?.context;

    try {
      const docker = await this.createDockerInstance(hostConfig);
      await docker.ping();
      const version = await docker.version();

      return {
        success: true,
        dockerVersion: version.Version,
        apiVersion: version.ApiVersion,
        operatingSystem: version.Os,
        isLocalDaemon,
      };
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
        isLocalDaemon,
      };
    }
  }

  async listContexts(): Promise<DockerContextInfo[]> {
    try {
      const { stdout } = await promisify(exec)("docker context ls --format json", EXEC_OPTIONS);
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        return [{ name: "default", isCurrentContext: true, description: "Current Docker context" }];
      }

      try {
        return lines.map((line) => {
          const entry = JSON.parse(line) as DockerContextCliEntry;
          return {
            name: entry.Name ?? "default",
            description: entry.Description,
            dockerHost: entry.DockerEndpoint ?? entry.DockerHost,
            isCurrentContext: Boolean(entry.Current),
            isError: Boolean(entry.Error),
            errorMessage: entry.Error,
          } satisfies DockerContextInfo;
        });
      } catch {
        const tableLines = lines.slice(1);
        const contexts: DockerContextInfo[] = [];
        for (const line of tableLines) {
          const parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
          if (parts.length === 0) continue;
          const rawName = parts[0] ?? "";
          const isCurrentContext = rawName.startsWith("*");
          const name = rawName.replace(/^\*\s*/, "") || "default";
          contexts.push({
            name,
            description: parts[2] || undefined,
            dockerHost: parts[1] || undefined,
            isCurrentContext,
          });
        }
        return contexts;
      }
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes("ENOENT")) {
        return [{ name: "default", isCurrentContext: true, description: "Current Docker context" }];
      }
      throw error;
    }
  }

  /**
   * Get a Docker instance for the given host config.
   * If no host config is provided, uses the default config (cached).
   * Otherwise creates a fresh instance for the custom config.
   */
  async getDockerInstance(hostConfig?: DockerHostConfig): Promise<Docker> {
    if (!hostConfig || hostConfig === this.defaultHostConfig) {
      return this.getInstance();
    }
    return this.createDockerInstance(hostConfig);
  }

  async getContainerInfo(containerId: string, hostConfig?: DockerHostConfig): Promise<DockerContainerInspectResult | null> {
    try {
      const docker = await this.getDockerInstance(hostConfig);
      const inspect = await docker.getContainer(containerId).inspect();
      const ports = Object.entries(inspect.NetworkSettings?.Ports ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
        const binding = Array.isArray(value) && value.length > 0 ? value[0] : undefined;
        if (binding?.HostPort) {
          acc[key] = binding.HostPort;
        }
        return acc;
      }, {});
      return {
        id: inspect.Id,
        name: (inspect.Name ?? "").replace(/^\//, ""),
        status: inspect.State?.Status ?? "unknown",
        image: inspect.Config?.Image ?? "",
        created: inspect.Created ? Date.parse(inspect.Created) : 0,
        state: {
          running: Boolean(inspect.State?.Running),
          paused: Boolean(inspect.State?.Paused),
          restarting: Boolean(inspect.State?.Restarting),
          dead: Boolean(inspect.State?.Dead),
          error: inspect.State?.Error || undefined,
          exitCode: typeof inspect.State?.ExitCode === "number" ? inspect.State.ExitCode : undefined,
          startedAt: inspect.State?.StartedAt || undefined,
          finishedAt: inspect.State?.FinishedAt || undefined,
        },
        ports,
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes("404") || message.toLowerCase().includes("no such container")) {
        return null;
      }
      throw error;
    }
  }

  async getContainerLogs(containerId: string, hostConfig?: DockerHostConfig, options?: { tail?: number }): Promise<string> {
    const docker = await this.getDockerInstance(hostConfig);
    const stream = await docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      tail: options?.tail ?? 100,
    });
    if (Buffer.isBuffer(stream)) {
      return stream.toString("utf8");
    }
    return String(stream ?? "");
  }

  private async getInstance(): Promise<Docker> {
    if (!this.dockerInstance) {
      this.dockerInstance = await this.createDockerInstance(this.defaultHostConfig);
    }
    return this.dockerInstance;
  }

  /**
   * Recreate a container with updated environment variables.
   *
   * Docker environment variables are baked in at container creation time and
   * cannot be changed without recreating the container. This method:
   * 1. Inspects the old container to capture its configuration
   * 2. Stops and removes the old container
   * 3. Creates a new container with the same image and volumes but updated env vars
   * 4. Starts the new container
   * 5. Returns the new container ID
   *
   * Volume mounts are preserved across recreation. If persistentStorage is false,
   * volumes are not included in the new container.
   */
  async recreateContainer(
    containerId: string,
    options: {
      envVars: Record<string, string>;
      imageName: string;
      volumeMounts: DockerVolumeMount[];
      hostConfig?: DockerHostConfig;
    },
  ): Promise<string> {
    const docker = await this.getDockerInstance(options.hostConfig);
    const container = docker.getContainer(containerId);

    // Inspect the old container to capture its config
    const inspect = await container.inspect();
    const oldName = (inspect.Name ?? "").replace(/^\//, "");

    // Build environment variable array from the provided map
    const envArray = Object.entries(options.envVars).map(
      ([key, value]) => `${key}=${value}`,
    );

    // Build binds for volume mounts
    const binds = options.volumeMounts.map(
      (mount) => `${mount.hostPath}:${mount.containerPath}:${mount.mode}`,
    );

    // Stop and remove the old container
    try {
      await container.stop({ t: 5 });
    } catch (error) {
      // Container may already be stopped
      const message = toErrorMessage(error);
      if (!message.includes("is not running") && !message.includes("already stopped")) {
        throw error;
      }
    }
    await container.remove({ force: true });

    // Create the new container with updated env vars
    const newContainer = await docker.createContainer({
      name: oldName || undefined,
      Image: options.imageName,
      Env: envArray,
      HostConfig: {
        Binds: binds.length > 0 ? binds : undefined,
        RestartPolicy: {
          Name: "unless-stopped",
        },
      },
    });

    // Start the new container
    await newContainer.start();

    return newContainer.id;
  }

  dispose(): void {
    this.dockerInstance = null;
  }
}

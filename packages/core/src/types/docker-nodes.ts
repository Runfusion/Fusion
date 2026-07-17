/**
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Docker node provision/status domain types peeled from types.ts.
 */

/** Persisted configuration for a Docker-managed Fusion node. */
export interface DockerNodeConfig {
  /** Docker image name (e.g., "runfusion/fusion:latest") */
  image: string;
  /** Container name (defaults to "fusion-{nodeId}") */
  containerName?: string;
  /** Volume mount definitions */
  volumeMounts: DockerNodeVolumeMount[];
  /** Environment variable overrides (key-value pairs) */
  environment: Record<string, string>;
  /** Resource limits */
  resources?: DockerNodeContainerResourceConfig;
  /** Docker host connection settings */
  host?: DockerNodeHostConfig;
  /** Optional CLI tools to include in the container */
  extraClis?: string[];
  /** Persistent storage configuration */
  persistence?: DockerNodePersistenceConfig;
  /** Config version counter — starts at 1, auto-incremented on every update */
  configVersion: number;
  /** ISO timestamp of last config change (auto-set on update) */
  lastUpdated?: string;
}

export interface DockerNodeVolumeMount {
  /** Host path or named volume */
  hostPath: string;
  /** Container mount path */
  containerPath: string;
  /** "rw" (default) or "ro" */
  mode?: "rw" | "ro";
  /** "volume" (default) for named volumes, "bind" for host bind mounts */
  type?: "volume" | "bind";
}

export interface DockerNodeContainerResourceConfig {
  /** Memory limit in bytes (e.g., 2147483648 for 2GB) */
  memoryBytes?: number;
  /** CPU count limit (e.g., 2.0 for two cores) */
  cpuCount?: number;
  /** PIDs limit */
  pidsLimit?: number;
}

export interface DockerNodeHostConfig {
  /** Docker context name (for named Docker context selection) */
  contextName?: string;
  /** Explicit Docker host URL (e.g., "tcp://192.168.1.100:2376") */
  dockerHost?: string;
  /** Path to TLS CA cert */
  tlsCaCert?: string;
  /** Path to TLS client cert */
  tlsCert?: string;
  /** Path to TLS client key */
  tlsKey?: string;
  /** Whether to verify TLS (default: true) */
  tlsVerify?: boolean;
}

export interface DockerNodePersistenceConfig {
  /** Named Docker volume for Fusion data */
  volumeName?: string;
  /** Whether to retain the volume when the node is deleted (default: false) */
  retainOnDelete?: boolean;
}

export function validateDockerNodeConfig(config: unknown): {
  valid: boolean;
  config?: DockerNodeConfig;
  errors?: string[];
} {
  const errors: string[] = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }

  const candidate = config as Record<string, unknown>;

  if (typeof candidate.image !== "string" || !candidate.image.trim()) {
    errors.push("image must be a non-empty string");
  }

  if (!Array.isArray(candidate.volumeMounts)) {
    errors.push("volumeMounts must be an array");
  } else {
    candidate.volumeMounts.forEach((mount, index) => {
      if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
        errors.push(`volumeMounts[${index}] must be an object`);
        return;
      }
      const mountCandidate = mount as Record<string, unknown>;
      if (typeof mountCandidate.hostPath !== "string") {
        errors.push(`volumeMounts[${index}].hostPath must be a string`);
      }
      if (typeof mountCandidate.containerPath !== "string") {
        errors.push(`volumeMounts[${index}].containerPath must be a string`);
      }
      if (mountCandidate.mode !== undefined && mountCandidate.mode !== "rw" && mountCandidate.mode !== "ro") {
        errors.push(`volumeMounts[${index}].mode must be "rw" or "ro"`);
      }
      if (mountCandidate.type !== undefined && mountCandidate.type !== "volume" && mountCandidate.type !== "bind") {
        errors.push(`volumeMounts[${index}].type must be "volume" or "bind"`);
      }
    });
  }

  if (!candidate.environment || typeof candidate.environment !== "object" || Array.isArray(candidate.environment)) {
    errors.push("environment must be an object");
  } else {
    for (const [key, value] of Object.entries(candidate.environment)) {
      if (typeof key !== "string" || typeof value !== "string") {
        errors.push(`environment.${key} must be a string value`);
      }
    }
  }

  if (typeof candidate.configVersion !== "number" || !Number.isFinite(candidate.configVersion) || candidate.configVersion < 1) {
    errors.push("configVersion must be a number >= 1");
  }

  const validateOptionalObject = (
    fieldName: string,
    value: unknown,
    validators: Array<[string, (value: unknown) => boolean, string]>,
  ) => {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${fieldName} must be an object`);
      return;
    }
    const typed = value as Record<string, unknown>;
    for (const [prop, test, message] of validators) {
      if (typed[prop] !== undefined && !test(typed[prop])) {
        errors.push(`${fieldName}.${prop} ${message}`);
      }
    }
  };

  validateOptionalObject("resources", candidate.resources, [
    ["memoryBytes", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
    ["cpuCount", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
    ["pidsLimit", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
  ]);

  validateOptionalObject("host", candidate.host, [
    ["contextName", (value) => typeof value === "string", "must be a string"],
    ["dockerHost", (value) => typeof value === "string", "must be a string"],
    ["tlsCaCert", (value) => typeof value === "string", "must be a string"],
    ["tlsCert", (value) => typeof value === "string", "must be a string"],
    ["tlsKey", (value) => typeof value === "string", "must be a string"],
    ["tlsVerify", (value) => typeof value === "boolean", "must be a boolean"],
  ]);

  validateOptionalObject("persistence", candidate.persistence, [
    ["volumeName", (value) => typeof value === "string", "must be a string"],
    ["retainOnDelete", (value) => typeof value === "boolean", "must be a boolean"],
  ]);

  if (candidate.extraClis !== undefined) {
    if (!Array.isArray(candidate.extraClis) || candidate.extraClis.some((item) => typeof item !== "string")) {
      errors.push("extraClis must be an array of strings");
    }
  }

  if (candidate.containerName !== undefined && typeof candidate.containerName !== "string") {
    errors.push("containerName must be a string");
  }

  if (candidate.lastUpdated !== undefined && typeof candidate.lastUpdated !== "string") {
    errors.push("lastUpdated must be a string");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, config: candidate as unknown as DockerNodeConfig };
}

export function sanitizeDockerNodeConfigForResponse(config: DockerNodeConfig): DockerNodeConfig {
  const clone = structuredClone(config);
  const sensitivePattern = /API_KEY|SECRET|TOKEN|PASSWORD/i;

  for (const [key, value] of Object.entries(clone.environment)) {
    if (sensitivePattern.test(key) && typeof value === "string") {
      clone.environment[key] = "***";
    }
  }

  if (clone.host?.tlsKey) {
    clone.host.tlsKey = "***";
  }

  return clone;
}

/** Version information tracked per node for plugin synchronization */
export interface NodeVersionInfo {
  /** Core Fusion application version (semver string, e.g., "0.1.0") */
  appVersion: string;
  /** Map of plugin-id → semver version string for all installed plugins */
  pluginVersions: Record<string, string>;
  /** ISO-8601 timestamp of the last sync operation */
  lastSyncedAt: string;
}

/** Input for updating node version info. appVersion is optional and will be auto-filled if not provided. */
export type NodeVersionInfoInput = Omit<NodeVersionInfo, "appVersion"> & {
  /** Core Fusion application version. If not provided, will be auto-filled with the current app version. */
  appVersion?: string;
};

/** Lifecycle status of a managed Docker node. */
export type DockerNodeStatus = "creating" | "running" | "stopped" | "error" | "recreating" | "deleting";

/** Docker daemon connection settings for provisioning a managed node container. */
export interface DockerHostConfig {
  /** Docker host URI (for example: tcp://192.168.1.50:2376 or unix:///var/run/docker.sock). */
  host?: string;
  /** Named Docker context to target. */
  context?: string;
  /** Whether to verify Docker daemon TLS certificates. */
  tlsVerify?: boolean;
  /** Path to Docker daemon CA certificate. */
  tlsCaPath?: string;
  /** Path to Docker client certificate. */
  tlsCertPath?: string;
  /** Path to Docker client private key. */
  tlsKeyPath?: string;
}

/** Container CPU and memory limit settings for managed Docker nodes. */
export interface DockerResourceSizing {
  /** Memory limit in MB (for example: 4096). */
  memoryMB?: number;
  /** CPU limit (for example: 2.0). */
  cpus?: number;
  /** Swap limit in MB (0 = unlimited swap, Docker default behavior). */
  memorySwapMB?: number;
}

/** A single bind mount definition for a managed Docker node container. */
export interface DockerVolumeMount {
  /** Absolute path on the host machine. */
  hostPath: string;
  /** Path inside the container. */
  containerPath: string;
  /** Mount mode. Defaults to read/write when omitted. */
  mode?: "ro" | "rw";
}

/** Optional additional CLI tools installed in the managed Docker node image. */
export type DockerExtraCli = "claude-cli" | "droid-cli";

/** Persisted definition and lifecycle metadata for a managed Docker node. */
export interface ManagedDockerNode {
  /** Unique managed Docker node ID (for example: dn_abc123). */
  id: string;
  /** Linked mesh node ID after registration, or null while provisioning. */
  nodeId: string | null;
  /** Display name (unique across managed Docker nodes). */
  name: string;
  /** Docker image repository/name (for example: runfusion/fusion). */
  imageName: string;
  /** Docker image tag (for example: latest or 0.2.0). */
  imageTag: string;
  /** Provisioned container ID, or null before container creation. */
  containerId: string | null;
  /** Current managed Docker lifecycle status. */
  status: DockerNodeStatus;
  /** Docker daemon host/context configuration used for operations. */
  hostConfig: DockerHostConfig;
  /** Environment variables injected into the container. */
  envVars: Record<string, string>;
  /** Bind mounts configured for this container. */
  volumeMounts: DockerVolumeMount[];
  /** Resource limits for this container. */
  resourceSizing: DockerResourceSizing;
  /** Optional extra CLI tools included in provisioning. */
  extraClis: DockerExtraCli[];
  /** Whether storage volumes persist across container recreation. */
  persistentStorage: boolean;
  /** Reachable URL for mesh/node registration once running. */
  reachableUrl: string | null;
  /** API key for the managed node, auto-generated or user-provided. */
  apiKey: string | null;
  /** Last provisioning/runtime error message when status is error. */
  errorMessage: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last update timestamp. */
  updatedAt: string;
}

/** Input for creating a managed Docker node record. */
export type ManagedDockerNodeInput = Omit<
  ManagedDockerNode,
  "id" | "containerId" | "status" | "createdAt" | "updatedAt" | "errorMessage"
>;

/** Partial update payload for managed Docker nodes. */
export type ManagedDockerNodeUpdate = Partial<
  Omit<ManagedDockerNode, "id" | "createdAt">
>;

/** Input to the mesh configuration generation process. */
export interface MeshConfigGeneratorInput {
  /** The managed Docker node record (from FN-3107). */
  managedNode: ManagedDockerNode;
  /** The orchestrating node's URL (e.g., "http://192.168.1.10:4040"). */
  orchestratorUrl: string;
  /** The orchestrating node's API key for authentication. */
  orchestratorApiKey: string;
  /** Optional user-provided API key. If omitted, one is auto-generated. */
  nodeApiKey?: string;
  /** Optional container port override. If omitted, defaults to 4041. */
  containerPort?: number;
}

/** Input to the end-to-end provision-and-register flow. */
export interface FullProvisioningInput {
  /** The managed Docker node to configure and register. */
  managedNode: ManagedDockerNode;
  /** The orchestrating node's URL. */
  orchestratorUrl: string;
  /** The orchestrating node's API key. */
  orchestratorApiKey: string;
  /** Optional user-provided API key for the new node. */
  nodeApiKey?: string;
  /** Optional container port override. */
  containerPort?: number;
}

/** Configuration bundle needed for a new node to join the mesh. */
export interface MeshConnectionConfig {
  /** API key for authenticating to this node. Auto-generated if not provided by user. */
  nodeApiKey: string;
  /** The URL the orchestrating node uses to reach the new container. */
  reachableUrl: string;
  /** Orchestrating node's URL, pushed to the container so it knows its mesh parent. */
  orchestratorUrl: string;
  /** Orchestrating node's API key for inbound settings sync authentication. */
  orchestratorApiKey: string;
  /** Port the container's Fusion server will listen on. */
  containerPort: number;
  /** Environment variables assembled from the above for injection into the container. */
  envVars: Record<string, string>;
}

/** Information about a discovered Docker context */
export interface DockerContextInfo {
  /** Context name (e.g., "default", "my-remote") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Docker host URI for this context (e.g., "tcp://192.168.1.50:2376") */
  dockerHost?: string;
  /** Whether this is the currently active context */
  isCurrentContext: boolean;
  /** Whether this context has a connection error */
  isError?: boolean;
  /** Error message if the context is unreachable */
  errorMessage?: string;
}

/** Result of testing Docker daemon connectivity */
export interface DockerConnectivityResult {
  /** Whether the connection succeeded */
  success: boolean;
  /** Docker Engine version string */
  dockerVersion?: string;
  /** Docker API version string */
  apiVersion?: string;
  /** Docker Engine OS/arch info */
  operatingSystem?: string;
  /** Error message if connection failed */
  error?: string;
  /** Whether the target is the local Docker daemon */
  isLocalDaemon: boolean;
}

/** Minimal container inspection result from Docker */
export interface DockerContainerInspectResult {
  /** Container ID */
  id: string;
  /** Container name (with leading / stripped) */
  name: string;
  /** Container status string (e.g., "running", "exited") */
  status: string;
  /** Image name/tag */
  image: string;
  /** Creation timestamp (Unix epoch) */
  created: number;
  /** Detailed container state */
  state: {
    running: boolean;
    paused: boolean;
    restarting: boolean;
    dead: boolean;
    error?: string;
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  };
  /** Optional exposed ports summary */
  ports?: Record<string, string>;
}

/** Configuration for the Fusion Docker image to use for provisioning */
export interface DockerNodeImageConfig {
  /** Image name (e.g., "runfusion/fusion" or "ghcr.io/runfusion/fusion") */
  image: string;
  /** Image tag (e.g., "latest", "0.14.1") */
  tag: string;
  /** Whether to pull the image before creating the container */
  pullImage: boolean;
  /** Optional registry authentication — username */
  registryUsername?: string;
  /** Optional registry authentication — password/token */
  registryPassword?: string;
}

/** Resource constraints for a provisioned Docker container */
export interface DockerNodeResourceConfig {
  /** CPU limit in cores (e.g., 2 = 2 CPUs). Undefined = unlimited */
  cpuLimit?: number;
  /** Memory limit in megabytes. Undefined = unlimited */
  memoryLimitMb?: number;
  /** Memory swap limit in megabytes. -1 = unlimited swap. Undefined = default */
  memorySwapMb?: number;
}

/** Input for provisioning a new Docker-based Fusion node */
export interface DockerProvisionInput {
  /** Display name for the node (must be unique) */
  nodeName: string;
  /** Docker host configuration — where to create the container */
  hostConfig: DockerHostConfig;
  /** Image configuration — which Fusion image to use */
  imageConfig: DockerNodeImageConfig;
  /** Resource constraints for the container */
  resourceConfig?: DockerNodeResourceConfig;
  /** Environment variables to set in the container (KEY=VALUE strings) */
  environment?: string[];
  /** Volume mount specifications (e.g., ["fusion-data:/data", "/host/path:/container/path"]) */
  volumeMounts?: string[];
  /** Named volume for persistent Fusion data storage. If provided, mounted at /data */
  persistentVolume?: string;
  /** Optional extra CLI tools to include in the container (e.g., ["claude", "droid"]) */
  extraClis?: string[];
  /** The URL/hostname where this node will be reachable by other nodes */
  reachableUrl?: string;
  /** Whether to auto-generate an API key for this node */
  autoGenerateApiKey: boolean;
  /** Explicit API key to use (if autoGenerateApiKey is false) */
  apiKey?: string;
  /** Maximum concurrent tasks for this node (default: 2) */
  maxConcurrent?: number;
  /** Optional Docker network to attach the container to */
  network?: string;
  /** Optional container labels (key-value pairs) */
  labels?: Record<string, string>;
}

/** Result of a Docker node provisioning operation */
export interface DockerProvisionResult {
  /** Whether provisioning succeeded */
  success: boolean;
  /** The container ID created by Docker */
  containerId?: string;
  /** The container name (generated or specified) */
  containerName?: string;
  /** The registered node ID in CentralCore */
  nodeId?: string;
  /** The API key generated or assigned for this node */
  apiKey?: string;
  /** The port mapping (if applicable) */
  portMapping?: string;
  /** Error message if provisioning failed */
  error?: string;
  /** The stage at which failure occurred (for error reporting) */
  failedStage?: "image-pull" | "container-create" | "container-start" | "node-register" | "config-apply";
  /** Duration of the provisioning operation in ms */
  durationMs?: number;
}

/** A single plugin's version information for sync comparison */

import { useState, useCallback, useRef } from "react";
import type {
  DockerContainerInspectResult,
  DockerHostConfig,
  DockerProvisionInput,
  DockerProvisionResult,
} from "@fusion/core";

/** Result of a Docker lifecycle operation (start/stop/restart) */
export interface DockerLifecycleResult {
  success: boolean;
  error?: string;
}

/** Default Fusion Docker image config returned by the API */
export interface DockerDefaultImageConfig {
  image: string;
  tag: string;
}

/** Return type for the useDockerProvisioning hook */
export interface UseDockerProvisioningResult {
  /** Whether a provision operation is in progress */
  isProvisioning: boolean;
  /** Result of the last provision operation */
  provisionResult: DockerProvisionResult | null;
  /** Error from the last provision operation */
  provisionError: string | null;
  /** Whether a deprovision operation is in progress */
  isDeprovisioning: boolean;
  /** Error from the last deprovision operation */
  deprovisionError: string | null;
  /** Provision a new Docker node */
  provision: (input: DockerProvisionInput) => Promise<DockerProvisionResult>;
  /** Deprovision (stop and remove) a Docker node container */
  deprovision: (
    containerId: string,
    hostConfig: DockerHostConfig,
    removeVolumes?: boolean,
  ) => Promise<DockerLifecycleResult>;
  /** Start a stopped container */
  startContainer: (
    containerId: string,
    hostConfig: DockerHostConfig,
  ) => Promise<DockerLifecycleResult>;
  /** Stop a running container */
  stopContainer: (
    containerId: string,
    hostConfig: DockerHostConfig,
  ) => Promise<DockerLifecycleResult>;
  /** Restart a container */
  restartContainer: (
    containerId: string,
    hostConfig: DockerHostConfig,
  ) => Promise<DockerLifecycleResult>;
  /** Get the runtime status of a container */
  getContainerStatus: (
    containerId: string,
    hostConfig: DockerHostConfig,
  ) => Promise<DockerContainerInspectResult | null>;
  /** Get the default Fusion Docker image config */
  getDefaultImage: () => Promise<DockerDefaultImageConfig>;
}

/**
 * Hook for managing Docker node provisioning, deprovisioning, and lifecycle.
 * Does not auto-load on mount — callers decide when to trigger operations.
 */
export function useDockerProvisioning(): UseDockerProvisioningResult {
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState<DockerProvisionResult | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [isDeprovisioning, setIsDeprovisioning] = useState(false);
  const [deprovisionError, setDeprovisionError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const provision = useCallback(async (input: DockerProvisionInput): Promise<DockerProvisionResult> => {
    setIsProvisioning(true);
    setProvisionError(null);
    setProvisionResult(null);

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/docker/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      const result = (await response.json()) as DockerProvisionResult;

      if (!response.ok) {
        const errorMsg = result.error ?? `Provisioning failed with status ${response.status}`;
        setProvisionError(errorMsg);
        setProvisionResult(result);
        return result;
      }

      setProvisionResult(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProvisionError(message);
      const result: DockerProvisionResult = { success: false, error: message };
      setProvisionResult(result);
      return result;
    } finally {
      setIsProvisioning(false);
    }
  }, []);

  const deprovision = useCallback(
    async (
      containerId: string,
      hostConfig: DockerHostConfig,
      removeVolumes?: boolean,
    ): Promise<DockerLifecycleResult> => {
      setIsDeprovisioning(true);
      setDeprovisionError(null);

      try {
        const response = await fetch("/api/docker/deprovision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ containerId, hostConfig, removeVolumes }),
        });

        const result = (await response.json()) as DockerLifecycleResult;

        if (!response.ok) {
          const errorMsg = (result as { error?: string }).error ?? `Deprovision failed with status ${response.status}`;
          setDeprovisionError(errorMsg);
          return { success: false, error: errorMsg };
        }

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDeprovisionError(message);
        return { success: false, error: message };
      } finally {
        setIsDeprovisioning(false);
      }
    },
    [],
  );

  const startContainer = useCallback(
    async (containerId: string, hostConfig: DockerHostConfig): Promise<DockerLifecycleResult> => {
      try {
        const response = await fetch(`/api/docker/containers/${containerId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostConfig }),
        });
        return (await response.json()) as DockerLifecycleResult;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  const stopContainer = useCallback(
    async (containerId: string, hostConfig: DockerHostConfig): Promise<DockerLifecycleResult> => {
      try {
        const response = await fetch(`/api/docker/containers/${containerId}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostConfig }),
        });
        return (await response.json()) as DockerLifecycleResult;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  const restartContainer = useCallback(
    async (containerId: string, hostConfig: DockerHostConfig): Promise<DockerLifecycleResult> => {
      try {
        const response = await fetch(`/api/docker/containers/${containerId}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostConfig }),
        });
        return (await response.json()) as DockerLifecycleResult;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  const getContainerStatus = useCallback(
    async (containerId: string, hostConfig: DockerHostConfig): Promise<DockerContainerInspectResult | null> => {
      try {
        const query = hostConfig
          ? `?hostConfig=${encodeURIComponent(JSON.stringify(hostConfig))}`
          : "";
        const response = await fetch(`/api/docker/containers/${containerId}/status${query}`);
        if (!response.ok) return null;
        return (await response.json()) as DockerContainerInspectResult | null;
      } catch {
        return null;
      }
    },
    [],
  );

  const getDefaultImage = useCallback(async (): Promise<DockerDefaultImageConfig> => {
    const response = await fetch("/api/docker/default-image");
    return (await response.json()) as DockerDefaultImageConfig;
  }, []);

  return {
    isProvisioning,
    provisionResult,
    provisionError,
    isDeprovisioning,
    deprovisionError,
    provision,
    deprovision,
    startContainer,
    stopContainer,
    restartContainer,
    getContainerStatus,
    getDefaultImage,
  };
}

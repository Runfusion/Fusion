import { useCallback, useState } from "react";
import type { DockerConnectivityResult, DockerContextInfo, DockerHostConfig } from "@fusion/core";

interface LocalDockerAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export function useDockerTargets() {
  const [contexts, setContexts] = useState<DockerContextInfo[]>([]);
  const [isLoadingContexts, setIsLoadingContexts] = useState(false);
  const [contextsError, setContextsError] = useState<string | null>(null);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<DockerConnectivityResult | null>(null);
  const [isCheckingLocal, setIsCheckingLocal] = useState(false);

  const loadContexts = useCallback(async () => {
    setIsLoadingContexts(true);
    setContextsError(null);
    try {
      const response = await fetch("/api/docker/contexts");
      if (!response.ok) {
        throw new Error(`Failed to load Docker contexts (${response.status})`);
      }
      const payload = (await response.json()) as DockerContextInfo[];
      setContexts(payload);
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setContextsError(message);
      throw error;
    } finally {
      setIsLoadingContexts(false);
    }
  }, []);

  const testConnection = useCallback(async (hostConfig?: DockerHostConfig) => {
    setIsTestingConnection(true);
    try {
      const response = await fetch("/api/docker/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostConfig }),
      });
      if (!response.ok) {
        throw new Error(`Failed to test Docker connection (${response.status})`);
      }
      const payload = (await response.json()) as DockerConnectivityResult;
      setLastTestResult(payload);
      return payload;
    } finally {
      setIsTestingConnection(false);
    }
  }, []);

  const checkLocalDocker = useCallback(async () => {
    setIsCheckingLocal(true);
    try {
      const response = await fetch("/api/docker/local-available");
      if (!response.ok) {
        throw new Error(`Failed to check local Docker availability (${response.status})`);
      }
      return (await response.json()) as LocalDockerAvailability;
    } finally {
      setIsCheckingLocal(false);
    }
  }, []);

  return {
    contexts,
    isLoadingContexts,
    contextsError,
    loadContexts,
    isTestingConnection,
    lastTestResult,
    testConnection,
    isCheckingLocal,
    checkLocalDocker,
  };
}

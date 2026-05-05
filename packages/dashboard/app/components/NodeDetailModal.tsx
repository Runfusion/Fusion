import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FileText,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Shield,
  Square,
  Upload,
  X,
} from "lucide-react";
import type { ContainerStatusInfo, DockerNodeConfig, ManagedDockerNodeInfo, NodeInfo, NodeUpdateInput, ProjectInfo } from "../api";
import type { ToastType } from "../hooks/useToast";
import { getProjectsForNode } from "../utils/nodeProjectAssignment";
import type { ComputedNodeSyncStatus } from "../hooks/useNodeSettingsSync";
import { formatRelativeTime } from "../hooks/useNodeSettingsSync";
import { SettingsSyncLog } from "./SettingsSyncLog";
import type { SyncLogEntry } from "./SettingsSyncLog";
import { SettingsSyncConflictModal } from "./SettingsSyncConflictModal";
import type { SettingsConflictEntry, ConflictResolutionResult } from "./SettingsSyncConflictModal";
import "./NodeDetailModal.css";

interface NodeDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  node: NodeInfo | null;
  projects: ProjectInfo[];
  onUpdate: (id: string, updates: NodeUpdateInput) => Promise<void>;
  onHealthCheck: (id: string) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
  syncStatus?: ComputedNodeSyncStatus;
  onPushSettings?: (nodeId: string) => Promise<unknown>;
  onPullSettings?: (nodeId: string) => Promise<unknown>;
  onSyncAuth?: (nodeId: string) => Promise<unknown>;
  syncHistory?: SyncLogEntry[];
  onResolveConflicts?: (resolutions: ConflictResolutionResult[]) => Promise<void>;
  managedDockerNode?: ManagedDockerNodeInfo;
  containerStatus?: ContainerStatusInfo;
  onFetchContainerStatus?: (managedId: string) => Promise<ContainerStatusInfo>;
  onFetchLogs?: (managedId: string) => Promise<string>;
  onUpdateDockerConfig?: (nodeId: string, config: Partial<DockerNodeConfig>) => Promise<DockerNodeConfig>;
  onFetchDockerConfigDiff?: (nodeId: string) => Promise<{ persistedVersion: number; deployedVersion: number | null; needsRecreate: boolean }>;
}

const SENSITIVE_ENV_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/i;

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatDockerUptime(startedAt?: string): string {
  if (!startedAt) return "—";
  const started = new Date(startedAt);
  const now = Date.now();
  if (Number.isNaN(started.getTime()) || started.getTime() > now) return "—";
  const seconds = Math.floor((now - started.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function getSyncStateDotClass(syncState: ComputedNodeSyncStatus["syncState"]): string {
  switch (syncState) {
    case "synced":
      return "node-detail-modal__sync-dot--synced";
    case "diff":
      return "node-detail-modal__sync-dot--diff";
    case "error":
      return "node-detail-modal__sync-dot--error";
    case "pending":
      return "node-detail-modal__sync-dot--pending";
    case "never-synced":
    default:
      return "node-detail-modal__sync-dot--never";
  }
}

function getDockerStatusTone(status?: string): "success" | "warning" | "error" {
  if (status === "running") return "success";
  if (status === "creating" || status === "recreating" || status === "restarting") return "warning";
  return "error";
}

function getDockerStatusLabel(status?: string): string {
  if (!status) return "Unknown";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function parsePortFromReachableUrl(url?: string): string {
  if (!url) return "—";
  try {
    const parsed = new URL(url);
    if (parsed.port) return parsed.port;
    return parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "—";
  } catch {
    return "—";
  }
}

function maskEnvValue(key: string, value: string): string {
  return SENSITIVE_ENV_KEY_PATTERN.test(key) ? "••••••••" : value;
}

export function NodeDetailModal({
  isOpen,
  onClose,
  node,
  projects,
  onUpdate,
  onHealthCheck,
  addToast,
  syncStatus,
  onPushSettings,
  onPullSettings,
  onSyncAuth,
  syncHistory = [],
  onResolveConflicts,
  managedDockerNode,
  containerStatus,
  onFetchContainerStatus,
  onFetchLogs,
  onUpdateDockerConfig,
  onFetchDockerConfigDiff,
}: NodeDetailModalProps) {
  const isMountedRef = useRef(true);
  const [editMode, setEditMode] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [isSaving, setIsSaving] = useState(false);

  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isSyncingAuth, setIsSyncingAuth] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflicts] = useState<SettingsConflictEntry[]>([]);

  const [liveContainerStatus, setLiveContainerStatus] = useState<ContainerStatusInfo | undefined>(containerStatus);
  const [isRefreshingContainerStatus, setIsRefreshingContainerStatus] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [dockerConfigExpanded, setDockerConfigExpanded] = useState(false);
  const [dockerConfigDraft, setDockerConfigDraft] = useState<DockerNodeConfig | null>(node?.dockerConfig ?? null);
  const [dockerEnvReveal, setDockerEnvReveal] = useState<Record<string, boolean>>({});
  const [dockerConfigSaving, setDockerConfigSaving] = useState(false);
  const [dockerConfigNeedsRecreate, setDockerConfigNeedsRecreate] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLiveContainerStatus(containerStatus);
  }, [containerStatus]);

  useEffect(() => {
    if (!node || !isOpen) {
      setEditMode(false);
      setLogsOpen(false);
      setLogs("");
      return;
    }

    setName(node.name);
    setUrl(node.url ?? "");
    setApiKey(node.apiKey ?? "");
    setMaxConcurrent(node.maxConcurrent);
    setEditMode(false);
    setDockerConfigDraft(node.dockerConfig ?? null);
    setDockerConfigExpanded(false);
    setDockerEnvReveal({});
  }, [isOpen, node]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const assignedProjects = useMemo(() => {
    if (!node) return [];
    return getProjectsForNode(projects, node);
  }, [node, projects]);

  const dockerHost = useMemo(() => {
    if (!managedDockerNode) return "—";
    return managedDockerNode.hostConfig.type === "remote" ? managedDockerNode.hostConfig.host ?? "—" : "Local Docker";
  }, [managedDockerNode]);

  const dockerResourceSizing = useMemo(() => {
    if (!managedDockerNode?.resourceSizing?.cpuLimit && !managedDockerNode?.resourceSizing?.memoryLimit) {
      return "Default";
    }
    return `${managedDockerNode.resourceSizing?.cpuLimit ?? "Default CPU"} / ${managedDockerNode.resourceSizing?.memoryLimit ?? "Default memory"}`;
  }, [managedDockerNode]);

  const handleHealthCheck = useCallback(async () => {
    if (!node) return;

    try {
      await onHealthCheck(node.id);
      if (!isMountedRef.current) return;
      addToast(`Health check completed for ${node.name}`, "success");
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Health check failed";
      addToast(message, "error");
    }
  }, [addToast, node, onHealthCheck]);

  const handlePushSettings = useCallback(async () => {
    if (!node || !onPushSettings) return;
    setSyncError(null);
    setIsPushing(true);
    try {
      await onPushSettings(node.id);
      if (!isMountedRef.current) return;
      addToast("Settings pushed successfully", "success");
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Push settings failed";
      setSyncError(message);
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) {
        setIsPushing(false);
      }
    }
  }, [addToast, node, onPushSettings]);

  const handlePullSettings = useCallback(async () => {
    if (!node || !onPullSettings) return;
    setSyncError(null);
    setIsPulling(true);
    try {
      await onPullSettings(node.id);
      if (!isMountedRef.current) return;
      addToast("Settings pulled successfully", "success");
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Pull settings failed";
      setSyncError(message);
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) {
        setIsPulling(false);
      }
    }
  }, [addToast, node, onPullSettings]);

  const handleSyncAuth = useCallback(async () => {
    if (!node || !onSyncAuth) return;
    setSyncError(null);
    setIsSyncingAuth(true);
    try {
      await onSyncAuth(node.id);
      if (!isMountedRef.current) return;
      addToast("Auth credentials synced successfully", "success");
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Auth sync failed";
      setSyncError(message);
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) {
        setIsSyncingAuth(false);
      }
    }
  }, [addToast, node, onSyncAuth]);

  const handleDismissSyncError = useCallback(() => {
    setSyncError(null);
  }, []);

  const handleRefreshContainerStatus = useCallback(async () => {
    if (!managedDockerNode || !onFetchContainerStatus) return;
    setIsRefreshingContainerStatus(true);
    try {
      const result = await onFetchContainerStatus(managedDockerNode.id);
      if (!isMountedRef.current) return;
      setLiveContainerStatus(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch container status";
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) {
        setIsRefreshingContainerStatus(false);
      }
    }
  }, [addToast, managedDockerNode, onFetchContainerStatus]);

  const handleFetchLogs = useCallback(async () => {
    if (!managedDockerNode || !onFetchLogs) return;
    setLogsOpen(true);
    setLogsLoading(true);
    try {
      const result = await onFetchLogs(managedDockerNode.id);
      if (!isMountedRef.current) return;
      setLogs(result);
    } catch (error) {
      if (!isMountedRef.current) return;
      setLogs("");
      const message = error instanceof Error ? error.message : "Failed to fetch container logs";
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) {
        setLogsLoading(false);
      }
    }
  }, [addToast, managedDockerNode, onFetchLogs]);

  const handleSave = useCallback(async () => {
    if (!node || isSaving) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      addToast("Name is required", "error");
      return;
    }

    if (node.type === "remote" && !url.trim()) {
      addToast("URL is required for remote nodes", "error");
      return;
    }

    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      addToast("Concurrency must be at least 1", "error");
      return;
    }

    setIsSaving(true);
    try {
      await onUpdate(node.id, {
        name: trimmedName,
        url: node.type === "remote" ? url.trim() || undefined : undefined,
        apiKey: node.type === "remote" ? apiKey || undefined : undefined,
        maxConcurrent,
      });
      addToast(`Updated ${trimmedName}`, "success");
      setEditMode(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update node";
      addToast(message, "error");
    } finally {
      setIsSaving(false);
    }
  }, [addToast, apiKey, isSaving, maxConcurrent, name, node, onUpdate, url]);

  useEffect(() => {
    if (!node?.dockerConfig || !onFetchDockerConfigDiff || !isOpen) return;
    void onFetchDockerConfigDiff(node.id)
      .then((diff) => {
        if (!isMountedRef.current) return;
        setDockerConfigNeedsRecreate(diff.needsRecreate);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        setDockerConfigNeedsRecreate(false);
      });
  }, [isOpen, node, onFetchDockerConfigDiff]);

  const handleDockerConfigSave = useCallback(async () => {
    if (!node || !dockerConfigDraft || !onUpdateDockerConfig || dockerConfigSaving) return;
    setDockerConfigSaving(true);
    try {
      const result = await onUpdateDockerConfig(node.id, {
        image: dockerConfigDraft.image,
        volumeMounts: dockerConfigDraft.volumeMounts,
        environment: dockerConfigDraft.environment,
        resources: dockerConfigDraft.resources,
        host: dockerConfigDraft.host,
        extraClis: dockerConfigDraft.extraClis,
        persistence: dockerConfigDraft.persistence,
        containerName: dockerConfigDraft.containerName,
      });
      if (!isMountedRef.current) return;
      setDockerConfigDraft(result);
      addToast("Docker config saved", "success");
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Failed to save Docker config";
      addToast(message, "error");
    } finally {
      if (isMountedRef.current) setDockerConfigSaving(false);
    }
  }, [addToast, dockerConfigDraft, dockerConfigSaving, node, onUpdateDockerConfig]);

  const handleCancelEdit = useCallback(() => {
    if (!node) return;
    setName(node.name);
    setUrl(node.url ?? "");
    setApiKey(node.apiKey ?? "");
    setMaxConcurrent(node.maxConcurrent);
    setEditMode(false);
  }, [node]);

  if (!isOpen || !node) return null;

  const effectiveDockerStatus = liveContainerStatus?.status ?? managedDockerNode?.status;
  const dockerStatusTone = getDockerStatusTone(effectiveDockerStatus);

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div
        className="modal modal-lg node-detail-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Node details for ${node.name}`}
      >
        <div className="modal-header">
          <h3>Node Details</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close node detail modal">&times;</button>
        </div>

        <div className="modal-body node-detail-modal__body">
          <section className="node-detail-modal__section">
            <div className="node-detail-modal__section-header">
              <h4>Overview</h4>
              {!editMode && (
                <button className="btn btn-sm" onClick={() => setEditMode(true)}>
                  <Pencil size={14} />
                  Edit
                </button>
              )}
            </div>

            <div className="node-detail-modal__grid">
              <label className="node-detail-modal__field">
                <span>Name</span>
                {editMode ? (
                  <input className="input" value={name} onChange={(event) => setName(event.target.value)} disabled={isSaving} />
                ) : (
                  <strong>{node.name}</strong>
                )}
              </label>

              <div className="node-detail-modal__field">
                <span>Type</span>
                <strong>{node.type === "local" ? "Local" : "Remote"}</strong>
              </div>

              <div className="node-detail-modal__field">
                <span>Status</span>
                <strong>{node.status}</strong>
              </div>

              <label className="node-detail-modal__field">
                <span>Max Concurrent</span>
                {editMode ? (
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={10}
                    value={maxConcurrent}
                    onChange={(event) => setMaxConcurrent(Number(event.target.value))}
                    disabled={isSaving}
                  />
                ) : (
                  <strong>{node.maxConcurrent}</strong>
                )}
              </label>

              {node.type === "remote" && (
                <>
                  <label className="node-detail-modal__field node-detail-modal__field--full">
                    <span>URL</span>
                    {editMode ? (
                      <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} disabled={isSaving} />
                    ) : (
                      <strong>{node.url ?? "—"}</strong>
                    )}
                  </label>

                  <label className="node-detail-modal__field node-detail-modal__field--full">
                    <span>API Key</span>
                    {editMode ? (
                      <input
                        className="input"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder="Leave blank to keep unchanged"
                        disabled={isSaving}
                      />
                    ) : (
                      <strong>{node.apiKey ? "••••••••" : "Not configured"}</strong>
                    )}
                  </label>
                </>
              )}

              <div className="node-detail-modal__field">
                <span>Created</span>
                <strong>{formatTimestamp(node.createdAt)}</strong>
              </div>

              <div className="node-detail-modal__field">
                <span>Updated</span>
                <strong>{formatTimestamp(node.updatedAt)}</strong>
              </div>
            </div>

            {editMode && (
              <div className="node-detail-modal__edit-actions">
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={isSaving}>
                  <Save size={14} />
                  {isSaving ? "Saving..." : "Save"}
                </button>
                <button className="btn btn-sm" onClick={handleCancelEdit} disabled={isSaving}>
                  <X size={14} />
                  Cancel
                </button>
              </div>
            )}
          </section>

          <section className="node-detail-modal__section">
            <h4>{node.type === "local" ? "Projects" : "Assigned Projects"} ({assignedProjects.length})</h4>
            {assignedProjects.length === 0 ? (
              <p className="node-detail-modal__empty">
                {node.type === "local"
                  ? "No projects are running on this node."
                  : "No projects are assigned to this node."}
              </p>
            ) : (
              <ul className="node-detail-modal__project-list">
                {assignedProjects.map((project) => (
                  <li key={project.id} className="node-detail-modal__project-item">
                    <span>{project.name}</span>
                    <code>{project.id}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="node-detail-modal__section">
            <h4>Health</h4>
            <div className="node-detail-modal__health-row">
              <span>Status: <strong>{node.status}</strong></span>
              <span>Last check: <strong>{formatTimestamp(node.updatedAt)}</strong></span>
            </div>
          </section>

          {dockerConfigDraft && (
            <section className="node-detail-modal__section node-detail-modal__docker-config">
              <button
                className="btn btn-sm node-detail-modal__docker-toggle"
                onClick={() => setDockerConfigExpanded((prev) => !prev)}
                aria-expanded={dockerConfigExpanded}
              >
                <ChevronDown size={14} className={dockerConfigExpanded ? "node-detail-modal__docker-toggle-icon--expanded" : ""} />
                Docker Configuration
              </button>

              {dockerConfigExpanded && (
                <div className="node-detail-modal__docker-config-content">
                  <div className="node-detail-modal__grid">
                    <label className="node-detail-modal__field node-detail-modal__field--full">
                      <span>Image</span>
                      <input className="input" value={dockerConfigDraft.image} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, image: event.target.value })} />
                    </label>
                  </div>

                  <details>
                    <summary>Volume Mounts</summary>
                    <div className="node-detail-modal__docker-list">
                      {dockerConfigDraft.volumeMounts.map((mount, index) => (
                        <div key={`${mount.hostPath}-${mount.containerPath}-${index}`} className="node-detail-modal__docker-row">
                          <input className="input" value={mount.hostPath} placeholder="Host path" onChange={(event) => {
                            const next = [...dockerConfigDraft.volumeMounts];
                            next[index] = { ...next[index], hostPath: event.target.value };
                            setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: next });
                          }} />
                          <input className="input" value={mount.containerPath} placeholder="Container path" onChange={(event) => {
                            const next = [...dockerConfigDraft.volumeMounts];
                            next[index] = { ...next[index], containerPath: event.target.value };
                            setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: next });
                          }} />
                          <select className="input" value={mount.mode ?? "rw"} onChange={(event) => {
                            const next = [...dockerConfigDraft.volumeMounts];
                            next[index] = { ...next[index], mode: event.target.value as "rw" | "ro" };
                            setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: next });
                          }}>
                            <option value="rw">rw</option>
                            <option value="ro">ro</option>
                          </select>
                          <select className="input" value={mount.type ?? "volume"} onChange={(event) => {
                            const next = [...dockerConfigDraft.volumeMounts];
                            next[index] = { ...next[index], type: event.target.value as "volume" | "bind" };
                            setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: next });
                          }}>
                            <option value="volume">volume</option>
                            <option value="bind">bind</option>
                          </select>
                          <button className="btn btn-sm" onClick={() => setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: dockerConfigDraft.volumeMounts.filter((_, i) => i !== index) })}>Remove</button>
                        </div>
                      ))}
                      <button className="btn btn-sm" onClick={() => setDockerConfigDraft({ ...dockerConfigDraft, volumeMounts: [...dockerConfigDraft.volumeMounts, { hostPath: "", containerPath: "", mode: "rw", type: "volume" }] })}>Add Mount</button>
                    </div>
                  </details>

                  <details>
                    <summary>Environment Variables</summary>
                    <div className="node-detail-modal__docker-list">
                      {Object.entries(dockerConfigDraft.environment).map(([key, value]) => {
                        const masked = SENSITIVE_ENV_KEY_PATTERN.test(key) && !dockerEnvReveal[key];
                        return (
                          <div key={key} className="node-detail-modal__docker-row">
                            <input className="input" value={key} onChange={(event) => {
                              const next = { ...dockerConfigDraft.environment };
                              delete next[key];
                              next[event.target.value] = value;
                              setDockerConfigDraft({ ...dockerConfigDraft, environment: next });
                            }} />
                            <input className="input" value={masked ? "***" : value} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, environment: { ...dockerConfigDraft.environment, [key]: event.target.value } })} />
                            <button className="btn btn-sm" onClick={() => setDockerEnvReveal((prev) => ({ ...prev, [key]: !prev[key] }))}>
                              {dockerEnvReveal[key] ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button className="btn btn-sm" onClick={() => {
                              const next = { ...dockerConfigDraft.environment };
                              delete next[key];
                              setDockerConfigDraft({ ...dockerConfigDraft, environment: next });
                            }}>Remove</button>
                          </div>
                        );
                      })}
                      <button className="btn btn-sm" onClick={() => {
                        const nextKey = `NEW_VAR_${Object.keys(dockerConfigDraft.environment).length + 1}`;
                        setDockerConfigDraft({ ...dockerConfigDraft, environment: { ...dockerConfigDraft.environment, [nextKey]: "" } });
                      }}>Add Variable</button>
                    </div>
                  </details>

                  <details>
                    <summary>Resources</summary>
                    <div className="node-detail-modal__docker-stack">
                      <input className="input" type="number" placeholder="Memory bytes (2 GB = 2147483648)" value={dockerConfigDraft.resources?.memoryBytes ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, resources: { ...dockerConfigDraft.resources, memoryBytes: event.target.value ? Number(event.target.value) : undefined } })} />
                      <input className="input" type="number" placeholder="CPU count" value={dockerConfigDraft.resources?.cpuCount ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, resources: { ...dockerConfigDraft.resources, cpuCount: event.target.value ? Number(event.target.value) : undefined } })} />
                      <input className="input" type="number" placeholder="PIDs limit" value={dockerConfigDraft.resources?.pidsLimit ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, resources: { ...dockerConfigDraft.resources, pidsLimit: event.target.value ? Number(event.target.value) : undefined } })} />
                    </div>
                  </details>

                  <details>
                    <summary>Host Config</summary>
                    <div className="node-detail-modal__docker-stack">
                      <input className="input" placeholder="Context name" value={dockerConfigDraft.host?.contextName ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, contextName: event.target.value } })} />
                      <input className="input" placeholder="Docker host URL" value={dockerConfigDraft.host?.dockerHost ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, dockerHost: event.target.value } })} />
                      <input className="input" placeholder="TLS CA cert path" value={dockerConfigDraft.host?.tlsCaCert ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, tlsCaCert: event.target.value } })} />
                      <input className="input" placeholder="TLS cert path" value={dockerConfigDraft.host?.tlsCert ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, tlsCert: event.target.value } })} />
                      <input className="input" placeholder="TLS key path" value={dockerConfigDraft.host?.tlsKey ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, tlsKey: event.target.value } })} />
                      <label className="node-detail-modal__checkbox"><input type="checkbox" checked={dockerConfigDraft.host?.tlsVerify ?? true} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, host: { ...dockerConfigDraft.host, tlsVerify: event.target.checked } })} />TLS verify</label>
                    </div>
                  </details>

                  <details>
                    <summary>Extra CLIs</summary>
                    <div className="node-detail-modal__docker-list">
                      {(dockerConfigDraft.extraClis ?? []).map((cli, index) => (
                        <div key={`${cli}-${index}`} className="node-detail-modal__docker-row">
                          <input className="input" value={cli} onChange={(event) => {
                            const next = [...(dockerConfigDraft.extraClis ?? [])];
                            next[index] = event.target.value;
                            setDockerConfigDraft({ ...dockerConfigDraft, extraClis: next });
                          }} />
                          <button className="btn btn-sm" onClick={() => setDockerConfigDraft({ ...dockerConfigDraft, extraClis: (dockerConfigDraft.extraClis ?? []).filter((_, i) => i !== index) })}>Remove</button>
                        </div>
                      ))}
                      <button className="btn btn-sm" onClick={() => setDockerConfigDraft({ ...dockerConfigDraft, extraClis: [...(dockerConfigDraft.extraClis ?? []), ""] })}>Add CLI</button>
                    </div>
                  </details>

                  <details>
                    <summary>Persistence</summary>
                    <div className="node-detail-modal__docker-stack">
                      <input className="input" placeholder="Volume name" value={dockerConfigDraft.persistence?.volumeName ?? ""} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, persistence: { ...dockerConfigDraft.persistence, volumeName: event.target.value } })} />
                      <label className="node-detail-modal__checkbox"><input type="checkbox" checked={dockerConfigDraft.persistence?.retainOnDelete ?? false} onChange={(event) => setDockerConfigDraft({ ...dockerConfigDraft, persistence: { ...dockerConfigDraft.persistence, retainOnDelete: event.target.checked } })} />Retain on delete</label>
                    </div>
                  </details>

                  <div className="node-detail-modal__docker-meta">
                    <span>Config v{dockerConfigDraft.configVersion} • Updated {formatRelativeTime(dockerConfigDraft.lastUpdated ?? node.updatedAt)}</span>
                    {dockerConfigNeedsRecreate && <span className="node-detail-modal__docker-recreate">Needs Recreate</span>}
                  </div>

                  <button className="btn btn-primary btn-sm" onClick={() => void handleDockerConfigSave()} disabled={dockerConfigSaving}>
                    <Save size={14} />
                    {dockerConfigSaving ? "Saving..." : "Save Docker Config"}
                  </button>
                </div>
              )}
            </section>
          )}

          {managedDockerNode && (
            <section className="node-detail-modal__section docker-management">
              <h4>Docker Management</h4>

              <div className="docker-management__status-card">
                <div className="docker-management__status-row">
                  <span className={`docker-management__status-dot docker-management__status-dot--${dockerStatusTone}`} aria-hidden />
                  <strong>{getDockerStatusLabel(effectiveDockerStatus)}</strong>
                  {(effectiveDockerStatus === "creating" || effectiveDockerStatus === "recreating" || effectiveDockerStatus === "restarting") && (
                    <RotateCcw size={14} className="spin" aria-hidden />
                  )}
                </div>
                <div className="docker-management__status-meta">
                  {effectiveDockerStatus === "running" && <span>Uptime: {formatDockerUptime(liveContainerStatus?.startedAt)}</span>}
                  {effectiveDockerStatus !== "running" && liveContainerStatus?.exitCode !== undefined && (
                    <span>Exit code: {liveContainerStatus.exitCode}</span>
                  )}
                  {(liveContainerStatus?.error || managedDockerNode.errorMessage) && (
                    <span>{liveContainerStatus?.error ?? managedDockerNode.errorMessage}</span>
                  )}
                </div>
                <button className="btn btn-sm" onClick={() => void handleRefreshContainerStatus()} disabled={!onFetchContainerStatus || isRefreshingContainerStatus}>
                  {isRefreshingContainerStatus ? "Refreshing..." : "Refresh Status"}
                </button>
              </div>

              <div className="node-detail-modal__grid docker-management__info-grid">
                <div className="node-detail-modal__field"><span>Image</span><strong><code>{managedDockerNode.imageName}:{managedDockerNode.imageTag}</code></strong></div>
                <div className="node-detail-modal__field"><span>Container ID</span><strong><code>{managedDockerNode.containerId ? managedDockerNode.containerId.slice(0, 12) : "—"}</code></strong></div>
                <div className="node-detail-modal__field"><span>Host</span><strong>{dockerHost}</strong></div>
                <div className="node-detail-modal__field"><span>Persistent Storage</span><strong>{managedDockerNode.persistentStorage ? "Yes" : "No"}</strong></div>
                <div className="node-detail-modal__field"><span>Port</span><strong>{parsePortFromReachableUrl(managedDockerNode.reachableUrl)}</strong></div>
                <div className="node-detail-modal__field"><span>Resource Sizing</span><strong>{dockerResourceSizing}</strong></div>
              </div>

              <div className="docker-management__actions">
                <button className="btn btn-sm" disabled title="Available after FN-3113"><Play size={14} />Start</button>
                <button className="btn btn-sm" disabled title="Available after FN-3113"><Square size={14} />Stop</button>
                <button className="btn btn-sm" disabled title="Available after FN-3113"><RotateCcw size={14} />Restart</button>
                <button className="btn btn-sm" onClick={() => void handleFetchLogs()} disabled={!onFetchLogs}><FileText size={14} />View Logs</button>
              </div>

              {logsOpen && (
                <div className="docker-management__log-viewer">
                  <div className="docker-management__log-viewer-header">
                    <strong>Container Logs</strong>
                    <button className="btn-icon" onClick={() => setLogsOpen(false)} aria-label="Close logs"><X size={14} /></button>
                  </div>
                  {logsLoading ? (
                    <p>Fetching logs...</p>
                  ) : (
                    <pre>{logs.trim() || "No logs available"}</pre>
                  )}
                </div>
              )}

              <details>
                <summary>Environment Variables</summary>
                <dl className="docker-management__env-list">
                  {Object.entries(managedDockerNode.envVars).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{maskEnvValue(key, value)}</dd>
                    </div>
                  ))}
                </dl>
              </details>

              <details>
                <summary>Volume Mounts</summary>
                <ul className="docker-management__mounts-list">
                  {managedDockerNode.volumeMounts.map((mount) => (
                    <li key={`${mount.hostPath}:${mount.containerPath}`}>
                      <span>{mount.hostPath} → {mount.containerPath}</span>
                      {mount.readOnly && <span className="node-card__type-badge">Read-only</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {node.type === "remote" && (
            <section className="node-detail-modal__section">
              <h4>Settings Sync</h4>

              {syncStatus && (
                <div className="node-detail-modal__sync-status">
                  <span
                    className={`node-detail-modal__sync-dot ${getSyncStateDotClass(syncStatus.syncState)}`}
                    aria-hidden
                  />
                  <span>
                    Last sync: <strong>{syncStatus.lastSyncAt ? formatRelativeTime(syncStatus.lastSyncAt) : "Never synced"}</strong>
                  </span>
                  {syncStatus.diffCount > 0 && (
                    <span className="node-detail-modal__sync-diff">
                      Differences: <strong>{syncStatus.diffCount}</strong>
                    </span>
                  )}
                </div>
              )}

              <div className="node-detail-modal__sync-actions">
                <button className="btn btn-sm" onClick={handlePushSettings} disabled={isPushing || !onPushSettings}>
                  <Upload size={14} />
                  {isPushing ? "Pushing..." : "Push Settings"}
                </button>

                <button className="btn btn-sm" onClick={handlePullSettings} disabled={isPulling || !onPullSettings}>
                  <Download size={14} />
                  {isPulling ? "Pulling..." : "Pull Settings"}
                </button>

                <button className="btn btn-sm" onClick={handleSyncAuth} disabled={isSyncingAuth || !onSyncAuth}>
                  <Shield size={14} />
                  {isSyncingAuth ? "Syncing..." : "Sync Auth"}
                </button>
              </div>

              {syncError && (
                <div className="node-detail-modal__sync-error">
                  <span>{syncError}</span>
                  <button className="node-detail-modal__sync-error-dismiss" onClick={handleDismissSyncError} aria-label="Dismiss error">
                    <X size={14} />
                  </button>
                </div>
              )}
            </section>
          )}

          {node.type === "remote" && (
            <section className="node-detail-modal__section">
              <h4>Sync History</h4>
              <SettingsSyncLog nodeId={node.id} entries={syncHistory} singleNode={true} />
            </section>
          )}
        </div>

        <div className="modal-actions node-detail-modal__actions">
          <button className="btn btn-sm" onClick={handleHealthCheck}>
            <Activity size={14} />
            Health Check
          </button>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>

      {node.type === "remote" && (
        <SettingsSyncConflictModal
          isOpen={showConflictModal}
          onClose={() => setShowConflictModal(false)}
          onResolve={onResolveConflicts ?? (async () => {})}
          conflicts={conflicts}
          localNodeName="Local"
          remoteNodeName={node.name}
          addToast={addToast}
        />
      )}
    </div>
  );
}

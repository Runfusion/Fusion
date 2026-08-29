import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { NodeProjectMappingInput, ProjectInfo, RemoteNodeDiscoveredProject, RemoteNodeProjectDiscoveryResult } from "../api";
import { validateProjectPath } from "../utils/projectDetection";
import type { ToastType } from "../hooks/useToast";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import "./AddNodeModal.css";

import { FloatingWindow } from "./FloatingWindow";
export interface AddNodeInput {
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  maxConcurrent: number;
  projectMappings: NodeProjectMappingInput[];
  apiKeyMode?: "auto-generate" | "provide";
  extraClis?: Array<"claude-cli" | "droid-cli">;
  persistentStorage?: boolean;
  resourceSizing?: {
    cpus?: number;
    memoryMB?: number;
  };
  dockerAdvanced?: {
    host?: string;
    context?: string;
    tlsVerify?: boolean;
    envOverrides?: Record<string, string>;
    volumeMounts?: Array<{ hostPath: string; containerPath: string; mode: "ro" | "rw" }>;
  };
}

interface AddNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: AddNodeInput) => Promise<void>;
  onDiscoverRemoteProjects: (input: { url: string; apiKey?: string }) => Promise<RemoteNodeProjectDiscoveryResult>;
  addToast: (message: string, type?: ToastType) => void;
  projects: ProjectInfo[];
}

interface FormErrors {
  name?: string;
  url?: string;
  maxConcurrent?: string;
  projectMappings: Record<string, string>;
}

const MAX_CONCURRENT_MIN = 1;
const MAX_CONCURRENT_MAX = 10;

function validateInput(input: AddNodeInput, t: TFunction<"app">): FormErrors {
  const errors: FormErrors = { projectMappings: {} };

  if (!input.name.trim()) {
    errors.name = t("nodes.nameRequired", "Name is required");
  }

  if (input.type === "remote" && !input.url?.trim()) {
    errors.url = t("nodes.urlRequired", "URL is required for remote nodes");
  }

  if (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent < MAX_CONCURRENT_MIN || input.maxConcurrent > MAX_CONCURRENT_MAX) {
    errors.maxConcurrent = t("nodes.concurrencyRange", "Concurrency must be between {{min}} and {{max}}", { min: MAX_CONCURRENT_MIN, max: MAX_CONCURRENT_MAX });
  }

  for (const mapping of input.projectMappings) {
    const validation = validateProjectPath(mapping.path);
    if (!validation.valid) {
      errors.projectMappings[mapping.projectId] = validation.error ?? t("nodes.pathInvalid", "Path is invalid");
    }
  }

  return errors;
}

type DiscoveryState = "idle" | "loading" | "success" | "error";

export function AddNodeModal({ isOpen, onClose, onSubmit, onDiscoverRemoteProjects, addToast, projects }: AddNodeModalProps) {
  const { t } = useTranslation("app");
  useMobileScrollLock(isOpen);
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "remote">("local");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [apiKeyMode, setApiKeyMode] = useState<"auto-generate" | "provide">("auto-generate");
  const [selectedProjectPaths, setSelectedProjectPaths] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FormErrors>({ projectMappings: {} });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>("idle");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveredProjects, setDiscoveredProjects] = useState<RemoteNodeDiscoveredProject[]>([]);

  const resetForm = useCallback(() => {
    setName("");
    setType("local");
    setUrl("");
    setApiKey("");
    setMaxConcurrent(2);
    setApiKeyMode("auto-generate");
    setSelectedProjectPaths({});
    setErrors({ projectMappings: {} });
    setIsSubmitting(false);
    setDiscoveryState("idle");
    setDiscoveryError(null);
    setDiscoveredProjects([]);
  }, []);
  const closeModal = useCallback(() => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  }, [isSubmitting, onClose, resetForm]);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeModal, isOpen, resetForm]);

  const input = useMemo<AddNodeInput>(() => ({
    name: name.trim(),
    type,
    url: type === "remote" ? url.trim() || undefined : undefined,
    apiKey: type === "remote" && apiKeyMode === "provide" ? apiKey || undefined : undefined,
    maxConcurrent,
    apiKeyMode,
    projectMappings: Object.entries(selectedProjectPaths).map(([projectId, path]) => ({ projectId, path: path.trim() })),
  }), [apiKey, apiKeyMode, maxConcurrent, name, selectedProjectPaths, type, url]);

  const handleDiscoverProjects = useCallback(async () => {
    if (isSubmitting || discoveryState === "loading") return;

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setErrors((current) => ({ ...current, url: t("nodes.urlRequired", "URL is required for remote nodes") }));
      return;
    }

    setDiscoveryState("loading");
    setDiscoveryError(null);

    try {
      const response = await onDiscoverRemoteProjects({
        url: trimmedUrl,
        apiKey: apiKeyMode === "provide" && apiKey.trim().length > 0 ? apiKey : undefined,
      });
      setDiscoveredProjects(response.projects);
      setDiscoveryState("success");

      setSelectedProjectPaths((current) => {
        if (Object.keys(current).length === 0) {
          return current;
        }
        const next = { ...current };
        for (const project of projects) {
          if (!(project.id in next)) continue;
          const matches = response.projects.filter((remoteProject) => remoteProject.name === project.name);
          if (matches.length === 1) {
            next[project.id] = matches[0].path;
          }
        }
        return next;
      });
    } catch (error) {
      setDiscoveryState("error");
      setDiscoveredProjects([]);
      setDiscoveryError(error instanceof Error ? error.message : t("nodes.discoveryFailed", "Failed to discover remote projects"));
    }
  }, [apiKey, apiKeyMode, discoveryState, isSubmitting, onDiscoverRemoteProjects, projects, t, url]);

  useEffect(() => {
    if (type !== "remote") {
      setDiscoveryState("idle");
      setDiscoveryError(null);
      setDiscoveredProjects([]);
      return;
    }

    setDiscoveryState("idle");
    setDiscoveryError(null);
    setDiscoveredProjects([]);
  }, [apiKey, apiKeyMode, type, url]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const validationErrors = validateInput(input, t);
    setErrors(validationErrors);

    if (
      validationErrors.name
      || validationErrors.url
      || validationErrors.maxConcurrent
      || Object.keys(validationErrors.projectMappings).length > 0
    ) {
      return;
    }

    if (input.type === "remote" && discoveryState !== "success") {
      setDiscoveryError(t("nodes.discoverBeforeAdding", "Discover remote projects before adding this node."));
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit(input);
      addToast(t("nodes.registered", "Node \"{{name}}\" registered", { name: input.name }), "success");
      closeModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("nodes.registerFailed", "Failed to register node");
      addToast(message, "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [addToast, closeModal, discoveryState, input, isSubmitting, onSubmit, t]);

  const toggleProjectSelection = (project: ProjectInfo) => {
    setSelectedProjectPaths((current) => {
      if (project.id in current) {
        const { [project.id]: _removed, ...remaining } = current;
        return remaining;
      }

      if (type === "remote" && discoveryState === "success") {
        const matches = discoveredProjects.filter((remoteProject) => remoteProject.name === project.name);
        if (matches.length === 1) {
          return { ...current, [project.id]: matches[0].path };
        }
        return { ...current, [project.id]: "" };
      }

      return { ...current, [project.id]: project.path };
    });
  };

  const updateProjectPath = (projectId: string, path: string) => {
    setSelectedProjectPaths((current) => ({ ...current, [projectId]: path }));
  };

  if (!isOpen) return null;

  return (
    /* FNXC:ModalTouchGeometry 2026-07-26-13:15: Shared FloatingWindow owns this modal's touch drag, resize, clamping, and persistence while phone and short viewports retain their sheet behavior. */
    <FloatingWindow windowKey="add-node" title={t("nodes.addNode", "Add Node")} ariaLabel={t("nodes.addNode", "Add Node")} onClose={closeModal} hideHeader dragHandleSelector=".modal-header" className="floating-window--add-node" defaultSize={{ width: 720, height: 560 }} minSize={{ width: 360, height: 280 }} persistGeometryKey="floating-window:add-node" suspendGeometryPersistenceOnMobile suspendGeometryPersistenceOnShortViewport closeOnOutsidePointerDown>
      <div className="modal modal-md add-node-modal">
        <div className="modal-header">
          <h3>{t("nodes.addNode", "Add Node")}</h3>
          <button className="modal-close" onClick={closeModal} disabled={isSubmitting} aria-label={t("nodes.closeNodeModal", "Close add node modal")}>
            &times;
          </button>
        </div>

        <div className="modal-body add-node-modal__body">
          <p className="add-node-modal__description">{t("nodes.description", "Register an existing Fusion node by providing its connection details and concurrency settings.")}</p>

          <label className="add-node-modal__field">
            <span>{t("nodes.name", "Name")}</span>
            <input
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("nodes.namePlaceholder", "Build Machine")}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.name)}
              autoFocus
            />
            {errors.name && <span className="form-error add-node-modal__error">{errors.name}</span>}
          </label>

          <div className="add-node-modal__type-toggle">
            <button
              type="button"
              className={`add-node-modal__type-btn ${type === "local" ? "active" : ""}`}
              data-type="local"
              onClick={() => setType("local")}
              disabled={isSubmitting}
              aria-pressed={type === "local"}
            >
              {t("nodes.local", "Local")}
            </button>
            <button
              type="button"
              className={`add-node-modal__type-btn ${type === "remote" ? "active" : ""}`}
              data-type="remote"
              onClick={() => setType("remote")}
              disabled={isSubmitting}
              aria-pressed={type === "remote"}
            >
              {t("nodes.remote", "Remote")}
            </button>
          </div>

          {type === "remote" && (
            <div className="add-node-modal__remote-fields" data-testid="remote-fields-container" data-visible>
              <label className="add-node-modal__field">
                <span>{t("nodes.reachableUrl", "Reachable URL / Hostname")}</span>
                <input
                  className="input"
                  type="text"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://node.example.com"
                  disabled={isSubmitting}
                  aria-invalid={Boolean(errors.url)}
                />
                {errors.url && <span className="form-error add-node-modal__error">{errors.url}</span>}
              </label>

              <label className="add-node-modal__field">
                <span>{t("nodes.apiKeyMode", "API Key Mode")}</span>
                <select
                  className="select"
                  value={apiKeyMode}
                  onChange={(event) => setApiKeyMode(event.target.value as "auto-generate" | "provide")}
                  disabled={isSubmitting}
                >
                  <option value="auto-generate">{t("nodes.autoGenerate", "Auto-generate")}</option>
                  <option value="provide">{t("nodes.provideManually", "Provide key manually")}</option>
                </select>
              </label>

              {apiKeyMode === "provide" && (
                <label className="add-node-modal__field">
                  <span>{t("nodes.apiKey", "API Key")}</span>
                  <input
                    className="input"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={t("nodes.apiKeyPlaceholder", "Enter node API key")}
                    disabled={isSubmitting}
                  />
                </label>
              )}

              <div className="add-node-modal__discovery-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void handleDiscoverProjects()}
                  disabled={isSubmitting || discoveryState === "loading"}
                >
                  {discoveryState === "loading" ? t("nodes.discovering", "Discovering...") : t("nodes.discoverRemoteProjects", "Discover Remote Projects")}
                </button>
                {discoveryState === "success" && (
                  <span className="add-node-modal__discovery-state" data-state="success">
                    {discoveredProjects.length > 0 ? t("nodes.discoveredCount", "Discovered {{count}} remote project{{plural}}", { count: discoveredProjects.length, plural: discoveredProjects.length === 1 ? "" : "s" }) : t("nodes.noProjectsDiscovered", "No projects discovered on remote node.")}
                  </span>
                )}
                {discoveryState === "error" && discoveryError && (
                  <span className="form-error add-node-modal__error">{discoveryError}</span>
                )}
                {discoveryState === "idle" && (
                  <span className="add-node-modal__hint">{t("nodes.discoverBeforeAdding", "Discover remote projects before adding this node.")}</span>
                )}
              </div>

              {discoveryState === "success" && discoveredProjects.length > 0 && (
                <div className="add-node-modal__discovered-list" aria-label={t("nodes.discoveredRemoteProjectsLabel", "Discovered remote projects")}>
                  {discoveredProjects.map((project) => (
                    <div key={`${project.id}-${project.path}`} className="card add-node-modal__discovered-card">
                      <div className="add-node-modal__discovered-row">
                        <strong>{project.name}</strong>
                        <span className="card-status-badge card-status-badge--in-review">{project.status}</span>
                      </div>
                      <div className="add-node-modal__hint">{project.path}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="add-node-modal__field">
            <span>{t("nodes.maxConcurrent", "Max Concurrent")}</span>
            <input
              className="input"
              type="number"
              min={MAX_CONCURRENT_MIN}
              max={MAX_CONCURRENT_MAX}
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.maxConcurrent)}
            />
            <span className="add-node-modal__hint">{t("nodes.maxConcurrentHint", "Max simultaneous task agents (1–10)")}</span>
            {errors.maxConcurrent && <span className="form-error add-node-modal__error">{errors.maxConcurrent}</span>}
          </label>

          <section className="add-node-modal__projects" aria-label={t("nodes.projectPathMappingsLabel", "Project path mappings")}>
            <h4 className="add-node-modal__projects-title">{t("nodes.attachProjects", "Attach Existing Projects")}</h4>
            <p className="add-node-modal__hint">{t("nodes.attachProjectsHint", "Select existing projects to run on this node and provide the node-specific absolute path for each one.")}</p>
            {projects.length === 0 ? (
              <p className="add-node-modal__hint">{t("nodes.noProjects", "No projects are currently registered.")}</p>
            ) : (
              <div className="add-node-modal__project-list">
                {projects.map((project) => {
                  const selected = project.id in selectedProjectPaths;
                  const error = errors.projectMappings[project.id];
                  return (
                    <div key={project.id} className="card add-node-modal__project-card">
                      <label className="checkbox-label add-node-modal__project-toggle">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleProjectSelection(project)}
                          disabled={isSubmitting}
                        />
                        <span>{project.name}</span>
                      </label>
                      {selected && (
                        <label className="add-node-modal__field">
                          <span>{t("nodes.pathOnNode", "Path on this node")}</span>
                          {type === "remote" && discoveryState === "success" && (
                            <span className="add-node-modal__hint">
                              {(() => {
                                const matches = discoveredProjects.filter((remoteProject) => remoteProject.name === project.name);
                                if (matches.length === 1) {
                                  return t("nodes.pathDiscovered", "Remote-authoritative path discovered: {{path}}", { path: matches[0].path });
                                }
                                if (matches.length > 1) {
                                  return t("nodes.multipleMatches", "Multiple remote projects matched this name. Enter the correct path manually.");
                                }
                                return t("nodes.noMatch", "No exact remote name match. Enter this path manually.");
                              })()}
                            </span>
                          )}
                          <input
                            className="input"
                            type="text"
                            value={selectedProjectPaths[project.id] ?? ""}
                            onChange={(event) => updateProjectPath(project.id, event.target.value)}
                            disabled={isSubmitting}
                            placeholder="/absolute/path/to/project"
                            aria-invalid={Boolean(error)}
                          />
                          {error && <span className="form-error add-node-modal__error">{error}</span>}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={closeModal} disabled={isSubmitting}>{t("common.cancel", "Cancel")}</button>
          <button className="btn btn-primary btn-sm" data-testid="add-node-submit" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? t("nodes.adding", "Adding...") : t("nodes.addNode", "Add Node")}
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}

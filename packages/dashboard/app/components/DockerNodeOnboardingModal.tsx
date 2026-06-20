import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DockerHostConfig, ManagedDockerNodeInput } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { DockerTargetSelector } from "./DockerTargetSelector";
import "./DockerNodeOnboardingModal.css";

interface DockerNodeOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: ManagedDockerNodeInput) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
}

interface FormErrors {
  name?: string;
  reachableUrl?: string;
  memoryMB?: string;
  cpus?: string;
}

interface KeyValueRow {
  key: string;
  value: string;
}

interface MountRow {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

const DEFAULT_URL = "http://localhost:4040";
const DOCKER_MOUNT_MODE_LABELS = {
  readWrite: "rw",
  readOnly: "ro",
} as const;

export function DockerNodeOnboardingModal({ isOpen, onClose, onSubmit, addToast: _addToast }: DockerNodeOnboardingModalProps) {
  const { t } = useTranslation("app");
  const [name, setName] = useState("");
  const [hostConfig, setHostConfig] = useState<DockerHostConfig>({});
  const [reachableUrl, setReachableUrl] = useState(DEFAULT_URL);
  const [apiKeyMode, setApiKeyMode] = useState<"auto" | "manual">("auto");
  const [apiKey, setApiKey] = useState("");
  const [includeClaudeCli, setIncludeClaudeCli] = useState(false);
  const [includeDroidCli, setIncludeDroidCli] = useState(false);
  const [persistentStorage, setPersistentStorage] = useState(true);
  const [memoryMB, setMemoryMB] = useState(4096);
  const [cpus, setCpus] = useState(2);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imageName, setImageName] = useState("runfusion/fusion");
  const [imageTag, setImageTag] = useState("latest");

  const [envRows, setEnvRows] = useState<KeyValueRow[]>([]);
  const [mountRows, setMountRows] = useState<MountRow[]>([]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setName("");
    setHostConfig({});
    setReachableUrl(DEFAULT_URL);
    setApiKeyMode("auto");
    setApiKey("");
    setIncludeClaudeCli(false);
    setIncludeDroidCli(false);
    setPersistentStorage(true);
    setMemoryMB(4096);
    setCpus(2);
    setShowAdvanced(false);
    setImageName("runfusion/fusion");
    setImageTag("latest");

    setEnvRows([]);
    setMountRows([]);
    setErrors({});
    setSubmitting(false);
  }, []);

  const closeModal = useCallback(() => {
    if (submitting) return;
    resetForm();
    onClose();
  }, [onClose, resetForm, submitting]);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeModal, isOpen, resetForm]);

  const input = useMemo<ManagedDockerNodeInput>(() => ({
    nodeId: null,
    name: name.trim(),
    imageName: imageName.trim() || "runfusion/fusion",
    imageTag: imageTag.trim() || "latest",
    hostConfig: {
      context: hostConfig.context?.trim() || undefined,
      host: hostConfig.host?.trim() || undefined,
      tlsVerify: hostConfig.tlsVerify,
      tlsCaPath: hostConfig.tlsCaPath?.trim() || undefined,
      tlsCertPath: hostConfig.tlsCertPath?.trim() || undefined,
      tlsKeyPath: hostConfig.tlsKeyPath?.trim() || undefined,
    },
    envVars: Object.fromEntries(
      envRows
        .map((row) => [row.key.trim(), row.value] as const)
        .filter(([key]) => Boolean(key)),
    ),
    volumeMounts: mountRows
      .map((mount) => ({
        hostPath: mount.hostPath.trim(),
        containerPath: mount.containerPath.trim(),
        mode: mount.mode,
      }))
      .filter((mount) => mount.hostPath && mount.containerPath),
    resourceSizing: { memoryMB, cpus },
    extraClis: [includeClaudeCli ? "claude-cli" : null, includeDroidCli ? "droid-cli" : null].filter(Boolean) as Array<
      "claude-cli" | "droid-cli"
    >,
    persistentStorage,
    reachableUrl: reachableUrl.trim() || null,
    apiKey: apiKeyMode === "manual" ? apiKey.trim() || null : null,
  }), [
    apiKey,
    apiKeyMode,
    cpus,
    hostConfig,
    envRows,
    imageName,
    imageTag,
    includeClaudeCli,
    includeDroidCli,
    memoryMB,
    mountRows,
    name,
    persistentStorage,
    reachableUrl,
  ]);

  const addEnvRow = useCallback(() => {
    setEnvRows((current) => [...current, { key: "", value: "" }]);
  }, []);

  const updateEnvRow = useCallback((index: number, next: KeyValueRow) => {
    setEnvRows((current) => current.map((row, rowIndex) => (rowIndex === index ? next : row)));
  }, []);

  const removeEnvRow = useCallback((index: number) => {
    setEnvRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }, []);

  const addMountRow = useCallback(() => {
    setMountRows((current) => [...current, { hostPath: "", containerPath: "", mode: "rw" }]);
  }, []);

  const updateMountRow = useCallback((index: number, next: MountRow) => {
    setMountRows((current) => current.map((row, rowIndex) => (rowIndex === index ? next : row)));
  }, []);

  const removeMountRow = useCallback((index: number) => {
    setMountRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;

    const nextErrors: FormErrors = {};
    if (!input.name || input.name.length > 64) {
      nextErrors.name = t("docker.errors.nameRequired", "Name is required and must be 64 characters or fewer");
    }
    if (!input.reachableUrl) {
      nextErrors.reachableUrl = t("docker.errors.urlRequired", "URL is required");
    }
    if (memoryMB < 512) {
      nextErrors.memoryMB = t("docker.errors.memoryMinimum", "Memory must be at least 512 MB");
    }
    if (cpus < 0.5) {
      nextErrors.cpus = t("docker.errors.cpusMinimum", "CPUs must be at least 0.5");
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(input);
      closeModal();
    } catch {
      // Error toast is handled by parent submit handler.
    } finally {
      setSubmitting(false);
    }
  }, [closeModal, cpus, input, memoryMB, onSubmit, submitting, t]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={closeModal}>
      <div
        className="modal docker-onboarding"
        role="dialog"
        aria-modal="true"
        aria-label={t("docker.ariaLabels.modal", "Docker node onboarding")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t("docker.titles.provisionNode", "Provision Docker Node")}</h3>
          <button className="modal-close" onClick={closeModal} disabled={submitting} aria-label={t("docker.ariaLabels.closeModal", "Close onboarding modal")}>
            &times;
          </button>
        </div>

        <div className="modal-body docker-onboarding__body">
          <section className="docker-onboarding__section">
            <h4 className="docker-onboarding__section-title">{t("docker.sections.requiredSettings", "Required Settings")}</h4>

            <label className="docker-onboarding__field">
              <span>{t("docker.labels.nodeName", "Node Name")}</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={submitting}
                placeholder={t("docker.placeholders.nodeName", "my-docker-node")}
                autoFocus
              />
            </label>
            {errors.name && <div className="form-error">{errors.name}</div>}

            <DockerTargetSelector value={hostConfig} onChange={setHostConfig} />

            <label className="docker-onboarding__field">
              <span>{t("docker.labels.reachableUrl", "Reachable URL")}</span>
              <input
                className="input"
                value={reachableUrl}
                onChange={(event) => setReachableUrl(event.target.value)}
                disabled={submitting}
                placeholder={DEFAULT_URL}
              />
            </label>
            {errors.reachableUrl && <div className="form-error">{errors.reachableUrl}</div>}


            <div className="docker-onboarding__radio-group">
              <label className="checkbox-label">
                <input
                  type="radio"
                  checked={apiKeyMode === "auto"}
                  onChange={() => setApiKeyMode("auto")}
                  disabled={submitting}
                />
                {t("docker.options.autoGenerate", "Auto-generate")}
              </label>
              <label className="checkbox-label">
                <input
                  type="radio"
                  checked={apiKeyMode === "manual"}
                  onChange={() => setApiKeyMode("manual")}
                  disabled={submitting}
                />
                {t("docker.options.provideManually", "Provide manually")}
              </label>
            </div>

            {apiKeyMode === "manual" && (
              <label className="docker-onboarding__field">
                <span>{t("docker.labels.apiKey", "API Key")}</span>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={submitting}
                  placeholder={t("docker.placeholders.apiKey", "Enter API key")}
                />
              </label>
            )}

            <div className="docker-onboarding__checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includeClaudeCli}
                  onChange={(event) => setIncludeClaudeCli(event.target.checked)}
                  disabled={submitting}
                />
                {t("docker.options.claudeCli", "Claude CLI")}
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={includeDroidCli}
                  onChange={(event) => setIncludeDroidCli(event.target.checked)}
                  disabled={submitting}
                />
                {t("docker.options.droidCli", "Droid CLI")}
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={persistentStorage}
                  onChange={(event) => setPersistentStorage(event.target.checked)}
                  disabled={submitting}
                />
                {t("docker.options.persistentStorage", "Keep data across container recreations")}
              </label>
            </div>

            <div className="docker-onboarding__inline-fields">
              <label className="docker-onboarding__field">
                <span>{t("docker.labels.memory", "Memory (MB)")}</span>
                <input
                  className="input"
                  type="number"
                  min={512}
                  value={memoryMB}
                  onChange={(event) => setMemoryMB(Number(event.target.value))}
                  disabled={submitting}
                />
              </label>
              <label className="docker-onboarding__field">
                <span>{t("docker.labels.cpus", "CPUs")}</span>
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={cpus}
                  onChange={(event) => setCpus(Number(event.target.value))}
                  disabled={submitting}
                />
              </label>
            </div>
            {errors.memoryMB && <div className="form-error">{errors.memoryMB}</div>}
            {errors.cpus && <div className="form-error">{errors.cpus}</div>}
          </section>

          <section className="docker-onboarding__section">
            <button
              type="button"
              className={`docker-onboarding__advanced-toggle ${showAdvanced ? "is-expanded" : ""}`}
              onClick={() => setShowAdvanced((value) => !value)}
              disabled={submitting}
            >
              <span>{t("docker.sections.advanced", "Advanced")}</span>
              <ChevronDown />
            </button>

            <div className={`docker-onboarding__advanced-content ${showAdvanced ? "is-expanded" : ""}`}>
              <div>
                <div className="docker-onboarding__inline-fields">
                  <label className="docker-onboarding__field">
                    <span>{t("docker.labels.image", "Image")}</span>
                    <input
                      className="input"
                      value={imageName}
                      onChange={(event) => setImageName(event.target.value)}
                      disabled={submitting}
                      placeholder={t("docker.placeholders.image", "runfusion/fusion")}
                    />
                  </label>
                  <label className="docker-onboarding__field">
                    <span>{t("docker.labels.tag", "Tag")}</span>
                    <input
                      className="input"
                      value={imageTag}
                      onChange={(event) => setImageTag(event.target.value)}
                      disabled={submitting}
                      placeholder={t("docker.placeholders.tag", "latest")}
                    />
                  </label>
                </div>


                <div className="docker-onboarding__kv-list">
                  <h5>{t("docker.sections.environmentVariables", "Environment Variables")}</h5>
                  {envRows.map((row, index) => (
                    <div key={`env-${index}`} className="docker-onboarding__kv-row docker-onboarding__kv-row--env">
                      <input
                        className="input"
                        placeholder={t("docker.placeholders.envVarKey", "KEY")}
                        value={row.key}
                        disabled={submitting}
                        onChange={(event) =>
                          updateEnvRow(index, {
                            key: event.target.value,
                            value: row.value,
                          })
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("docker.placeholders.envVarValue", "Value")}
                        value={row.value}
                        disabled={submitting}
                        onChange={(event) =>
                          updateEnvRow(index, {
                            key: row.key,
                            value: event.target.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={t("docker.ariaLabels.removeVariable", "Remove environment variable")}
                        onClick={() => removeEnvRow(index)}
                        disabled={submitting}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm docker-onboarding__kv-add"
                    onClick={addEnvRow}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    {t("docker.actions.addVariable", "Add variable")}
                  </button>
                </div>

                <div className="docker-onboarding__kv-list">
                  <h5>{t("docker.sections.volumeMounts", "Volume Mounts")}</h5>
                  {mountRows.map((row, index) => (
                    <div key={`mount-${index}`} className="docker-onboarding__kv-row docker-onboarding__kv-row--mount">
                      <input
                        className="input"
                        placeholder={t("docker.placeholders.hostPath", "Host path")}
                        value={row.hostPath}
                        disabled={submitting}
                        onChange={(event) =>
                          updateMountRow(index, {
                            hostPath: event.target.value,
                            containerPath: row.containerPath,
                            mode: row.mode,
                          })
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("docker.placeholders.containerPath", "Container path")}
                        value={row.containerPath}
                        disabled={submitting}
                        onChange={(event) =>
                          updateMountRow(index, {
                            hostPath: row.hostPath,
                            containerPath: event.target.value,
                            mode: row.mode,
                          })
                        }
                      />
                      <select
                        className="select"
                        value={row.mode}
                        disabled={submitting}
                        onChange={(event) =>
                          updateMountRow(index, {
                            hostPath: row.hostPath,
                            containerPath: row.containerPath,
                            mode: event.target.value === "ro" ? "ro" : "rw",
                          })
                        }
                      >
                        <option value="rw">{DOCKER_MOUNT_MODE_LABELS.readWrite}</option>
                        <option value="ro">{DOCKER_MOUNT_MODE_LABELS.readOnly}</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={t("docker.ariaLabels.removeMount", "Remove volume mount")}
                        onClick={() => removeMountRow(index)}
                        disabled={submitting}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm docker-onboarding__kv-add"
                    onClick={addMountRow}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    {t("docker.actions.addMount", "Add mount")}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={closeModal} disabled={submitting}>
            {t("docker.actions.cancel", "Cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? t("docker.states.creating", "Creating...") : t("docker.actions.createNode", "Create Docker Node")}
          </button>
        </div>
      </div>
    </div>
  );
}

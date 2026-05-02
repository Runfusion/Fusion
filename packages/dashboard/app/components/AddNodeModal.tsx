import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToastType } from "../hooks/useToast";
import "./AddNodeModal.css";

export interface AddNodeInput {
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  maxConcurrent: number;
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
  addToast: (message: string, type?: ToastType) => void;
}

interface FormErrors {
  name?: string;
  url?: string;
  maxConcurrent?: string;
}

const MAX_CONCURRENT_MIN = 1;
const MAX_CONCURRENT_MAX = 10;

function validateInput(input: AddNodeInput): FormErrors {
  const errors: FormErrors = {};

  if (!input.name.trim()) {
    errors.name = "Name is required";
  }

  if (input.type === "remote" && !input.url?.trim()) {
    errors.url = "URL is required for remote nodes";
  }

  if (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent < MAX_CONCURRENT_MIN || input.maxConcurrent > MAX_CONCURRENT_MAX) {
    errors.maxConcurrent = `Concurrency must be between ${MAX_CONCURRENT_MIN} and ${MAX_CONCURRENT_MAX}`;
  }

  return errors;
}

export function AddNodeModal({ isOpen, onClose, onSubmit, addToast }: AddNodeModalProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "remote">("local");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [apiKeyMode, setApiKeyMode] = useState<"auto-generate" | "provide">("auto-generate");
  const [includeClaudeCli, setIncludeClaudeCli] = useState(false);
  const [includeDroidCli, setIncludeDroidCli] = useState(false);
  const [persistentStorage, setPersistentStorage] = useState(true);
  const [resourceCpus, setResourceCpus] = useState(2);
  const [resourceMemoryMb, setResourceMemoryMb] = useState(4096);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dockerHost, setDockerHost] = useState("");
  const [dockerContext, setDockerContext] = useState("");
  const [tlsVerify, setTlsVerify] = useState(false);
  const [advancedEnv, setAdvancedEnv] = useState("");
  const [advancedMounts, setAdvancedMounts] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setName("");
    setType("local");
    setUrl("");
    setApiKey("");
    setMaxConcurrent(2);
    setApiKeyMode("auto-generate");
    setIncludeClaudeCli(false);
    setIncludeDroidCli(false);
    setPersistentStorage(true);
    setResourceCpus(2);
    setResourceMemoryMb(4096);
    setShowAdvanced(false);
    setDockerHost("");
    setDockerContext("");
    setTlsVerify(false);
    setAdvancedEnv("");
    setAdvancedMounts("");
    setErrors({});
    setIsSubmitting(false);
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

  const input = useMemo<AddNodeInput>(() => {
    const parsedEnvOverrides = Object.fromEntries(
      advancedEnv
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          if (index <= 0) return [line, ""];
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
    );

    const parsedMounts = advancedMounts
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hostPath = "", containerPath = "", mode = "rw"] = line.split(":");
        return { hostPath, containerPath, mode: mode === "ro" ? "ro" : "rw" as "ro" | "rw" };
      })
      .filter((mount) => mount.hostPath && mount.containerPath);

    return {
      name: name.trim(),
      type,
      url: type === "remote" ? url.trim() || undefined : undefined,
      apiKey: type === "remote" && apiKeyMode === "provide" ? apiKey || undefined : undefined,
      maxConcurrent,
      apiKeyMode,
      extraClis: [includeClaudeCli ? "claude-cli" : null, includeDroidCli ? "droid-cli" : null].filter(Boolean) as Array<"claude-cli" | "droid-cli">,
      persistentStorage,
      resourceSizing: {
        cpus: Number.isFinite(resourceCpus) ? resourceCpus : undefined,
        memoryMB: Number.isFinite(resourceMemoryMb) ? resourceMemoryMb : undefined,
      },
      dockerAdvanced: showAdvanced
        ? {
          host: dockerHost.trim() || undefined,
          context: dockerContext.trim() || undefined,
          tlsVerify,
          envOverrides: parsedEnvOverrides,
          volumeMounts: parsedMounts,
        }
        : undefined,
    };
  }, [advancedEnv, advancedMounts, apiKey, apiKeyMode, dockerContext, dockerHost, includeClaudeCli, includeDroidCli, maxConcurrent, name, persistentStorage, resourceCpus, resourceMemoryMb, showAdvanced, tlsVerify, type, url]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const validationErrors = validateInput(input);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit(input);
      addToast(`Node "${input.name}" registered`, "success");
      closeModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to register node";
      addToast(message, "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [addToast, closeModal, input, isSubmitting, onSubmit]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={closeModal}>
      <div className="modal modal-md add-node-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add Node">
        <div className="modal-header">
          <h3>Add Node</h3>
          <button className="modal-close" onClick={closeModal} disabled={isSubmitting} aria-label="Close add node modal">
            &times;
          </button>
        </div>

        <div className="modal-body add-node-modal__body">
          <p className="add-node-modal__description">Provision a managed Docker node with guided defaults, then expand Advanced for host/TLS/env/mount overrides.</p>

          <label className="add-node-modal__field">
            <span>Name</span>
            <input
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Build Machine"
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
              Local
            </button>
            <button
              type="button"
              className={`add-node-modal__type-btn ${type === "remote" ? "active" : ""}`}
              data-type="remote"
              onClick={() => setType("remote")}
              disabled={isSubmitting}
              aria-pressed={type === "remote"}
            >
              Remote
            </button>
          </div>

          {type === "remote" && (
            <div className="add-node-modal__remote-fields" data-testid="remote-fields-container" data-visible>
              <label className="add-node-modal__field">
                <span>Reachable URL / Hostname</span>
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
                <span>API Key Mode</span>
                <select
                  className="select"
                  value={apiKeyMode}
                  onChange={(event) => setApiKeyMode(event.target.value as "auto-generate" | "provide")}
                  disabled={isSubmitting}
                >
                  <option value="auto-generate">Auto-generate</option>
                  <option value="provide">Provide key manually</option>
                </select>
              </label>

              {apiKeyMode === "provide" && (
                <label className="add-node-modal__field">
                  <span>API Key</span>
                  <input
                    className="input"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Enter node API key"
                    disabled={isSubmitting}
                  />
                </label>
              )}
            </div>
          )}

          <label className="add-node-modal__field">
            <span>Max Concurrent</span>
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
            <span className="add-node-modal__hint">Max simultaneous task agents (1–10)</span>
            {errors.maxConcurrent && <span className="form-error add-node-modal__error">{errors.maxConcurrent}</span>}
          </label>

          <div className="add-node-modal__row">
            <label className="add-node-modal__field">
              <span>CPU Limit</span>
              <input
                className="input"
                type="number"
                min={1}
                step={0.5}
                value={resourceCpus}
                onChange={(event) => setResourceCpus(Number(event.target.value))}
                disabled={isSubmitting}
              />
            </label>
            <label className="add-node-modal__field">
              <span>Memory (MB)</span>
              <input
                className="input"
                type="number"
                min={512}
                step={256}
                value={resourceMemoryMb}
                onChange={(event) => setResourceMemoryMb(Number(event.target.value))}
                disabled={isSubmitting}
              />
            </label>
          </div>

          <fieldset className="add-node-modal__fieldset">
            <legend>Optional CLI Tools</legend>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeClaudeCli}
                onChange={(event) => setIncludeClaudeCli(event.target.checked)}
                disabled={isSubmitting}
              />
              <span>Claude CLI</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeDroidCli}
                onChange={(event) => setIncludeDroidCli(event.target.checked)}
                disabled={isSubmitting}
              />
              <span>Droid CLI</span>
            </label>
          </fieldset>

          <label className="checkbox-label add-node-modal__storage-toggle">
            <input
              type="checkbox"
              checked={persistentStorage}
              onChange={(event) => setPersistentStorage(event.target.checked)}
              disabled={isSubmitting}
            />
            <span>Persistent storage (retain volumes on recreate/delete)</span>
          </label>

          <button type="button" className="btn btn-sm add-node-modal__advanced-btn" onClick={() => setShowAdvanced((current) => !current)}>
            {showAdvanced ? "Hide Advanced" : "Show Advanced"}
          </button>

          {showAdvanced && (
            <section className="add-node-modal__advanced" aria-label="Advanced Docker settings">
              <label className="add-node-modal__field">
                <span>Docker Host</span>
                <input className="input" value={dockerHost} onChange={(event) => setDockerHost(event.target.value)} placeholder="unix:///var/run/docker.sock" disabled={isSubmitting} />
              </label>
              <label className="add-node-modal__field">
                <span>Docker Context</span>
                <input className="input" value={dockerContext} onChange={(event) => setDockerContext(event.target.value)} placeholder="default" disabled={isSubmitting} />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={tlsVerify} onChange={(event) => setTlsVerify(event.target.checked)} disabled={isSubmitting} />
                <span>TLS verify Docker daemon</span>
              </label>
              <label className="add-node-modal__field">
                <span>Env Overrides (KEY=value per line)</span>
                <textarea className="input add-node-modal__textarea" value={advancedEnv} onChange={(event) => setAdvancedEnv(event.target.value)} placeholder={"FUSION_LOG_LEVEL=debug\nNODE_OPTIONS=--max-old-space-size=2048"} disabled={isSubmitting} />
              </label>
              <label className="add-node-modal__field">
                <span>Volume Mounts (host:container:mode per line)</span>
                <textarea className="input add-node-modal__textarea" value={advancedMounts} onChange={(event) => setAdvancedMounts(event.target.value)} placeholder={"/srv/fusion:/data:rw\n/var/log/fusion:/logs:ro"} disabled={isSubmitting} />
              </label>
            </section>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={closeModal} disabled={isSubmitting}>Cancel</button>
          <button className="btn btn-primary btn-sm" data-testid="add-node-submit" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? "Adding..." : "Add Node"}
          </button>
        </div>
      </div>
    </div>
  );
}

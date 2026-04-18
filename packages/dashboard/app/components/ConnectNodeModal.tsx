import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeCreateInput, NodeInfo } from "../api";

export interface ConnectNodeInput {
  name: string;
  url: string;
  apiKey?: string;
  maxConcurrent: number;
}

interface ConnectNodeModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: (node: NodeInfo) => void;
  addToast: (message: string, type?: "success" | "error") => void;
  /** Optional function to register the node (defaults to using fetch) */
  onSubmit?: (input: ConnectNodeInput) => Promise<NodeInfo>;
}

interface FormErrors {
  name?: string;
  host?: string;
  port?: string;
  maxConcurrent?: string;
}

const DEFAULT_PORT = 3001;
const MAX_CONCURRENT_MIN = 1;
const MAX_CONCURRENT_MAX = 10;

function validateInput(input: { name: string; host: string; port: string; maxConcurrent: number }): FormErrors {
  const errors: FormErrors = {};

  if (!input.name.trim()) {
    errors.name = "Node name is required";
  }

  if (!input.host.trim()) {
    errors.host = "Host / IP address is required";
  }

  const portNum = Number(input.port);
  if (input.port && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    errors.port = "Port must be between 1 and 65535";
  }

  if (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent < MAX_CONCURRENT_MIN || input.maxConcurrent > MAX_CONCURRENT_MAX) {
    errors.maxConcurrent = `Concurrency must be between ${MAX_CONCURRENT_MIN} and ${MAX_CONCURRENT_MAX}`;
  }

  return errors;
}

function buildUrl(host: string, port: string): string {
  const cleanHost = host.trim().replace(/^https?:\/\//, "").split("/")[0];
  const portNum = Number(port) || DEFAULT_PORT;
  return `http://${cleanHost}:${portNum}`;
}

export function ConnectNodeModal({ open, onClose, onConnected, addToast, onSubmit }: ConnectNodeModalProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [apiKey, setApiKey] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setName("");
    setHost("");
    setPort(String(DEFAULT_PORT));
    setApiKey("");
    setMaxConcurrent(2);
    setErrors({});
    setIsSubmitting(false);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  const constructedUrl = useMemo(() => {
    if (!host.trim()) return "";
    return buildUrl(host, port);
  }, [host, port]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const validationErrors = validateInput({ name, host, port, maxConcurrent });
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);

    const input: ConnectNodeInput = {
      name: name.trim(),
      url: constructedUrl,
      apiKey: apiKey.trim() || undefined,
      maxConcurrent,
    };

    try {
      let node: NodeInfo;

      if (onSubmit) {
        node = await onSubmit(input);
      } else {
        // Default: call the API directly
        const response = await fetch("/api/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            type: "remote",
            url: input.url,
            apiKey: input.apiKey,
            maxConcurrent: input.maxConcurrent,
          } satisfies NodeCreateInput),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: "Failed to connect" }));
          throw new Error(error.error || `HTTP ${response.status}`);
        }

        node = await response.json() as NodeInfo;
      }

      addToast(`Connected to "${node.name}"`, "success");
      onConnected(node);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect to node";
      addToast(message, "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [addToast, apiKey, constructedUrl, host, isSubmitting, maxConcurrent, name, onClose, onConnected, onSubmit, port]);

  if (!open) return null;

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div
        className="modal modal-md connect-node-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connect to Node"
      >
        <div className="modal-header">
          <h3>Connect to Node</h3>
          <button className="modal-close" onClick={onClose} disabled={isSubmitting} aria-label="Close connect node modal">
            &times;
          </button>
        </div>

        <div className="modal-body connect-node-form">
          <label className="connect-node-field">
            <span>Node Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Build Server"
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name && <span className="form-error">{errors.name}</span>}
          </label>

          <label className="connect-node-field">
            <span>Host / IP Address</span>
            <input
              type="text"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="192.0.2.10 or my-server.local"
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.host)}
            />
            {errors.host && <span className="form-error">{errors.host}</span>}
          </label>

          <label className="connect-node-field">
            <span>Port</span>
            <input
              type="number"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              min={1}
              max={65535}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.port)}
            />
            {errors.port && <span className="form-error">{errors.port}</span>}
          </label>

          {constructedUrl && (
            <div className="connect-node-url-preview">
              <span className="connect-node-url-preview-label">URL:</span>
              <code>{constructedUrl}</code>
            </div>
          )}

          <label className="connect-node-field">
            <span>Auth Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Optional"
              disabled={isSubmitting}
            />
          </label>

          <label className="connect-node-field">
            <span>Max Concurrent</span>
            <input
              type="number"
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              min={MAX_CONCURRENT_MIN}
              max={MAX_CONCURRENT_MAX}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.maxConcurrent)}
            />
            {errors.maxConcurrent && <span className="form-error">{errors.maxConcurrent}</span>}
          </label>
        </div>

        <div className="modal-actions connect-node-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={isSubmitting || !host.trim()}>
            {isSubmitting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

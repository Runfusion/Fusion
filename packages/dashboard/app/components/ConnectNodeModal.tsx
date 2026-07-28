import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { NodeCreateInput, NodeInfo } from "../api";

import { FloatingWindow } from "./FloatingWindow";
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

function validateInput(input: { name: string; host: string; port: string; maxConcurrent: number }, t: TFunction<"app">): FormErrors {
  const errors: FormErrors = {};

  if (!input.name.trim()) {
    errors.name = t("nodes.validation.nameRequired", "Node name is required");
  }

  if (!input.host.trim()) {
    errors.host = t("nodes.validation.hostRequired", "Host / IP address is required");
  }

  const portNum = Number(input.port);
  if (input.port && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    errors.port = t("nodes.validation.portRange", "Port must be between 1 and 65535");
  }

  if (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent < MAX_CONCURRENT_MIN || input.maxConcurrent > MAX_CONCURRENT_MAX) {
    errors.maxConcurrent = t("nodes.validation.concurrencyRange", `Concurrency must be between {{min}} and {{max}}`, { min: MAX_CONCURRENT_MIN, max: MAX_CONCURRENT_MAX });
  }

  return errors;
}

function buildUrl(host: string, port: string): string {
  const cleanHost = host.trim().replace(/^https?:\/\//, "").split("/")[0];
  const portNum = Number(port) || DEFAULT_PORT;
  return `http://${cleanHost}:${portNum}`;
}

export function ConnectNodeModal({ open, onClose, onConnected, addToast, onSubmit }: ConnectNodeModalProps) {
  const { t } = useTranslation("app");
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

    const validationErrors = validateInput({ name, host, port, maxConcurrent }, t);
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
          const error = await response.json().catch(() => ({ error: t("nodes.errors.connectFailed", "Failed to connect") }));
          throw new Error(error.error || `HTTP ${response.status}`);
        }

        node = await response.json() as NodeInfo;
      }

      addToast(t("nodes.success.connected", `Connected to "{{name}}"`, { name: node.name }), "success");
      onConnected(node);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("nodes.errors.connectToNode", "Failed to connect to node");
      addToast(message, "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [addToast, apiKey, constructedUrl, host, isSubmitting, maxConcurrent, name, onClose, onConnected, onSubmit, port, t]);

  if (!open) return null;

  return (
    /* FNXC:ModalTouchGeometry 2026-07-26-13:15: Shared FloatingWindow owns this modal's touch drag, resize, clamping, and persistence while phone and short viewports retain their sheet behavior. */
    <FloatingWindow windowKey="connect-node" title={t("nodes.modal.title", "Connect to Node")} ariaLabel={`${t("nodes.modal.title", "Connect to Node")} dialog`} onClose={onClose} hideHeader dragHandleSelector=".modal-header" className="floating-window--connect-node" defaultSize={{ width: 720, height: 560 }} minSize={{ width: 360, height: 280 }} persistGeometryKey="floating-window:connect-node" suspendGeometryPersistenceOnMobile suspendGeometryPersistenceOnShortViewport closeOnOutsidePointerDown>
      <div
        className="modal modal-md connect-node-modal"
        aria-label={t("nodes.modal.title", "Connect to Node")}
      >
        <div className="modal-header">
          <h3>{t("nodes.modal.title", "Connect to Node")}</h3>
          <button className="modal-close" onClick={onClose} disabled={isSubmitting} aria-label={t("nodes.modal.closeButton", "Close connect node modal")}>
            &times;
          </button>
        </div>

        <div className="modal-body connect-node-form">
          <div className="form-group connect-node-field">
            <label htmlFor="connect-node-name">{t("nodes.fields.name", "Node Name")}</label>
            <input
              id="connect-node-name"
              className="input connect-node-field__input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("nodes.placeholders.name", "Build Server")}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name && <span className="form-error">{errors.name}</span>}
          </div>

          <div className="form-group connect-node-field">
            <label htmlFor="connect-node-host">{t("nodes.fields.host", "Host / IP Address")}</label>
            <input
              id="connect-node-host"
              className="input connect-node-field__input"
              type="text"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder={t("nodes.placeholders.host", "192.0.2.10 or my-server.local")}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.host)}
            />
            {errors.host && <span className="form-error">{errors.host}</span>}
          </div>

          <div className="form-group connect-node-field">
            <label htmlFor="connect-node-port">{t("nodes.fields.port", "Port")}</label>
            <input
              id="connect-node-port"
              className="input connect-node-field__input"
              type="number"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              min={1}
              max={65535}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.port)}
            />
            {errors.port && <span className="form-error">{errors.port}</span>}
          </div>

          {constructedUrl && (
            <div className="connect-node-url-preview">
              <span className="connect-node-url-preview-label">{t("nodes.fields.url", "URL")}:</span>
              <code>{constructedUrl}</code>
            </div>
          )}

          <div className="form-group connect-node-field">
            <label htmlFor="connect-node-auth-key">{t("nodes.fields.authKey", "Auth Key")}</label>
            <input
              id="connect-node-auth-key"
              className="input connect-node-field__input"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("nodes.placeholders.optional", "Optional")}
              disabled={isSubmitting}
            />
          </div>

          <div className="form-group connect-node-field">
            <label htmlFor="connect-node-max-concurrent">{t("nodes.fields.maxConcurrent", "Max Concurrent")}</label>
            <input
              id="connect-node-max-concurrent"
              className="input connect-node-field__input"
              type="number"
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              min={MAX_CONCURRENT_MIN}
              max={MAX_CONCURRENT_MAX}
              disabled={isSubmitting}
              aria-invalid={Boolean(errors.maxConcurrent)}
            />
            {errors.maxConcurrent && <span className="form-error">{errors.maxConcurrent}</span>}
          </div>
        </div>

        <div className="modal-actions connect-node-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={isSubmitting}>
            {t("actions.cancel", "Cancel")}
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={isSubmitting || !host.trim()}>
            {isSubmitting ? t("nodes.actions.connecting", "Connecting...") : t("nodes.actions.connect", "Connect")}
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}

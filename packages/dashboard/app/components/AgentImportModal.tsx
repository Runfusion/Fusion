import { useState, useRef, useCallback } from "react";
import { Upload, FileText, CheckCircle, AlertTriangle, X, Loader2 } from "lucide-react";

export interface AgentImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
  projectId?: string;
}

/** Parsed agent preview item for display before import */
interface AgentPreview {
  name: string;
  role: string;
  icon?: string;
  title?: string;
  model?: string;
}

/** Import result from the API */
interface ImportResult {
  companyName: string;
  created: Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

/** API error response shape */
interface ApiErrorResponse {
  error: string;
}

type ModalStep = "input" | "preview" | "result";

/**
 * Modal for importing agents from a companies.sh manifest.
 *
 * Supports two input methods:
 * - File upload (.sh files)
 * - Paste raw manifest content
 *
 * Flow: Input → Preview parsed agents → Import → Show results
 */
export function AgentImportModal({ isOpen, onClose, onImported, projectId }: AgentImportModalProps) {
  const [step, setStep] = useState<ModalStep>("input");
  const [manifestContent, setManifestContent] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [agents, setAgents] = useState<AgentPreview[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep("input");
    setManifestContent("");
    setCompanyName("");
    setAgents([]);
    setIsParsing(false);
    setIsImporting(false);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setManifestContent(content);
      setParseError(null);
    };
    reader.onerror = () => {
      setParseError("Failed to read file");
    };
    reader.readAsText(file);

    // Reset file input so the same file can be re-selected
    e.target.value = "";
  }, []);

  /** Build the API URL with optional projectId */
  function buildUrl(path: string): string {
    if (!projectId) return `/api${path}`;
    const separator = path.includes("?") ? "&" : "?";
    return `/api${path}${separator}projectId=${encodeURIComponent(projectId)}`;
  }

  /** Parse the manifest content by calling the API with dryRun=true */
  const handleParse = useCallback(async () => {
    if (!manifestContent.trim()) {
      setParseError("Please provide manifest content");
      return;
    }

    setIsParsing(true);
    setParseError(null);

    try {
      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: manifestContent, dryRun: true }),
      });

      if (!res.ok) {
        const data = await res.json() as ApiErrorResponse;
        throw new Error(data.error ?? `Parse failed (${res.status})`);
      }

      const data = await res.json() as {
        companyName: string;
        created: string[];
        skipped: string[];
        errors: Array<{ name: string; error: string }>;
      };

      // Build agent previews from the created names in the dry-run result
      // We need to extract more info from the manifest for the preview
      let previewAgents: AgentPreview[] = [];
      try {
        // Parse the base64 manifest directly to get agent details for preview
        const manifestMatch = manifestContent.match(/AGENT_MANIFEST=["'](.*)["']/);
        if (manifestMatch) {
          const decoded = atob(manifestMatch[1]);
          const parsed = JSON.parse(decoded) as Array<Record<string, unknown>>;
          previewAgents = parsed.map((a) => ({
            name: String(a.name ?? ""),
            role: String(a.role ?? "custom"),
            icon: a.metadata && typeof a.metadata === "object"
              ? String((a.metadata as Record<string, unknown>).icon ?? "")
              : undefined,
            title: a.metadata && typeof a.metadata === "object"
              ? String((a.metadata as Record<string, unknown>).title ?? "")
              : undefined,
            model: a.config && typeof a.config === "object"
              ? String((a.config as Record<string, unknown>).model ?? "")
              : undefined,
          }));
        }
      } catch {
        // Fallback: just show names from dry-run result
        previewAgents = data.created.map((name) => ({ name, role: "custom" }));
      }

      setCompanyName(data.companyName);
      setAgents(previewAgents);
      setStep("preview");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Failed to parse manifest");
    } finally {
      setIsParsing(false);
    }
  }, [manifestContent, projectId]);

  /** Execute the actual import */
  const handleImport = useCallback(async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: manifestContent, skipExisting: true }),
      });

      if (!res.ok) {
        const data = await res.json() as ApiErrorResponse;
        throw new Error(data.error ?? `Import failed (${res.status})`);
      }

      const data = await res.json() as ImportResult;
      setImportResult(data);
      setStep("result");
      onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import agents");
    } finally {
      setIsImporting(false);
    }
  }, [manifestContent, projectId, onImported]);

  if (!isOpen) return null;

  return (
    <div className="agent-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="agent-dialog agent-import-dialog" role="dialog" aria-modal="true" aria-label="Import agents">
        {/* Header */}
        <div className="agent-dialog-header">
          <span className="agent-dialog-header-title">Import Agents</span>
          <button className="btn-icon" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {/* Step 1: Input */}
          {step === "input" && (
            <div className="agent-import-input">
              <p className="agent-import-description">
                Import agents from a companies.sh manifest file. Upload a <code>.sh</code> file or paste the manifest content directly.
              </p>

              {/* File upload */}
              <div className="agent-import-file-upload">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".sh,.txt"
                  onChange={handleFileChange}
                  className="agent-import-file-input"
                  aria-label="Upload companies.sh file"
                />
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                  Choose File
                </button>
                <span className="agent-import-file-hint">.sh files supported</span>
              </div>

              {/* Or divider */}
              <div className="agent-import-divider">
                <span>or paste manifest content</span>
              </div>

              {/* Text area for paste */}
              <textarea
                className="agent-import-textarea"
                placeholder={"#!/bin/bash\n# Agent Company Manifest\nCOMPANY_NAME=\"my-company\"\nAGENT_MANIFEST=\"base64...\""}
                value={manifestContent}
                onChange={(e) => { setManifestContent(e.target.value); setParseError(null); }}
                rows={8}
                aria-label="Manifest content"
              />

              {parseError && (
                <p className="agent-dialog-error">
                  <AlertTriangle size={14} />
                  {parseError}
                </p>
              )}
            </div>
          )}

          {/* Step 2: Preview */}
          {step === "preview" && (
            <div className="agent-import-preview">
              <div className="agent-import-company">
                <span className="agent-import-company-label">Company</span>
                <span className="agent-import-company-name">{companyName}</span>
              </div>

              <div className="agent-import-count">
                <FileText size={14} />
                <span>{agents.length} agent{agents.length !== 1 ? "s" : ""} found</span>
              </div>

              {agents.length > 0 ? (
                <div className="agent-import-agent-list">
                  {agents.map((agent, idx) => (
                    <div key={idx} className="agent-import-agent-item">
                      <span className="agent-import-agent-icon">
                        {agent.icon || "🤖"}
                      </span>
                      <div className="agent-import-agent-details">
                        <span className="agent-import-agent-name">{agent.name}</span>
                        <span className="agent-import-agent-meta">
                          {agent.title && <span className="agent-import-agent-title">{agent.title} · </span>}
                          <span className="agent-import-agent-role">{agent.role}</span>
                          {agent.model && <span className="agent-import-agent-model"> · {agent.model}</span>}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="agent-import-empty">No agents found in the manifest.</p>
              )}
            </div>
          )}

          {/* Step 3: Result */}
          {step === "result" && importResult && (
            <div className="agent-import-result">
              <div className="agent-import-result-icon">
                <CheckCircle size={32} />
              </div>
              <h3 className="agent-import-result-title">Import Complete</h3>
              <p className="agent-import-result-company">
                From <strong>{importResult.companyName}</strong>
              </p>

              <div className="agent-import-result-stats">
                {importResult.created.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--success">
                    <CheckCircle size={14} />
                    <span>{importResult.created.length} created</span>
                  </div>
                )}
                {importResult.skipped.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--skipped">
                    <span>○</span>
                    <span>{importResult.skipped.length} skipped (already exist)</span>
                  </div>
                )}
                {importResult.errors.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--error">
                    <AlertTriangle size={14} />
                    <span>{importResult.errors.length} error{importResult.errors.length !== 1 ? "s" : ""}</span>
                  </div>
                )}
              </div>

              {importResult.created.length > 0 && (
                <div className="agent-import-result-agents">
                  {importResult.created.map((a, idx) => (
                    <div key={idx} className="agent-import-result-agent">
                      <CheckCircle size={12} />
                      <span>{a.name}</span>
                    </div>
                  ))}
                </div>
              )}

              {importResult.errors.length > 0 && (
                <div className="agent-import-result-errors">
                  {importResult.errors.map((err, idx) => (
                    <div key={idx} className="agent-import-result-error">
                      <X size={12} />
                      <span>{err.name}: {err.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="agent-dialog-footer">
          {step === "preview" && (
            <button className="btn" onClick={() => setStep("input")} disabled={isImporting}>
              Back
            </button>
          )}
          <button className="btn" onClick={handleClose} disabled={isImporting}>
            {step === "result" ? "Close" : "Cancel"}
          </button>
          {step === "input" && (
            <button
              className="btn btn--primary"
              onClick={() => void handleParse()}
              disabled={isParsing || !manifestContent.trim()}
            >
              {isParsing ? (
                <>
                  <Loader2 size={14} className="spin" />
                  Parsing...
                </>
              ) : (
                "Preview"
              )}
            </button>
          )}
          {step === "preview" && (
            <button
              className="btn btn--primary"
              onClick={() => void handleImport()}
              disabled={isImporting || agents.length === 0}
            >
              {isImporting ? (
                <>
                  <Loader2 size={14} className="spin" />
                  Importing...
                </>
              ) : (
                `Import ${agents.length} Agent${agents.length !== 1 ? "s" : ""}`
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

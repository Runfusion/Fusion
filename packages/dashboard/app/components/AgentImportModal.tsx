import { useState, useRef, useCallback } from "react";
import { Upload, FileText, CheckCircle, AlertTriangle, X, Loader2, FolderOpen } from "lucide-react";

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
  title?: string;
  icon?: string;
  reportsTo?: string;
  instructionsText?: string;
  skills?: string[];
}

/** Import result from the API */
interface ImportResult {
  companyName?: string;
  companySlug?: string;
  created: Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

interface DirectoryAgentInput {
  name: string;
  title?: string;
  icon?: string;
  role?: string;
  reportsTo?: string;
  skills?: string[];
  instructionBody?: string;
}

/** API error response shape */
interface ApiErrorResponse {
  error: string;
}

type ModalStep = "input" | "preview" | "result";
type InputMethod = "paste" | "file" | "directory";

function parseDirectoryAgentManifest(content: string): DirectoryAgentInput {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error("Missing YAML frontmatter delimiters (---)");
  }

  const frontmatterLines = match[1].split(/\r?\n/);
  const body = match[2] ?? "";
  const result: DirectoryAgentInput = { name: "" };
  const skills: string[] = [];
  let inSkills = false;

  for (const rawLine of frontmatterLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("skills:")) {
      inSkills = true;
      continue;
    }

    if (inSkills && trimmed.startsWith("- ")) {
      skills.push(trimmed.slice(2).trim());
      continue;
    }

    inSkills = false;

    const [key, ...valueParts] = trimmed.split(":");
    const value = valueParts.join(":").trim();
    const normalizedValue = value.replace(/^['"]|['"]$/g, "");

    if (key === "name") result.name = normalizedValue;
    if (key === "title") result.title = normalizedValue;
    if (key === "icon") result.icon = normalizedValue;
    if (key === "role") result.role = normalizedValue;
    if (key === "reportsTo") result.reportsTo = normalizedValue;
  }

  if (!result.name) {
    throw new Error("Missing required field: name");
  }

  if (skills.length > 0) {
    result.skills = skills;
  }
  if (body.trim().length > 0) {
    result.instructionBody = body;
  }

  return result;
}

/**
 * Modal for importing agents from Agent Companies manifests.
 *
 * Supports three input methods:
 * - File upload (.md/.txt files)
 * - Directory upload (webkitdirectory)
 * - Paste raw manifest content
 *
 * Flow: Input → Preview parsed agents → Import → Show results
 */
export function AgentImportModal({ isOpen, onClose, onImported, projectId }: AgentImportModalProps) {
  const [step, setStep] = useState<ModalStep>("input");
  const [inputMethod, setInputMethod] = useState<InputMethod>("paste");
  const [manifestContent, setManifestContent] = useState("");
  const [directoryAgents, setDirectoryAgents] = useState<DirectoryAgentInput[]>([]);
  const [companyName, setCompanyName] = useState("Unknown");
  const [agents, setAgents] = useState<AgentPreview[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep("input");
    setInputMethod("paste");
    setManifestContent("");
    setDirectoryAgents([]);
    setCompanyName("Unknown");
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
      setInputMethod("file");
      setDirectoryAgents([]);
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

  const handleDirectoryChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    try {
      const agentFiles = files
        .filter((file) => (file.webkitRelativePath || file.name).toLowerCase().endsWith("agents.md"))
        .sort((a, b) => {
          const aPath = a.webkitRelativePath || a.name;
          const bPath = b.webkitRelativePath || b.name;
          return aPath.localeCompare(bPath);
        });

      if (agentFiles.length === 0) {
        setParseError("Selected directory has no AGENTS.md files");
        return;
      }

      const parsedAgents: DirectoryAgentInput[] = [];
      for (const file of agentFiles) {
        const content = await file.text();
        parsedAgents.push(parseDirectoryAgentManifest(content));
      }

      setInputMethod("directory");
      setDirectoryAgents(parsedAgents);
      setManifestContent("");
      setParseError(null);
    } catch {
      setParseError("Failed to parse AGENTS.md files from selected directory");
    } finally {
      e.target.value = "";
    }
  }, []);

  /** Build the API URL with optional projectId */
  function buildUrl(path: string): string {
    if (!projectId) return `/api${path}`;
    const separator = path.includes("?") ? "&" : "?";
    return `/api${path}${separator}projectId=${encodeURIComponent(projectId)}`;
  }

  /** Parse the manifest content by calling the API with dryRun=true */
  const handleParse = useCallback(async () => {
    if (inputMethod === "directory" && directoryAgents.length === 0) {
      setParseError("Please select a directory containing AGENTS.md files");
      return;
    }
    if (inputMethod !== "directory" && !manifestContent.trim()) {
      setParseError("Please provide manifest content");
      return;
    }

    setIsParsing(true);
    setParseError(null);

    try {
      const body = inputMethod === "directory"
        ? { agents: directoryAgents, dryRun: true }
        : { manifest: manifestContent, dryRun: true };

      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as ApiErrorResponse;
        throw new Error(data.error ?? `Parse failed (${res.status})`);
      }

      const data = await res.json() as {
        companyName?: string;
        agents?: AgentPreview[];
        created: string[];
        skipped: string[];
        errors: Array<{ name: string; error: string }>;
      };

      const previewAgents = (data.agents && data.agents.length > 0)
        ? data.agents
        : data.created.map((name) => ({ name, role: "custom" }));

      setCompanyName(data.companyName ?? "Unknown");
      setAgents(previewAgents);
      setStep("preview");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Failed to parse manifest");
    } finally {
      setIsParsing(false);
    }
  }, [inputMethod, directoryAgents, manifestContent, projectId]);

  /** Execute the actual import */
  const handleImport = useCallback(async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      const body = inputMethod === "directory"
        ? { agents: directoryAgents, skipExisting: true }
        : { manifest: manifestContent, skipExisting: true };

      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
  }, [inputMethod, directoryAgents, manifestContent, projectId, onImported]);

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
                Import agents from an Agent Companies package. Upload an AGENTS.md file, select a directory, or paste manifest content.
              </p>

              {/* File upload */}
              <div className="agent-import-file-upload">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  onChange={handleFileChange}
                  className="agent-import-file-input"
                  aria-label="Upload agent manifest file"
                />
                <input
                  ref={directoryInputRef}
                  type="file"
                  // @ts-expect-error webkitdirectory is non-standard but supported by Chromium browsers
                  webkitdirectory=""
                  multiple
                  onChange={handleDirectoryChange}
                  className="agent-import-file-input"
                  aria-label="Select directory"
                />
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                  Choose File
                </button>
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => directoryInputRef.current?.click()}
                >
                  <FolderOpen size={16} />
                  Select Directory
                </button>
                <span className="agent-import-file-hint">.md and .txt files supported</span>
              </div>

              {/* Or divider */}
              <div className="agent-import-divider">
                <span>or paste manifest content</span>
              </div>

              {/* Text area for paste */}
              <textarea
                className="agent-import-textarea"
                placeholder={"---\nname: CEO\ntitle: Chief Executive Officer\nreportsTo: null\nskills:\n  - review\n---\nAgent instructions go here..."}
                value={manifestContent}
                onChange={(e) => {
                  setInputMethod("paste");
                  setDirectoryAgents([]);
                  setManifestContent(e.target.value);
                  setParseError(null);
                }}
                rows={8}
                aria-label="Manifest content"
              />

              <p className="agent-import-file-hint">Current input: {inputMethod}</p>

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
                      <span className="agent-import-agent-icon">{agent.icon || "🤖"}</span>
                      <div className="agent-import-agent-details">
                        <span className="agent-import-agent-name">{agent.name}</span>
                        <span className="agent-import-agent-meta">
                          {agent.title && <span className="agent-import-agent-title">{agent.title} · </span>}
                          <span className="agent-import-agent-role">{agent.role}</span>
                          {agent.reportsTo && (
                            <span className="agent-import-agent-reports"> · reports to {agent.reportsTo}</span>
                          )}
                          {agent.skills && agent.skills.length > 0 && (
                            <span className="agent-import-agent-model"> · skills: {agent.skills.join(", ")}</span>
                          )}
                        </span>
                        {agent.instructionsText && (
                          <span className="agent-import-agent-instructions">
                            {agent.instructionsText.slice(0, 100)}{agent.instructionsText.length > 100 ? "..." : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="agent-import-empty">No agents found in the manifest.</p>
              )}

              {importError && (
                <p className="agent-dialog-error">
                  <AlertTriangle size={14} />
                  {importError}
                </p>
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
                From <strong>{importResult.companyName ?? "Unknown"}</strong>
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
              disabled={isParsing || (inputMethod === "directory" ? directoryAgents.length === 0 : !manifestContent.trim())}
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

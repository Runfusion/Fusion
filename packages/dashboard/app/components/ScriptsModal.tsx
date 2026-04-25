import "./ScriptsModal.css";
import { useState, useEffect, useCallback } from "react";
import { getErrorMessage } from "@fusion/core";
import { fetchScripts, addScript, removeScript, type ScriptEntry } from "../api";
import type { ToastType } from "../hooks/useToast";
import {
  X,
  Plus,
  Play,
  Trash2,
  Terminal,
  Loader2,
} from "lucide-react";

interface ScriptsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /** Callback when user wants to run a script - opens terminal modal */
  onRunScript?: (name: string, command: string) => void;
}

interface ScriptFormData {
  name: string;
  command: string;
}

const EMPTY_FORM: ScriptFormData = {
  name: "",
  command: "",
};

/** Validate script name: alphanumeric, hyphens, underscores only */
function isValidScriptName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/** Truncate command for display */
function truncateCommand(command: string, maxLength: number = 60): string {
  if (command.length <= maxLength) return command;
  return command.slice(0, maxLength - 3) + "...";
}

export function ScriptsModal({ isOpen, onClose, addToast, projectId, onRunScript }: ScriptsModalProps) {
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ScriptFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const loadScripts = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchScripts(projectId);
      setScripts(data);
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to load scripts", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId]);

  useEffect(() => {
    if (isOpen) {
      loadScripts();
    }
  }, [isOpen, loadScripts]);

  const handleCreate = useCallback(() => {
    setIsCreating(true);
    setIsEditing(null);
    setForm(EMPTY_FORM);
    setNameError(null);
  }, []);

  const handleEdit = useCallback((name: string, command: string) => {
    setIsEditing(name);
    setIsCreating(false);
    setForm({ name, command });
    setNameError(null);
  }, []);

  const handleCancel = useCallback(() => {
    setIsEditing(null);
    setIsCreating(false);
    setForm(EMPTY_FORM);
    setNameError(null);
  }, []);

  const handleNameChange = useCallback((name: string) => {
    setForm((prev) => ({ ...prev, name }));
    if (name && !isValidScriptName(name)) {
      setNameError("Name must contain only letters, numbers, hyphens, and underscores (no spaces)");
    } else {
      setNameError(null);
    }
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedName = form.name.trim();
    const trimmedCommand = form.command.trim();

    if (!trimmedName) {
      addToast("Script name is required", "error");
      return;
    }

    if (!isValidScriptName(trimmedName)) {
      addToast("Script name must contain only letters, numbers, hyphens, and underscores (no spaces)", "error");
      return;
    }

    if (!trimmedCommand) {
      addToast("Script command is required", "error");
      return;
    }

    setSaving(true);
    try {
      await addScript(trimmedName, trimmedCommand, projectId);
      addToast(isEditing ? "Script updated" : "Script created", "success");
      setIsEditing(null);
      setIsCreating(false);
      setForm(EMPTY_FORM);
      setNameError(null);
      await loadScripts();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg?.includes("already exists")) {
        addToast("A script with this name already exists", "error");
      } else {
        addToast(msg || "Failed to save script", "error");
      }
    } finally {
      setSaving(false);
    }
  }, [form, isEditing, addToast, loadScripts, projectId]);

  const handleDelete = useCallback(async (name: string) => {
    try {
      await removeScript(name, projectId);
      addToast("Script deleted", "success");
      setDeleteConfirmName(null);
      if (isEditing === name) {
        setIsEditing(null);
        setForm(EMPTY_FORM);
      }
      await loadScripts();
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to delete script", "error");
    }
  }, [isEditing, addToast, loadScripts, projectId]);

  const handleRun = useCallback((name: string, command: string) => {
    if (onRunScript) {
      onRunScript(name, command);
    }
  }, [onRunScript]);

  if (!isOpen) return null;

  const isEditingAny = isCreating || isEditing !== null;
  const scriptEntries: ScriptEntry[] = Object.entries(scripts).map(([name, command]) => ({
    name,
    command,
  }));

  return (
    <div className="modal-overlay open" onClick={onClose} data-testid="scripts-modal">
      <div
        className="modal scripts-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Scripts"
      >
        {/* Header */}
        <div className="modal-header">
          <h2>
            <Terminal size={18} style={{ marginRight: "8px", verticalAlign: "middle" }} />
            Scripts
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-body scripts-modal-body">
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
              <Loader2 size={24} className="spin" style={{ margin: "0 auto 8px", display: "block" }} />
              Loading scripts...
            </div>
          ) : isEditingAny ? (
            /* Form for create/edit */
            <div className="scripts-modal-form" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <label
                  htmlFor="script-name"
                  style={{
                    display: "block",
                    marginBottom: "4px",
                    fontSize: "13px",
                    fontWeight: 500,
                    color: "var(--text)",
                  }}
                >
                  Script Name
                </label>
                <input
                  id="script-name"
                  type="text"
                  className="input"
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="e.g., build, test, lint"
                  disabled={saving || isEditing !== null}
                  data-testid="script-name-input"
                  style={{
                    width: "100%",
                    borderColor: nameError ? "var(--color-error)" : undefined,
                  }}
                />
                {nameError && (
                  <div
                    style={{
                      fontSize: "12px",
                      color: "var(--color-error)",
                      marginTop: "4px",
                    }}
                    data-testid="script-name-error"
                  >
                    {nameError}
                  </div>
                )}
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--text-muted)",
                    marginTop: "4px",
                  }}
                >
                  Letters, numbers, hyphens, and underscores only
                </div>
              </div>

              <div>
                <label
                  htmlFor="script-command"
                  style={{
                    display: "block",
                    marginBottom: "4px",
                    fontSize: "13px",
                    fontWeight: 500,
                    color: "var(--text)",
                  }}
                >
                  Command
                </label>
                <textarea
                  id="script-command"
                  className="input"
                  value={form.command}
                  onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder="e.g., npm run build"
                  rows={3}
                  disabled={saving}
                  data-testid="script-command-input"
                  style={{
                    width: "100%",
                    resize: "vertical",
                    fontFamily: "monospace",
                  }}
                />
              </div>

              <div className="scripts-modal-form-actions" style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleCancel}
                  disabled={saving}
                  data-testid="script-cancel-btn"
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !!nameError}
                  data-testid="script-save-btn"
                >
                  {saving ? (
                    <>
                      <Loader2 size={14} className="spin" style={{ marginRight: "6px" }} />
                      Saving...
                    </>
                  ) : isEditing ? (
                    "Update"
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </div>
          ) : (
            /* List view */
            <>
              <div
                className="scripts-modal-list-header"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "16px",
                }}
              >
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                  {scriptEntries.length === 0
                    ? "No scripts defined"
                    : `${scriptEntries.length} script${scriptEntries.length === 1 ? "" : "s"}`}
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleCreate}
                  data-testid="add-script-btn"
                  style={{ display: "flex", alignItems: "center", gap: "6px" }}
                >
                  <Plus size={14} />
                  Add Script
                </button>
              </div>

              {scriptEntries.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "32px",
                    color: "var(--text-muted)",
                    fontSize: "14px",
                    border: "1px dashed var(--border)",
                    borderRadius: "8px",
                  }}
                  data-testid="empty-state"
                >
                  <Terminal size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
                  <div>No scripts defined yet.</div>
                  <div style={{ marginTop: "4px", fontSize: "12px" }}>
                    Add scripts to quickly run common commands from the dashboard.
                  </div>
                </div>
              ) : (
                <div className="scripts-modal-list" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {scriptEntries.map((script) => (
                    <div
                      key={script.name}
                      className="script-card"
                      data-testid={`script-${script.name}`}
                      style={{
                        padding: "12px 16px",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        background: "var(--card)",
                      }}
                    >
                      <div
                        className="script-card-header"
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "4px",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 600,
                                fontSize: "14px",
                                fontFamily: "monospace",
                              }}
                            >
                              {script.name}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "var(--text-muted)",
                              fontFamily: "monospace",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={script.command}
                          >
                            {truncateCommand(script.command)}
                          </div>
                        </div>
                        <div
                          className="script-card-actions"
                          style={{
                            display: "flex",
                            gap: "4px",
                            marginLeft: "8px",
                            flexShrink: 0,
                          }}
                        >
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleRun(script.name, script.command)}
                            title="Run script"
                            aria-label={`Run ${script.name}`}
                            data-testid={`run-script-${script.name}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "4px 10px",
                              fontSize: "12px",
                            }}
                          >
                            <Play size={12} />
                            Run
                          </button>
                          <button
                            className="btn-icon"
                            onClick={() => handleEdit(script.name, script.command)}
                            title="Edit"
                            aria-label={`Edit ${script.name}`}
                            data-testid={`edit-script-${script.name}`}
                          >
                            <Plus size={14} style={{ transform: "rotate(45deg)" }} />
                          </button>
                          {deleteConfirmName === script.name ? (
                            <div className="script-delete-confirm" style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                              <button
                                className="btn-icon"
                                onClick={() => handleDelete(script.name)}
                                title="Confirm delete"
                                aria-label={`Confirm delete ${script.name}`}
                                data-testid={`confirm-delete-script-${script.name}`}
                                style={{ color: "var(--color-error)" }}
                              >
                                <Trash2 size={14} />
                              </button>
                              <button
                                className="btn-icon"
                                onClick={() => setDeleteConfirmName(null)}
                                title="Cancel delete"
                                aria-label="Cancel delete"
                                data-testid={`cancel-delete-script-${script.name}`}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <button
                              className="btn-icon"
                              onClick={() => setDeleteConfirmName(script.name)}
                              title="Delete"
                              aria-label={`Delete ${script.name}`}
                              data-testid={`delete-script-${script.name}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { FileText, ChevronDown, ChevronUp, Plus, Trash2, History } from "lucide-react";
import "./TaskDocumentsTab.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDocument, TaskDocumentRevision } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import {
  fetchTaskDocuments,
  fetchTaskDocumentRevisions,
  putTaskDocument,
  deleteTaskDocument,
} from "../api";

// Document key validation: alphanumeric, hyphens, underscores, 1-64 chars
const DOCUMENT_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONTENT_PREVIEW = 200;

interface TaskDocumentsTabProps {
  taskId: string;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
  projectId?: string;
  canEdit?: boolean;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function getContentPreview(content: string, maxLength: number = MAX_CONTENT_PREVIEW): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + "…";
}

export function TaskDocumentsTab({
  taskId,
  addToast,
  onTaskUpdated: _onTaskUpdated,
  projectId,
  canEdit = false,
}: TaskDocumentsTabProps) {
  const [documents, setDocuments] = useState<TaskDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDocKey, setExpandedDocKey] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState("");
  const [editingDocKey, setEditingDocKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<TaskDocumentRevision[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDocKey, setNewDocKey] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(false);

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await fetchTaskDocuments(taskId, projectId);
      setDocuments(docs);
    } catch (error) {
      addToast(getErrorMessage(error) || "Failed to load documents", "error");
    } finally {
      setLoading(false);
    }
  }, [taskId, projectId, addToast]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  async function handleExpandDocument(doc: TaskDocument) {
    if (expandedDocKey === doc.key) {
      setExpandedDocKey(null);
      setExpandedContent("");
      setEditingDocKey(null);
      setEditContent("");
      setShowHistory(null);
      setRevisions([]);
      setRenderMarkdown(false);
    } else {
      setExpandedDocKey(doc.key);
      setExpandedContent(doc.content);
      setEditingDocKey(null);
      setEditContent("");
      setShowHistory(null);
      setRevisions([]);
      setRenderMarkdown(false);
    }
  }

  async function handleToggleHistory(docKey: string) {
    if (showHistory === docKey) {
      setShowHistory(null);
      setRevisions([]);
    } else {
      setShowHistory(docKey);
      setLoadingRevisions(true);
      try {
        const revs = await fetchTaskDocumentRevisions(taskId, docKey, projectId);
        setRevisions(revs);
      } catch (error) {
        addToast(getErrorMessage(error) || "Failed to load revisions", "error");
      } finally {
        setLoadingRevisions(false);
      }
    }
  }

  function handleStartEdit() {
    if (expandedDocKey) {
      setEditingDocKey(expandedDocKey);
      setEditContent(expandedContent);
    }
  }

  function handleCancelEdit() {
    setEditingDocKey(null);
    setEditContent("");
  }

  async function handleSaveEdit() {
    if (!editingDocKey || !editContent.trim()) return;
    setSaving(true);
    try {
      await putTaskDocument(taskId, editingDocKey, editContent, {}, projectId);
      setEditingDocKey(null);
      setEditContent("");
      await loadDocuments();
      // Refresh expanded content
      const updated = documents.find((d) => d.key === editingDocKey);
      if (updated) {
        setExpandedContent(updated.content);
      }
      addToast("Document saved", "success");
    } catch (error) {
      addToast(getErrorMessage(error) || "Failed to save document", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDocument() {
    const key = newDocKey.trim();
    const content = newDocContent.trim();

    // Validate key
    if (!key) {
      addToast("Document key is required", "error");
      return;
    }
    if (!DOCUMENT_KEY_REGEX.test(key)) {
      addToast("Invalid key format. Use 1-64 alphanumeric characters, hyphens, or underscores.", "error");
      return;
    }
    if (!content) {
      addToast("Content is required", "error");
      return;
    }

    setSaving(true);
    try {
      await putTaskDocument(taskId, key, content, {}, projectId);
      setShowCreateForm(false);
      setNewDocKey("");
      setNewDocContent("");
      await loadDocuments();
      addToast("Document created", "success");
    } catch (error) {
      addToast(getErrorMessage(error) || "Failed to create document", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDocument(key: string) {
    setDeletingKey(key);
    try {
      await deleteTaskDocument(taskId, key, projectId);
      setConfirmDelete(null);
      setDeletingKey(null);
      if (expandedDocKey === key) {
        setExpandedDocKey(null);
        setExpandedContent("");
      }
      if (showHistory === key) {
        setShowHistory(null);
        setRevisions([]);
      }
      await loadDocuments();
      addToast("Document deleted", "success");
    } catch (error) {
      addToast(getErrorMessage(error) || "Failed to delete document", "error");
    } finally {
      setDeletingKey(null);
    }
  }

  function handleViewRevision(revision: TaskDocumentRevision) {
    setExpandedContent(revision.content);
    setEditingDocKey(null);
    setEditContent("");
  }

  if (loading) {
    return (
      <div className="detail-section">
        <h4>Documents</h4>
        <div className="detail-log-empty">Loading documents…</div>
      </div>
    );
  }

  return (
    <div className="detail-section">
      <h4>Documents</h4>

      {/* Create Form */}
      {showCreateForm && (
        <div className="task-document-create-form">
          <h5>New Document</h5>
          <div className="form-group">
            <label htmlFor="doc-key">Key</label>
            <input
              id="doc-key"
              type="text"
              className="task-document-key-input"
              value={newDocKey}
              onChange={(e) => setNewDocKey(e.target.value)}
              placeholder="e.g., plan, notes, research"
              disabled={saving}
            />
            <span className="form-hint">Alphanumeric, hyphens, underscores (1-64 chars)</span>
          </div>
          <div className="form-group">
            <label htmlFor="doc-content">Content</label>
            <textarea
              id="doc-content"
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              rows={6}
              placeholder="Enter document content…"
              disabled={saving}
            />
          </div>
          <div className="form-actions">
            <button
              className="btn btn-sm"
              onClick={() => {
                setShowCreateForm(false);
                setNewDocKey("");
                setNewDocContent("");
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleCreateDocument()}
              disabled={saving || !newDocKey.trim() || !newDocContent.trim()}
            >
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}

      {/* Document List */}
      {documents.length === 0 && !showCreateForm ? (
        <div className="detail-log-empty">
          No documents yet.
        </div>
      ) : (
        <div className="task-documents-list">
          {documents.map((doc) => (
            <div key={doc.key} className="task-document-card">
              <div className="task-document-card-header">
                <div className="task-document-card-title">
                  <FileText size={14} />
                  <span className="task-document-key">{doc.key}</span>
                  <span className="task-document-revision-badge">v{doc.revision}</span>
                </div>
                <div className="task-document-meta">
                  <span className="task-document-author">{doc.author}</span>
                  <span className="task-document-timestamp">{formatTimestamp(doc.updatedAt || doc.createdAt)}</span>
                </div>
              </div>

              {/* Expanded Content View */}
              {expandedDocKey === doc.key && editingDocKey !== doc.key && (
                <>
                  <div className="task-document-content-header">
                    <button
                      className="btn btn-sm document-mode-toggle"
                      onClick={() => setRenderMarkdown((prev) => !prev)}
                      aria-label={renderMarkdown ? "Switch to plain text" : "Switch to markdown"}
                      aria-pressed={renderMarkdown}
                      title={renderMarkdown ? "Switch to plain text" : "Switch to markdown"}
                    >
                      {renderMarkdown ? "Markdown" : "Plain"}
                    </button>
                  </div>
                  <div className="task-document-content">
                    {renderMarkdown ? (
                      <div className="task-document-content-markdown">
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{expandedContent}</ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <pre className="task-document-content-text">{expandedContent}</pre>
                    )}
                  </div>

                  {/* Revision History */}
                  {showHistory === doc.key && (
                    <div className="task-document-revisions">
                      <h5>Revision History</h5>
                      {loadingRevisions ? (
                        <div className="detail-log-empty">Loading…</div>
                      ) : revisions.length <= 1 ? (
                        <div className="detail-log-empty">No previous revisions.</div>
                      ) : (
                        <div className="task-document-revision-list">
                          {revisions
                            .filter((r) => r.revision < doc.revision)
                            .sort((a, b) => b.revision - a.revision)
                            .map((revision) => (
                              <div
                                key={revision.id}
                                className="task-document-revision-item"
                                onClick={() => handleViewRevision(revision)}
                              >
                                <div className="revision-header">
                                  <span className="revision-badge">v{revision.revision}</span>
                                  <span className="revision-author">{revision.author}</span>
                                  <span className="revision-timestamp">{formatTimestamp(revision.createdAt)}</span>
                                </div>
                                <div className="revision-preview">{getContentPreview(revision.content, 100)}</div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Editing View */}
              {editingDocKey === doc.key && (
                <div className="task-document-edit-form">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={10}
                    disabled={saving}
                  />
                  <div className="form-actions">
                    <button className="btn btn-sm" onClick={handleCancelEdit} disabled={saving}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleSaveEdit()}
                      disabled={saving || !editContent.trim()}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="task-document-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => void handleExpandDocument(doc)}
                >
                  {expandedDocKey === doc.key ? (
                    <>
                      <ChevronUp size={14} /> Collapse
                    </>
                  ) : (
                    <>
                      <ChevronDown size={14} /> Expand
                    </>
                  )}
                </button>

                {expandedDocKey === doc.key && (
                  <>
                    <button
                      className="btn btn-sm"
                      onClick={() => void handleToggleHistory(doc.key)}
                    >
                      <History size={14} /> History
                    </button>

                    {canEdit && editingDocKey !== doc.key && (
                      <button className="btn btn-sm" onClick={handleStartEdit}>
                        Edit
                      </button>
                    )}

                    {canEdit && (
                      confirmDelete === doc.key ? (
                        <div className="confirm-delete-actions">
                          <span>Delete?</span>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void handleDeleteDocument(doc.key)}
                            disabled={deletingKey === doc.key}
                          >
                            {deletingKey === doc.key ? "…" : "Yes"}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => setConfirmDelete(null)}
                            disabled={deletingKey === doc.key}
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmDelete(doc.key)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Document Button */}
      {canEdit && !showCreateForm && (
        <button
          className="btn btn-sm task-document-new-btn"
          onClick={() => setShowCreateForm(true)}
        >
          <Plus size={14} /> New Document
        </button>
      )}
    </div>
  );
}
